import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { CorrectionRequest, ImportItem } from './entities';

/**
 * 活动数据接口：
 *  POST /activities/import   批量导入（逐条回报，非法记录不影响其余）
 *  POST /activities/correct  更正记录（并发只接受一个；重复编号幂等）
 *  GET  /activities/:id      查询单条记录
 *  GET  /activities/:id/chain 查询更正链
 */
@Controller('activities')
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Post('import')
  import(@Body() body: { items: ImportItem[] }) {
    return this.service.importBatch(Array.isArray(body?.items) ? body.items : []);
  }

  @Post('correct')
  correct(@Body() body: CorrectionRequest) {
    return this.service.correct(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getRecord(id);
  }

  @Get(':id/chain')
  chain(@Param('id') id: string) {
    return this.service.getRecord(id).then((r) => this.service.getChain(r.rootId));
  }
}
