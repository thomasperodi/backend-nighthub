import { LoggerService, LogLevel } from '@nestjs/common';
import { getRequestId } from './request-context';

/** Replaces Nest's default pretty-printed console logger with one JSON line per log call,
 * carrying the current request id (see request-context.middleware.ts) when logged inside a
 * request. Any log aggregator (Vercel logs, Datadog, etc.) can then filter/group by
 * requestId - this was previously not possible at all, since nothing tied separate log
 * lines from one request back together. */
export class StructuredLogger implements LoggerService {
  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ) {
    const entry = {
      level,
      time: new Date().toISOString(),
      requestId: getRequestId(),
      context,
      message: message instanceof Error ? message.message : message,
      ...(message instanceof Error && message.stack
        ? { stack: message.stack }
        : {}),
      ...extra,
    };

    const line = JSON.stringify(entry);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  log(message: unknown, context?: string) {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace ? { trace } : undefined);
  }

  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }
}
