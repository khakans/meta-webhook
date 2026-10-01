import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { validateWorkerEnvironment } from '../utils/config.js';
import { DeliveryWorkerService } from './delivery-worker.service.js';
import { WorkerModule } from './worker.module.js';

validateWorkerEnvironment();
const app = await NestFactory.createApplicationContext(WorkerModule);
const abortController = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => abortController.abort());
}

await app.get(DeliveryWorkerService).run(abortController.signal);
await app.close();
