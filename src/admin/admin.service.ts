import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { config } from '../utils/config.js';
import { encrypt } from '../utils/crypto.js';
import { UrlPolicyService } from '../utils/url-policy.js';

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field = 'isActive') {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new BadRequestException(`${field} must be boolean`);
  return value;
}

function providerValue(value: unknown, field = 'provider') {
  const normalized = requiredString(value, field).toLowerCase();
  if (normalized !== 'whatsapp' && normalized !== 'instagram') {
    throw new BadRequestException(`${field} must be whatsapp or instagram`);
  }
  return normalized;
}

function headersValue(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('headers must be an object');
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      throw new BadRequestException('header values must be strings');
    }
    headers[key.toLowerCase()] = headerValue;
  }
  return headers;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urlPolicy: UrlPolicyService,
  ) {}

  async createEndpoint(body: Record<string, unknown>) {
    const provider = providerValue(body.provider);
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        name: requiredString(body.name, 'name'),
        provider,
        verifyTokenEncrypted: encrypt(
          requiredString(body.verifyToken, 'verifyToken'),
        ),
        appSecretEncrypted: encrypt(
          requiredString(body.appSecret, 'appSecret'),
        ),
        isActive: optionalBoolean(body.isActive) ?? true,
      },
    });
    return this.endpointView(endpoint);
  }

  async listEndpoints() {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => this.endpointView(endpoint));
  }

  async updateEndpoint(id: string, body: Record<string, unknown>) {
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (body.name !== undefined) data.name = requiredString(body.name, 'name');
    if (body.verifyToken !== undefined) {
      data.verifyTokenEncrypted = encrypt(
        requiredString(body.verifyToken, 'verifyToken'),
      );
    }
    if (body.appSecret !== undefined) {
      data.appSecretEncrypted = encrypt(
        requiredString(body.appSecret, 'appSecret'),
      );
    }
    if (body.isActive !== undefined)
      data.isActive = optionalBoolean(body.isActive);
    if (!Object.keys(data).length)
      throw new BadRequestException('No fields to update');
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id },
      data,
    });
    return this.endpointView(endpoint);
  }

  async createDestination(body: Record<string, unknown>) {
    const url = await this.urlPolicy.assertSafe(
      requiredString(body.url, 'url'),
    );
    const headers = headersValue(body.headers);
    const timeoutMs =
      body.timeoutMs === undefined ? 10_000 : Number(body.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new BadRequestException(
        'timeoutMs must be an integer between 100 and 60000',
      );
    }
    const destination = await this.prisma.destination.create({
      data: {
        type: providerValue(body.type, 'type'),
        name: requiredString(body.name, 'name'),
        url: url.toString(),
        signingSecretEncrypted:
          body.signingSecret === undefined || body.signingSecret === null
            ? null
            : encrypt(requiredString(body.signingSecret, 'signingSecret')),
        headersEncrypted: headers ? encrypt(JSON.stringify(headers)) : null,
        timeoutMs,
        isActive: optionalBoolean(body.isActive) ?? true,
      },
    });
    return this.destinationView(destination);
  }

  async listDestinations() {
    const destinations = await this.prisma.destination.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return destinations.map((destination) => this.destinationView(destination));
  }

  async updateDestination(id: string, body: Record<string, unknown>) {
    const data: Prisma.DestinationUpdateInput = {};
    if (body.type !== undefined) data.type = providerValue(body.type, 'type');
    if (body.name !== undefined) data.name = requiredString(body.name, 'name');
    if (body.url !== undefined) {
      data.url = (
        await this.urlPolicy.assertSafe(requiredString(body.url, 'url'))
      ).toString();
    }
    if (body.signingSecret !== undefined) {
      data.signingSecretEncrypted =
        body.signingSecret === null
          ? null
          : encrypt(requiredString(body.signingSecret, 'signingSecret'));
    }
    if (body.headers !== undefined) {
      const headers = headersValue(body.headers);
      data.headersEncrypted = headers ? encrypt(JSON.stringify(headers)) : null;
    }
    if (body.timeoutMs !== undefined) {
      const timeoutMs = Number(body.timeoutMs);
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 100 ||
        timeoutMs > 60_000
      ) {
        throw new BadRequestException(
          'timeoutMs must be an integer between 100 and 60000',
        );
      }
      data.timeoutMs = timeoutMs;
    }
    if (body.isActive !== undefined)
      data.isActive = optionalBoolean(body.isActive);
    if (!Object.keys(data).length)
      throw new BadRequestException('No fields to update');
    const destination = await this.prisma.destination.update({
      where: { id },
      data,
    });
    return this.destinationView(destination);
  }

  setActive(resource: string, id: string, body: Record<string, unknown>) {
    const isActive = optionalBoolean(body.isActive);
    if (isActive === undefined)
      throw new BadRequestException('isActive is required');
    if (resource === 'endpoints') {
      return this.prisma.webhookEndpoint
        .update({ where: { id }, data: { isActive } })
        .then((row) => this.endpointView(row));
    }
    if (resource === 'destinations') {
      return this.prisma.destination
        .update({ where: { id }, data: { isActive } })
        .then((row) => this.destinationView(row));
    }
    throw new NotFoundException('Resource not found');
  }

  listEvents(limitValue?: string) {
    const limit = Math.min(
      Math.max(Number.parseInt(limitValue ?? '50', 10) || 50, 1),
      200,
    );
    return this.prisma.webhookEvent.findMany({
      include: { deliveries: true },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }

  listDeliveries(limitValue?: string) {
    const limit = Math.min(
      Math.max(Number.parseInt(limitValue ?? '50', 10) || 50, 1),
      200,
    );
    return this.prisma.delivery.findMany({
      include: {
        event: {
          select: {
            provider: true,
            eventTypes: true,
            receivedAt: true,
          },
        },
        destination: { select: { type: true, name: true, url: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  replayDelivery(id: string) {
    return this.prisma.delivery.update({
      where: { id },
      data: {
        status: 'RETRY',
        attempts: 0,
        maxAttempts: config.deliveryMaxAttempts(),
        nextAttemptAt: new Date(),
        lockedAt: null,
        lastError: null,
        lastStatusCode: null,
        deliveredAt: null,
      },
    });
  }

  private endpointView(endpoint: {
    id: string;
    publicKey: string;
    name: string;
    provider: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const provider = endpoint.provider.toLowerCase();
    return {
      id: endpoint.id,
      publicKey: endpoint.publicKey,
      name: endpoint.name,
      provider: endpoint.provider,
      isActive: endpoint.isActive,
      callbackPath: `/hooks/meta/${provider}/${endpoint.publicKey}`,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }

  private destinationView(destination: {
    id: string;
    type: string;
    name: string;
    url: string;
    signingSecretEncrypted: string | null;
    headersEncrypted: string | null;
    timeoutMs: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: destination.id,
      type: destination.type,
      name: destination.name,
      url: destination.url,
      hasSigningSecret: Boolean(destination.signingSecretEncrypted),
      hasHeaders: Boolean(destination.headersEncrypted),
      timeoutMs: destination.timeoutMs,
      isActive: destination.isActive,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    };
  }
}
