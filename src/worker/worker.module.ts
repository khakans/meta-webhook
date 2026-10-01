import { Module } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { UrlPolicyService } from '../utils/url-policy.js';
import { DeliveryWorkerService } from './delivery-worker.service.js';

@Module({ providers: [PrismaService, UrlPolicyService, DeliveryWorkerService] })
export class WorkerModule {}
