import crypto from 'node:crypto';

const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = process.env.LOG_LEVEL?.toLowerCase() || 'info';
const activeLevel = levels[configuredLevel] ?? levels.info;

const format = (level, message, fields = {}) => {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  return JSON.stringify(entry);
};

const shouldLog = (level) => levels[level] >= activeLevel;

export const logger = {
  debug: (message, fields) => {
    if (shouldLog('debug')) {
      console.debug(format('debug', message, fields));
    }
  },
  error: (message, fields) => console.error(format('error', message, fields)),
  info: (message, fields) => {
    if (shouldLog('info')) {
      console.log(format('info', message, fields));
    }
  },
  warn: (message, fields) => {
    if (shouldLog('warn')) {
      console.warn(format('warn', message, fields));
    }
  },
};

export const requestLogger = (request, response, next) => {
  const requestId = request.headers['x-request-id'] || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();

  request.id = requestId;
  response.setHeader('x-request-id', requestId);

  logger.debug('request.start', {
    method: request.method,
    path: request.originalUrl,
    requestId,
  });

  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.debug('request.finish', {
      durationMs: Number(durationMs.toFixed(2)),
      method: request.method,
      path: request.originalUrl,
      requestId,
      status: response.statusCode,
    });
  });

  next();
};
