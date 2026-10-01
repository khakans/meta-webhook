import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, Prisma } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'undici';
import { PrismaService } from '../database/prisma.service.js';
import { config } from '../utils/config.js';
import { decrypt, hmacHex } from '../utils/crypto.js';
import { UrlPolicyService } from '../utils/url-policy.js';

type ClaimedDelivery = Prisma.DeliveryGetPayload<{
  include: { event: true; destination: true };
}>;

function retryDelayMs(attempt: number) {
  const base = Math.min(3_600_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.min(base / 4, 10_000));
}

function cleanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

@Injectable()
export class DeliveryWorkerService {
  private readonly logger = new Logger(DeliveryWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly urlPolicy: UrlPolicyService,
  ) {}

  async run(signal: AbortSignal) {
    this.logger.log('Delivery worker started');
    while (!signal.aborted) {
      const processed = await this.processPendingOnce();
      if (processed === 0) {
        try {
          await delay(config.workerPollMs(), undefined, { signal });
        } catch {
          break;
        }
      }
    }
  }

  async processPendingOnce() {
    const deliveries = await this.claimBatch();
    await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
    return deliveries.length;
  }

  private claimBatch() {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Delivery"
        WHERE (
          ("status" IN ('PENDING', 'RETRY') AND "nextAttemptAt" <= CURRENT_TIMESTAMP)
          OR ("status" = 'PROCESSING' AND "lockedAt" < CURRENT_TIMESTAMP - interval '60 seconds')
        )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${config.workerBatchSize()}
      `);
      const ids = rows.map((row) => row.id);
      if (!ids.length) return [];
      await tx.delivery.updateMany({
        where: { id: { in: ids } },
        data: {
          status: DeliveryStatus.PROCESSING,
          lockedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      return tx.delivery.findMany({
        where: { id: { in: ids } },
        include: { event: true, destination: true },
      });
    });
  }

  private async deliver(delivery: ClaimedDelivery) {
    const { destination, event } = delivery;
    if (!destination.isActive) {
      await this.finish(
        delivery.id,
        DeliveryStatus.CANCELLED,
        null,
        'Destination is inactive',
      );
      return;
    }
    if (destination.type !== event.provider) {
      await this.finish(
        delivery.id,
        DeliveryStatus.CANCELLED,
        null,
        'Destination type does not match event provider',
      );
      return;
    }
    try {
      const url = await this.urlPolicy.assertSafe(destination.url);
      const customHeaders = destination.headersEncrypted
        ? (JSON.parse(decrypt(destination.headersEncrypted)) as Record<
            string,
            string
          >)
        : {};
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = destination.signingSecretEncrypted
        ? hmacHex(
            decrypt(destination.signingSecretEncrypted),
            `${timestamp}.${event.rawBody}`,
          )
        : null;
      const headers: Record<string, string> = {
        ...customHeaders,
        'content-type': 'application/json',
        'user-agent': 'webhook-gateway/1.0',
        'x-webhook-provider': event.provider.toLowerCase(),
        'x-webhook-event-id': event.id,
        'x-webhook-delivery-id': delivery.id,
        'x-webhook-timestamp': timestamp,
        ...(signature ? { 'x-webhook-signature': `v1=${signature}` } : {}),
      };
      const response = await request(url, {
        method: 'POST',
        headers,
        body: event.rawBody,
        headersTimeout: destination.timeoutMs,
        bodyTimeout: destination.timeoutMs,
        signal: AbortSignal.timeout(destination.timeoutMs),
      });
      try {
        await response.body.dump({ limit: 65_536 });
      } catch {
        response.body.destroy();
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await this.prisma.delivery.update({
          where: { id: delivery.id },
          data: {
            status: DeliveryStatus.DELIVERED,
            deliveredAt: new Date(),
            lockedAt: null,
            lastStatusCode: response.statusCode,
            lastError: null,
          },
        });
        return;
      }

      const retryable =
        response.statusCode === 408 ||
        response.statusCode === 429 ||
        response.statusCode >= 500;
      await this.fail(
        delivery,
        retryable,
        response.statusCode,
        `Destination returned HTTP ${response.statusCode}`,
      );
    } catch (error) {
      await this.fail(
        delivery,
        !(error instanceof BadRequestException),
        null,
        cleanError(error),
      );
    }
  }

  private async fail(
    delivery: ClaimedDelivery,
    retryable: boolean,
    statusCode: number | null,
    error: string,
  ) {
    const retry = retryable && delivery.attempts < delivery.maxAttempts;
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: retry ? DeliveryStatus.RETRY : DeliveryStatus.DEAD,
        nextAttemptAt: retry
          ? new Date(Date.now() + retryDelayMs(delivery.attempts))
          : delivery.nextAttemptAt,
        lockedAt: null,
        lastStatusCode: statusCode,
        lastError: error,
      },
    });
    this.logger.warn({
      message: 'Webhook delivery failed',
      deliveryId: delivery.id,
      destinationId: delivery.destinationId,
      attempt: delivery.attempts,
      retry,
      statusCode,
      error,
    });
  }

  private finish(
    id: string,
    status: DeliveryStatus,
    statusCode: number | null,
    error: string,
  ) {
    return this.prisma.delivery.update({
      where: { id },
      data: {
        status,
        lockedAt: null,
        lastStatusCode: statusCode,
        lastError: error,
      },
    });
  }
}
