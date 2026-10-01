import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type WebhookEndpoint } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService, prismaJson } from '../database/prisma.service.js';
import { config } from '../utils/config.js';
import { decrypt, hmacHex, safeEqual } from '../utils/crypto.js';

type JsonObject = Record<string, unknown>;

type ScopedEvent = {
  payload: JsonObject;
  rawBody: string;
  eventTypes: string[];
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unique(values: Array<string | null>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function whatsappScopes(payload: JsonObject): ScopedEvent[] {
  const object = payload.object;
  return arrayValue(payload.entry).flatMap((rawEntry) => {
    const entry = objectValue(rawEntry);
    const changes = arrayValue(entry.changes);
    const scopedChanges = changes.length ? changes : [null];
    return scopedChanges.map((rawChange) => {
      const change = objectValue(rawChange);
      const value = objectValue(change.value);
      const messages = arrayValue(value.messages).map(objectValue);
      const statuses = arrayValue(value.statuses).map(objectValue);
      const scopedEntry =
        rawChange === null ? entry : { ...entry, changes: [change] };
      const scopedPayload = { object, entry: [scopedEntry] };
      const eventTypes = unique([
        stringValue(change.field),
        ...messages.map((message) => {
          const type = stringValue(message.type);
          return type ? `messages:${type}` : 'messages';
        }),
        ...statuses.map((status) => {
          const type = stringValue(status.status);
          return type ? `statuses:${type}` : 'statuses';
        }),
      ]);
      return {
        payload: scopedPayload,
        rawBody: JSON.stringify(scopedPayload),
        eventTypes,
      };
    });
  });
}

function instagramScopes(payload: JsonObject): ScopedEvent[] {
  const object = payload.object;
  return arrayValue(payload.entry).map((rawEntry) => {
    const entry = objectValue(rawEntry);
    const scopedPayload = { object, entry: [entry] };
    const changes = arrayValue(entry.changes).map(objectValue);
    const eventTypes = unique([
      ...(arrayValue(entry.messaging).length ? ['messaging'] : []),
      ...changes.map((change) => stringValue(change.field)),
    ]);
    return {
      payload: scopedPayload,
      rawBody: JSON.stringify(scopedPayload),
      eventTypes,
    };
  });
}

function fallbackScope(payload: JsonObject): ScopedEvent {
  const rawBody = JSON.stringify(payload);
  return { payload, rawBody, eventTypes: [] };
}

function providerObject(provider: string) {
  return provider === 'whatsapp' ? 'whatsapp_business_account' : 'instagram';
}

@Injectable()
export class IngressService {
  constructor(private readonly prisma: PrismaService) {}

  async getEndpoint(provider: string, publicKey: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { provider, publicKey, isActive: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    return endpoint;
  }

  async verifyChallenge(
    provider: string,
    publicKey: string,
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ) {
    const endpoint = await this.getEndpoint(provider, publicKey);
    if (
      mode !== 'subscribe' ||
      !token ||
      !challenge ||
      !safeEqual(token, decrypt(endpoint.verifyTokenEncrypted))
    ) {
      throw new UnauthorizedException('Webhook verification failed');
    }
    return challenge;
  }

  async receive(
    provider: string,
    publicKey: string,
    rawBody: string,
    payload: JsonObject,
    signature: string | undefined,
  ) {
    const endpoint = await this.getEndpoint(provider, publicKey);
    this.verifyMetaSignature(endpoint, rawBody, signature);
    if (payload.object !== providerObject(provider)) {
      throw new UnauthorizedException(
        'Payload does not match endpoint provider',
      );
    }

    const extracted =
      provider === 'whatsapp'
        ? whatsappScopes(payload)
        : instagramScopes(payload);
    const scopes = extracted.length ? extracted : [fallbackScope(payload)];
    let accepted = 0;
    let duplicates = 0;
    let deliveries = 0;

    for (const scope of scopes) {
      const result = await this.persistScope(endpoint, scope);
      if (result.duplicate) duplicates += 1;
      else accepted += 1;
      deliveries += result.deliveries;
    }

    return { accepted, duplicates, deliveries };
  }

  private verifyMetaSignature(
    endpoint: WebhookEndpoint,
    rawBody: string,
    signature: string | undefined,
  ) {
    const supplied = signature?.startsWith('sha256=') ? signature.slice(7) : '';
    const expected = hmacHex(decrypt(endpoint.appSecretEncrypted), rawBody);
    if (!supplied || !safeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid Meta webhook signature');
    }
  }

  private async persistScope(endpoint: WebhookEndpoint, scope: ScopedEvent) {
    const dedupeKey = createHash('sha256')
      .update(`${endpoint.id}:${scope.rawBody}`)
      .digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const destinations = await tx.destination.findMany({
          where: { type: endpoint.provider, isActive: true },
          select: { id: true },
        });
        const event = await tx.webhookEvent.create({
          data: {
            endpointId: endpoint.id,
            provider: endpoint.provider,
            dedupeKey,
            eventTypes: scope.eventTypes,
            payload: prismaJson(scope.payload),
            rawBody: scope.rawBody,
            status: 'BROADCAST',
          },
        });
        if (destinations.length) {
          await tx.delivery.createMany({
            data: destinations.map((destination) => ({
              eventId: event.id,
              destinationId: destination.id,
              maxAttempts: config.deliveryMaxAttempts(),
            })),
          });
        }
        return { duplicate: false, deliveries: destinations.length };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { duplicate: true, deliveries: 0 };
      }
      throw error;
    }
  }
}
