import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';

const logger = new Logger('HTTP');

// Requests currently in flight on this instance. With Vercel Fluid compute one instance serves
// many requests concurrently and they all share one Prisma pool, so this number next to a slow
// or failed request tells whether it was starved by its neighbours.
let inFlight = 0;

function slowThresholdMs(): number {
  const parsed = Number(process.env.LOG_SLOW_REQUEST_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

/** One structured line per request (method, path, status, duration, user, in-flight count).
 * `warn` for slow requests and 4xx, `error` for 5xx and for requests whose connection closed
 * before a response was sent (client gave up, or the platform killed the invocation). Set
 * LOG_REQUESTS=false to keep only the warn/error lines. */
export function requestLogMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const startedInFlight = ++inFlight;
    let done = false;

    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      inFlight--;

      const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      const user = (req as { user?: { id?: string; role?: string } }).user;
      const entry = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: aborted ? null : res.statusCode,
        durationMs,
        aborted,
        userId: user?.id,
        role: user?.role,
        inFlightAtStart: startedInFlight,
        inFlightNow: inFlight,
        heapMb: heapMb(),
      };

      if (aborted || res.statusCode >= 500) {
        logger.error(entry);
      } else if (res.statusCode >= 400 || durationMs >= slowThresholdMs()) {
        logger.warn(entry);
      } else if (process.env.LOG_REQUESTS !== 'false') {
        logger.log(entry);
      }
    };

    res.on('finish', () => finish(false));
    res.on('close', () => finish(!res.writableFinished));
    next();
  };
}
