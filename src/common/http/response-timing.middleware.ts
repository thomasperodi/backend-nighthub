import type { RequestHandler } from 'express';

export function responseTimingMiddleware(): RequestHandler {
  return (_req, res, next) => {
    const start = process.hrtime.bigint();
    const originalEnd = res.end.bind(res) as typeof res.end;

    // Inject timing headers right before the response is finalized.
    res.end = ((...args: Parameters<typeof originalEnd>) => {
      if (!res.headersSent) {
        const endNs = process.hrtime.bigint();
        const totalMs = Number(endNs - start) / 1e6;

        // Use both a simple header and the standard Server-Timing.
        res.setHeader('X-Response-Time', `${totalMs.toFixed(1)}ms`);
        res.setHeader('Server-Timing', `total;dur=${totalMs.toFixed(1)}`);
      }
      return originalEnd(...args);
    }) as typeof res.end;

    next();
  };
}
