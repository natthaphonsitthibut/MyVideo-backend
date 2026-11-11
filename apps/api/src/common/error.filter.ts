import type { ApiErrorBody } from '@myvideo/contracts';
import { RunCapacityError } from '@myvideo/infra';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
  429: 'too_many_requests',
  503: 'service_unavailable',
};

/** Every error leaves the API as `ApiErrorBody`. Unknown errors are logged and become a bare 500. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let body: ApiErrorBody;
    if (exception instanceof RunCapacityError) {
      body = {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'too_many_runs',
        message: `มีงานที่ยังไม่เสร็จครบ ${exception.limit} งานแล้ว รอให้งานเดิมเสร็จก่อนแล้วลองใหม่ (too many unfinished runs, limit ${exception.limit})`,
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const message =
        typeof raw === 'string' ? raw : Array.isArray(obj.message) ? obj.message.join('; ') : obj.message;
      body = {
        statusCode: status,
        error:
          typeof obj.error === 'string' && /^[a-z_]+$/.test(obj.error)
            ? obj.error
            : (CODES[status] ?? `http_${status}`),
        message: typeof message === 'string' ? message : exception.message,
        ...(Array.isArray(obj.issues) ? { issues: obj.issues as ApiErrorBody['issues'] } : {}),
      };
    } else {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
      body = {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'internal_error',
        message: 'Internal server error',
      };
    }
    res.status(body.statusCode).json(body);
  }
}
