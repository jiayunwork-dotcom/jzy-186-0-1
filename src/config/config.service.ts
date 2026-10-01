import { Injectable } from '@nestjs/common';

export type DbDriver = 'memory' | 'pg';

@Injectable()
export class ConfigService {
  readonly dbDriver: DbDriver;
  readonly databaseUrl: string;
  readonly port: number;
  readonly baseYear: string;
  readonly significanceThreshold: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const driver = (env.DB_DRIVER ?? 'memory').toLowerCase();
    this.dbDriver = driver === 'pg' ? 'pg' : 'memory';
    this.databaseUrl = env.DATABASE_URL ?? 'postgres://ghg:ghg_secret@localhost:5432/ghg';
    this.port = Number(env.PORT ?? 3000);
    this.baseYear = env.BASE_YEAR ?? '2024';
    const threshold = Number(env.SIGNIFICANCE_THRESHOLD ?? 0.05);
    this.significanceThreshold = Number.isFinite(threshold) ? threshold : 0.05;
  }
}
