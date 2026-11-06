import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, z } from 'zod';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { DomainError } from '../core/requests/request-service.js';

/** Maps domain errors to HTTP status codes so controllers stay thin. */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json({ error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: z.prettifyError(err) });
      return;
    }
    if (err instanceof NotFoundError || (err instanceof DomainError && err.code === 'not_found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ValidationError || err instanceof DomainError) {
      res.status(err instanceof DomainError && err.code === 'request_closed' ? 409 : 400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
