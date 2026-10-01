import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IngressService } from './ingress.service.js';

function parseProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'whatsapp' || normalized === 'instagram') {
    return normalized;
  }
  throw new BadRequestException('Provider must be whatsapp or instagram');
}

@Controller('hooks/meta/:provider/:publicKey')
export class IngressController {
  constructor(private readonly ingress: IngressService) {}

  @Get()
  async verify(
    @Param('provider') provider: string,
    @Param('publicKey') publicKey: string,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    return this.ingress.verifyChallenge(
      parseProvider(provider),
      publicKey,
      mode,
      token,
      challenge,
    );
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Param('publicKey') publicKey: string,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
    @Body() payload: Record<string, unknown>,
  ) {
    if (!request.rawBody)
      throw new BadRequestException('Raw request body is required');
    return this.ingress.receive(
      parseProvider(provider),
      publicKey,
      request.rawBody.toString('utf8'),
      payload,
      signature,
    );
  }
}
