import { Body, Controller, Post } from '@nestjs/common';
import { QueryService } from './query.service';
import { TraceService } from './trace.service';

/**
 * 核算查询与追溯接口：
 *  POST /query/summary          按口径查询汇总（公司/厂区/排放源 × 月/年 × 范围一/二）
 *  POST /query/trace            查询汇总数字由哪些原始记录与因子得出
 */
@Controller('query')
export class QueryController {
  constructor(
    private readonly query: QueryService,
    private readonly trace: TraceService,
  ) {}

  @Post('summary')
  summary(@Body() body: { caliber: Parameters<QueryService['query']>[0] }) {
    return this.query.query(body.caliber);
  }

  @Post('trace')
  traceOne(
    @Body()
    body: {
      caliber: Parameters<TraceService['trace']>[0];
      filter?: Parameters<TraceService['trace']>[1];
    },
  ) {
    return this.trace.trace(body.caliber, body.filter ?? {});
  }
}
