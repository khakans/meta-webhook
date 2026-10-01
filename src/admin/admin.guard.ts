import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../utils/config.js';
import { safeEqual } from '../utils/crypto.js';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.header('x-admin-api-key') ?? '';
    if (!supplied || !safeEqual(supplied, config.adminApiKey)) {
      throw new UnauthorizedException('Invalid admin API key');
    }
    return true;
  }
}
