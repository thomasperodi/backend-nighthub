import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

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

/** Host/port/pool params of the effective DB url, never the credentials - logged at startup so
 * the Vercel logs show which pooler and pool size an instance actually ended up with. */
function describeDatabaseUrl(url: string | undefined) {
  if (!url) return { configured: false };
  try {
    const parsed = new URL(url);
    return {
      configured: true,
      host: parsed.hostname,
      port: parsed.port,
      pgbouncer: parsed.searchParams.get('pgbouncer'),
      connection_limit: parsed.searchParams.get('connection_limit'),
      pool_timeout: parsed.searchParams.get('pool_timeout'),
    };
  } catch {
    return { configured: true, parseable: false };
  }
}

type PrismaLogEvents = 'query' | 'warn' | 'error';

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, PrismaLogEvents>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = serverlessDatabaseUrl(process.env.DATABASE_URL);
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      ...(url ? { datasources: { db: { url } } } : {}),
    });

    this.logger.log({
      msg: 'Prisma datasource',
      vercel: Boolean(process.env.VERCEL),
      ...describeDatabaseUrl(url ?? process.env.DATABASE_URL),
    });

    const slowQueryMs = Number(process.env.LOG_SLOW_QUERY_MS) || 500;
    this.$on('query', (e) => {
      if (e.duration < slowQueryMs) return;
      this.logger.warn({
        msg: 'Slow query',
        durationMs: e.duration,
        query: e.query.slice(0, 1000),
        target: e.target,
      });
    });
    this.$on('warn', (e) => {
      this.logger.warn({ msg: 'Prisma warn', message: e.message, target: e.target });
    });
    this.$on('error', (e) => {
      this.logger.error({ msg: 'Prisma error', message: e.message, target: e.target });
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

    const start = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        this.logger.log({
          msg: 'Prisma connected',
          attempt,
          durationMs: Date.now() - start,
        });
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;
        const delayMs = attempt * 1000;

        this.logger.warn({
          msg: `Prisma connection attempt ${attempt}/${maxAttempts} failed.`,
          error: error instanceof Error ? error.message : String(error),
        });

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
