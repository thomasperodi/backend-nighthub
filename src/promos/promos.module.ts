import { Module } from '@nestjs/common';
import { PromosController } from './promos.controller';
import { PublicPromosController } from './public-promos.controller';
import { PromosService } from './promos.service';

@Module({
  controllers: [PromosController, PublicPromosController],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
