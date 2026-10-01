import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PersistenceModule } from './persistence/persistence.module';
import { FactorsModule } from './factors/factors.module';
import { ActivityModule } from './activity/activity.module';
import { AccountingModule } from './accounting/accounting.module';
import { RestatementModule } from './restatement/restatement.module';
import { QueryModule } from './query/query.module';
import { ClosureModule } from './closure/closure.module';
import { DATA_STORE } from './persistence/tokens';
import { Store } from './persistence/store.interface';

/**
 * 模块组织（按题目要求各自独立、多文件）：
 *  units        单位换算（质量/体积/能量 × 密度/热值）
 *  factors      因子库与版本、GWP 集合
 *  activity     活动数据与更正链
 *  accounting   核算引擎（现算、确定性）
 *  restatement  重述与 Shapley 差额分解
 *  closure      关账快照、基准年重算标记
 *  query        汇总查询与追溯
 *  persistence  内存 / PostgreSQL 16 两种存储实现
 */
@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    FactorsModule,
    ActivityModule,
    AccountingModule,
    RestatementModule,
    QueryModule,
    ClosureModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(@Inject(DATA_STORE) private readonly store: Store) {}

  async onApplicationBootstrap(): Promise<void> {
    // PG 驱动下启动即建表（IF NOT EXISTS，可重复执行）
    await this.store.init?.();
  }
}
