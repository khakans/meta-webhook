import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from './database/prisma.service.js';
import { IngressService } from './ingress/ingress.service.js';
import { encrypt, hmacHex } from './utils/crypto.js';
import { UrlPolicyService } from './utils/url-policy.js';
import { DeliveryWorkerService } from './worker/delivery-worker.service.js';

beforeAll(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));
});

afterAll(() => vi.unstubAllEnvs());

describe('Instagram webhook flow', () => {
  it('verifies Meta and stores an event with a delivery', async () => {
    const endpoint = {
      id: 'endpoint-1',
      provider: 'instagram',
      appSecretEncrypted: encrypt('meta-secret'),
    };
    const createdEvents: Array<Record<string, unknown>> = [];
    const createdDeliveries: Array<Record<string, unknown>> = [];
    const tx = {
      destination: { findMany: async () => [{ id: 'destination-1' }] },
      webhookEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdEvents.push(data);
          return { id: 'event-1' };
        },
      },
      delivery: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          createdDeliveries.push(...data);
        },
      },
    };
    const prisma = {
      webhookEndpoint: { findFirst: async () => endpoint },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    const ingress = new IngressService(prisma);
    const payload = {
      object: 'instagram',
      entry: [{ id: 'ig-1', messaging: [{ message: { mid: 'mid-1' } }] }],
    };
    const body = JSON.stringify(payload);

    await expect(
      ingress.receive(
        'instagram',
        'key-1',
        body,
        payload,
        `sha256=${hmacHex('meta-secret', body)}`,
      ),
    ).resolves.toEqual({ accepted: 1, duplicates: 0, deliveries: 1 });
    expect(createdEvents[0]).toMatchObject({
      endpointId: 'endpoint-1',
      provider: 'instagram',
      eventTypes: ['messaging'],
    });
    expect(createdDeliveries).toMatchObject([
      { eventId: 'event-1', destinationId: 'destination-1' },
    ]);
    await expect(
      ingress.receive('instagram', 'key-1', body, payload, 'sha256=bad'),
    ).rejects.toThrow('Invalid Meta webhook signature');
  });

  it('sends a scoped payload with a valid Meta-style signature', async () => {
    const received: { body?: string; signature?: string } = {};
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.body = Buffer.concat(chunks).toString('utf8');
      received.signature = req.headers['x-hub-signature-256'] as string;
      res.writeHead(204).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'ig-1' }] });
      const delivery = {
        id: 'delivery-1',
        destinationId: 'destination-1',
        attempts: 1,
        maxAttempts: 8,
        event: {
          id: 'event-1',
          provider: 'instagram',
          rawBody: body,
          endpoint: { appSecretEncrypted: encrypt('meta-secret') },
        },
        destination: {
          type: 'instagram',
          isActive: true,
          url: `http://127.0.0.1:${address.port}/webhook`,
          timeoutMs: 1000,
          headersEncrypted: null,
          signingSecretEncrypted: null,
        },
      };
      const updates: Array<Record<string, unknown>> = [];
      const tx = {
        $queryRaw: async () => [{ id: delivery.id }],
        delivery: {
          updateMany: async () => ({}),
          findMany: async () => [delivery],
        },
      };
      const prisma = {
        $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
        delivery: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
          },
        },
      } as unknown as PrismaService;
      const urlPolicy = {
        assertSafe: async (url: string) => new URL(url),
      } as UrlPolicyService;

      await new DeliveryWorkerService(prisma, urlPolicy).processPendingOnce();

      expect(received.body).toBe(body);
      expect(received.signature).toBe(`sha256=${hmacHex('meta-secret', body)}`);
      expect(updates[0]).toMatchObject({ status: 'DELIVERED', lastStatusCode: 204 });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
