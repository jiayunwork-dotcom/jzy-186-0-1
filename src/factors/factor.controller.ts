import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { FactorService } from './factor.service';
import { FactorVersionDraft, GwpSetDraft } from './store.interface';

/**
 * 因子库接口：
 *  POST /factor-versions            发布因子库版本（适用期间重叠 -> 422）
 *  GET  /factor-versions            列出版本
 *  GET  /factor-versions/:id        取版本（含全部因子行）
 *  POST /gwp-sets                   发布 GWP 集合（AR5/AR6）
 *  GET  /gwp-sets, /gwp-sets/:id   列出/取集合
 */
@Controller()
export class FactorController {
  constructor(private readonly service: FactorService) {}

  @Post('factor-versions')
  publish(@Body() body: FactorVersionDraft) {
    return this.service.publishFactorVersion(body);
  }

  @Get('factor-versions')
  list() {
    return this.service.listFactorVersions();
  }

  @Get('factor-versions/:id')
  get(@Param('id') id: string) {
    return this.service.getFactorVersion(id);
  }

  @Post('gwp-sets')
  publishGwp(@Body() body: GwpSetDraft) {
    return this.service.publishGwpSet(body);
  }

  @Get('gwp-sets')
  listGwp() {
    return this.service.listGwpSets();
  }

  @Get('gwp-sets/:id')
  getGwp(@Param('id') id: string) {
    return this.service.getGwpSet(id);
  }
}
