import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * On Vercel every warm function instance holds its own Prisma pool, and with Fluid compute
 * one instance serves many requests concurrently - so the pool is shared by every in-flight
 * request on that instance. A pool of 2 was far too small: a single fan-out endpoint (e.g.
 * /badges/me) queued dozens of queries on it and every other request on the instance hit
 * "Timed out fetching a new connection from the connection pool" / FUNCTION_INVOCATION_TIMEOUT.
 *
 * The scalable setup is Supabase's *transaction* pooler (Supavisor, port 6543): a client
 * connection only borrows a real Postgres backend for the duration of a transaction, so many
 * instances x `connection_limit` client connections multiplex onto the project's small
 * backend pool. The *session* pooler (5432) pins one backend per client connection and caps
 * out at the pool size, so it is rewritten to 6543 here. `pgbouncer=true` is mandatory in
 * transaction mode (disables Prisma's named prepared statements).
 *
 * Budget: instances x connection_limit must stay under the pooler's max client connections
 * (200 on the smallest Supabase compute tiers) - tune with PRISMA_CONNECTION_LIMIT.
 * Explicit params in DATABASE_URL always win.
 */
export function serverlessDatabaseUrl(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!url || !env.VERCEL) return undefined;
  try {
    const parsed = new URL(url);
    const isSupabasePooler = parsed.hostname.endsWith('.pooler.supabase.com');
    if (isSupabasePooler && (parsed.port === '5432' || parsed.port === '')) {
      parsed.port = '6543';
    }
    if (isSupabasePooler || parsed.port === '6543') {
      parsed.searchParams.set('pgbouncer', 'true');
    }
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set(
        'connection_limit',
        env.PRISMA_CONNECTION_LIMIT || '8',
      );
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', env.PRISMA_POOL_TIMEOUT || '20');
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
