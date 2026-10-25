import type { ZodError } from 'zod';

/** Error HTTP con código estable para el cliente y mensaje en español. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function formatZodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(raíz)',
    message: issue.message,
  }));
}

export function validationError(error: ZodError): HttpError {
  return new HttpError(400, 'VALIDACION', 'Los datos enviados no son válidos', formatZodIssues(error));
}
