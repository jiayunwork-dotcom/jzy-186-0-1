import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { RestatementService } from './restatement.service';
import { RestatementController } from './restatement.controller';

@Module({
  imports: [AccountingModule],
  controllers: [RestatementController],
  providers: [RestatementService],
  exports: [RestatementService],
})
export class RestatementModule {}
