import { Global, Module } from '@nestjs/common';
import { FactorService } from './factor.service';
import { FactorController } from './factor.controller';

@Global()
@Module({
  controllers: [FactorController],
  providers: [FactorService],
  exports: [FactorService],
})
export class FactorsModule {}
