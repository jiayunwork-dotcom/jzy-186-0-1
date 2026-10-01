import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/exception.filter';

/** 创建内存驱动的 Nest 应用（每个用例独立数据） */
export async function createApp(): Promise<INestApplication> {
  process.env.DB_DRIVER = 'memory';
  process.env.BASE_YEAR = '2024';
  process.env.SIGNIFICANCE_THRESHOLD = '0.05';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.init();
  return app;
}
