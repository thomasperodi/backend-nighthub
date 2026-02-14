import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['error'],
    });
  }

  onModuleInit() {
    void this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private async connectWithRetry() {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        if (attempt > 1) {
          this.logger.log(`Prisma connected on attempt ${attempt}.`);
        }
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;
        const delayMs = attempt * 1000;

        this.logger.warn(
          `Prisma connection attempt ${attempt}/${maxAttempts} failed.`,
        );

        if (isLastAttempt) {
          this.logger.error(
            'Prisma could not connect at bootstrap. Continuing startup and relying on lazy reconnect.',
            error instanceof Error ? error.stack : undefined,
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
