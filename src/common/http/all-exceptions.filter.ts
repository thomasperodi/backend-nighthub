import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId } from './request-context';

// Centralizes what was previously implicit in Nest's default behavior (each service
// deciding for itself whether to catch/translate an error) - every response now carries
// `requestId` so a user-reported error can be matched to the exact log lines for that
// request, and every uncaught non-HTTP error is guaranteed to be logged with its stack
// before the client gets a generic 500 (never the raw error message/stack, same
// no-internals-leaked behavior as before, just centralized and always logged now).
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = getRequestId();
    const where = {
      method: request?.method,
      path: request?.originalUrl?.split('?')[0],
    };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(
          { msg: exception.message, status, ...where },
          exception.stack,
        );
      }
      const body = exception.getResponse();
      const payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { ...(body as Record<string, unknown>), statusCode: status };

      response.status(status).json({ ...payload, requestId });
      return;
    }

    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    // Prisma errors carry a code (P2024 = pool timeout, P1001 = DB unreachable, ...).
    const code = (exception as { code?: unknown })?.code;

    // P2023 = malformed column value, in practice a path/query id that is not a UUID
    // (e.g. GET /events/abc). That is the caller's mistake, not a server fault.
    if (code === 'P2023') {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Identificativo non valido',
        error: 'Bad Request',
        requestId,
      });
      return;
    }
    this.logger.error(
      { msg: error.message, name: error.name, code, ...where },
      error.stack,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      requestId,
    });
  }
}
