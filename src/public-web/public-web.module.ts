import { Module } from '@nestjs/common';
import { PublicWebController } from './public-web.controller';

@Module({
  controllers: [PublicWebController],
})
export class PublicWebModule {}
