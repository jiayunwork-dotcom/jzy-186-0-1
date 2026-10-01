import { Body, Controller, Post } from '@nestjs/common';
import { RestatementService } from './restatement.service';
import { CellFilterSpec } from './cell-filter';

/**
 * 重述与差额分解接口：
 *  POST /restatements/compare
 *    body: { caliberA, caliberB, filter? }
 *    返回总差额及 Shapley 三因素分解（三部分之和严格等于总差额）。
 */
@Controller('restatements')
export class RestatementController {
  constructor(private readonly service: RestatementService) {}

  @Post('compare')
  compare(
    @Body()
    body: {
      caliberA: Parameters<RestatementService['restate']>[0];
      caliberB: Parameters<RestatementService['restate']>[1];
      filter?: CellFilterSpec;
    },
  ) {
    return this.service.restate(body.caliberA, body.caliberB, body.filter ?? {});
  }
}
