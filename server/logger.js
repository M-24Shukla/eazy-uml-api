import crypto from 'node:crypto';

const format = (level, message, fields = {}) => {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  return JSON.stringify(entry);
};

export const logger = {
  error: (message, fields) => console.error(format('error', message, fields)),
  info: (message, fields) => console.log(format('info', message, fields)),
  warn: (message, fields) => console.warn(format('warn', message, fields)),
};

export const requestLogger = (request, response, next) => {
  const requestId = request.headers['x-request-id'] || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();

  request.id = requestId;
  response.setHeader('x-request-id', requestId);

  logger.info('request.start', {
    method: request.method,
    path: request.originalUrl,
    requestId,
  });

  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.info('request.finish', {
      durationMs: Number(durationMs.toFixed(2)),
      method: request.method,
      path: request.originalUrl,
      requestId,
      status: response.statusCode,
    });
  });

  next();
};
