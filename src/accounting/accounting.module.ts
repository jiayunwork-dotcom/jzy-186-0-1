import { Module } from '@nestjs/common';
import { AccountingEngine } from './accounting.engine';

@Module({
  providers: [AccountingEngine],
  exports: [AccountingEngine],
})
export class AccountingModule {}
