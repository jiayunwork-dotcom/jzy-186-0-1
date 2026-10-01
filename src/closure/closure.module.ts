import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { QueryModule } from '../query/query.module';
import { ClosureService } from './closure.service';
import { ClosureController } from './closure.controller';

@Module({
  imports: [AccountingModule, QueryModule],
  controllers: [ClosureController],
  providers: [ClosureService],
  exports: [ClosureService],
})
export class ClosureModule {}
