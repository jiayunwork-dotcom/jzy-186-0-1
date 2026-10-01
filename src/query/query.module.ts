import { Global, Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { QueryService } from './query.service';
import { TraceService } from './trace.service';
import { QueryController } from './query.controller';

@Global()
@Module({
  imports: [AccountingModule],
  controllers: [QueryController],
  providers: [QueryService, TraceService],
  exports: [QueryService, TraceService],
})
export class QueryModule {}
