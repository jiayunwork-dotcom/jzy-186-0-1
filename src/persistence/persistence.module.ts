import { Global, Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { InMemoryStore } from './inmemory.store';
import { PgStore } from './pg.store';
import { Store } from './store.interface';
import { DATA_STORE, FACTOR_STORE } from './tokens';

/**
 * 全局持久化模块：按 DB_DRIVER 提供唯一的 Store 单例，
 * 同时以活动数据端口和因子库端口两个令牌暴露同一实例，
 * 保证关账临界区跨模块共享同一把锁/事务。
 */
@Global()
@Module({
  providers: [
    {
      provide: DATA_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Store =>
        config.dbDriver === 'pg'
          ? new PgStore(config.databaseUrl)
          : new InMemoryStore(),
    },
    {
      provide: FACTOR_STORE,
      inject: [DATA_STORE],
      useFactory: (store: Store): Store => store,
    },
  ],
  exports: [DATA_STORE, FACTOR_STORE],
})
export class PersistenceModule {}
