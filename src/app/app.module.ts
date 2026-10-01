import { Module } from '@nestjs/common';
import { AdminController } from '../admin/admin.controller.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { AdminService } from '../admin/admin.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { HealthController } from '../health/health.controller.js';
import { IngressController } from '../ingress/ingress.controller.js';
import { IngressService } from '../ingress/ingress.service.js';
import { UrlPolicyService } from '../utils/url-policy.js';

@Module({
  imports: [],
  controllers: [AdminController, HealthController, IngressController],
  providers: [
    AdminGuard,
    AdminService,
    IngressService,
    PrismaService,
    UrlPolicyService,
  ],
})
export class AppModule {}
