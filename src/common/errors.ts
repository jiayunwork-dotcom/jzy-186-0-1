/**
 * 领域错误。所有错误都携带稳定的 code，HTTP 层据此映射状态码，
 * 字段级错误携带 field，满足“输入校验指出具体字段”的要求。
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 字段级输入校验失败（HTTP 422） */
export class ValidationError extends DomainError {
  constructor(field: string, message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, field, details);
  }
}

/** 找不到引用对象（HTTP 404） */
export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NOT_FOUND', message, undefined, details);
  }
}

/** 并发/幂等冲突（HTTP 409）：如同一记录的两个更正并发提交 */
export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, undefined, details);
  }
}
