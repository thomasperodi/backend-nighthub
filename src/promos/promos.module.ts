import { Module } from '@nestjs/common';
import { PromosController } from './promos.controller';
import { PublicPromosController } from './public-promos.controller';
import { PromosService } from './promos.service';
import { PushModule } from '../common/push/push.module';

@Module({
  imports: [PushModule],
  controllers: [PromosController, PublicPromosController],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
