import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ClosureService, CloseMonthRequest } from './closure.service';

/**
 * 月度关账接口：
 *  POST /closures                 关账（锁口径、生成对外披露快照、必要时标记基准年）
 *  GET  /closures/:id             按 id 取快照
 *  GET  /closures?plantId=&month= 列出/按厂月查快照
 *  GET  /base-year-flags/:year    取基准年重算标记与说明记录
 */
@Controller()
export class ClosureController {
  constructor(private readonly service: ClosureService) {}

  @Post('closures')
  close(@Body() body: CloseMonthRequest) {
    return this.service.closeMonth(body);
  }

  @Get('closures/:id')
  get(@Param('id') id: string) {
    return this.service.getSnapshot(id);
  }

  @Get('closures')
  list(@Query('plantId') plantId?: string, @Query('month') month?: string) {
    return this.service.listSnapshots({ plantId, month });
  }

  @Get('base-year-flags/:year')
  flag(@Param('year') year: string) {
    return this.service.getBaseYearFlag(year);
  }
}
