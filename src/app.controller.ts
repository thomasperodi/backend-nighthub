import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/public.decorator';

// The shareable event page (/r/event/:eventId) moved to PublicWebController, served at the
// domain root; bootstrap.ts redirects the old /api/r/event/* URL there.
@Controller()
@Public()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
