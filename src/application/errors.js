export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export class ConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}

export class ResourceNotFoundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResourceNotFoundError';
    this.code = code;
  }
}
