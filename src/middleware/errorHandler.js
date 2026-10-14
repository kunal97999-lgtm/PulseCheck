import { AppError, NotFoundError } from '../utils/errors.js';

export function notFoundHandler(req, res, next) {
  next(new NotFoundError('Route not found'));
}

// Express recognizes error middleware by its 4 parameters: do not remove `next`.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  }

  if (status >= 500) {
    req.log.error({ err }, 'Unhandled error'); // full detail stays server-side
  } else {
    req.log.info({ code, status }, 'Request rejected');
  }

  res.status(status).json({
    error: { code, message, ...(details && { details }), requestId: req.id },
  });
}
