import { Module } from '@nestjs/common';
import { PromosController } from './promos.controller';
import { PublicPromosController } from './public-promos.controller';
import { PromosService } from './promos.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [PromosController, PublicPromosController],
  providers: [PromosService, PrismaService],
  exports: [PromosService],
})
export class PromosModule {}
