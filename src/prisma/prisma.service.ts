import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * On Vercel every warm function instance holds its own Prisma pool. Without an explicit
 * `connection_limit` Prisma opens `num_cpus * 2 + 1` connections per instance, and this app
 * runs many queries in parallel (Promise.all), so every instance fills its pool: a few dozen
 * instances exhaust the Supabase pooler's client limit (EMAXCONN, 200) and even /auth/login
 * starts failing. Cap the pool per instance and fail fast (pool_timeout below the 10 s
 * maxDuration) instead of hanging. Explicit params in DATABASE_URL always win.
 */
export function serverlessDatabaseUrl(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!url || !env.VERCEL) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set(
        'connection_limit',
        env.PRISMA_CONNECTION_LIMIT || '2',
      );
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', '8');
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = serverlessDatabaseUrl(process.env.DATABASE_URL);
    super({
      log: ['error'],
      ...(url ? { datasources: { db: { url } } } : {}),
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
