import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
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
    const requestId = getRequestId();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { ...(body as Record<string, unknown>), statusCode: status };

      response.status(status).json({ ...payload, requestId });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception : new Error(String(exception)),
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      requestId,
    });
  }
}
