import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from './errors';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY, // 422，字段级校验
  NOT_FOUND: HttpStatus.NOT_FOUND, // 404
  CONFLICT: HttpStatus.CONFLICT, // 409，并发更正/重复关账等
};

/** 把领域错误映射为稳定的 HTTP 响应体（含 code 与具体 field） */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: DomainError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    if (status >= 500) this.logger.error(exception.stack);
    res.status(status).json({
      error: {
        code: exception.code,
        message: exception.message,
        field: exception.field ?? null,
        details: exception.details ?? null,
      },
    });
  }
}
