import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import { runWithRequestContext } from './request-context';

// Every request gets an id (reused from an incoming X-Request-Id if the caller/proxy
// already set one, so a request can be traced across services) that every log line for
// that request carries - see structured-logger.ts. Without this, correlating "the auth
// service logged X, the reservations service logged Y" back to one HTTP request required
// guessing from timestamps.
export function requestContextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const requestId =
      (typeof incoming === 'string' && incoming.trim()) || randomUUID();

    res.setHeader('X-Request-Id', requestId);
    runWithRequestContext({ requestId }, next);
  };
}
