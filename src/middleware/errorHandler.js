export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status =
    error.status ||
    (error.name === 'ZodError' ? 400 : error.code === 11000 ? 409 : 500);
  res.locals.loggingError = error;
  if (status >= 500) res.err = error;
  res.status(status).json({
    success: false,
    error: {
      message:
        status >= 500
          ? 'Internal server error'
          : error.name === 'ZodError'
            ? 'Invalid request'
            : error.message,
      ...(error.name === 'ZodError'
        ? {
            details: error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          }
        : {}),
    },
  });
}
