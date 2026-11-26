import winston from 'winston';

export type Logger = winston.Logger;

/**
 * Console logger. Extra metadata passed as the second argument is appended as JSON,
 * and Error objects passed anywhere are rendered with their stack.
 */
export function createLogger(level: string = 'info'): Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.colorize(),
      winston.format.printf((info) => {
        const { timestamp, level: lvl, message, stack, ...meta } = info;
        const metaKeys = Object.keys(meta).filter((key) => typeof key === 'string');
        const metaText = metaKeys.length > 0 ? ` ${safeJson(Object.fromEntries(metaKeys.map((k) => [k, meta[k]])))}` : '';
        const stackText = typeof stack === 'string' ? `\n${stack}` : '';
        return `${String(timestamp)} ${lvl}: ${String(message)}${metaText}${stackText}`;
      }),
    ),
    transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn'] })],
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (v instanceof Error ? describeError(v) : v));
  } catch {
    return '[unserializable metadata]';
  }
}

/** Renders any thrown value as a readable string (stack when available). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
