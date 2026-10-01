import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/exception.filter';
import { ConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  await app.listen(config.port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `GHG accounting backend listening on :${config.port} (driver=${config.dbDriver}, baseYear=${config.baseYear}, threshold=${config.significanceThreshold})`,
  );
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('bootstrap failed', e);
  process.exit(1);
});
