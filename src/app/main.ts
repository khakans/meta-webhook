import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { validateApiEnvironment } from '../utils/config.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  validateApiEnvironment();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
