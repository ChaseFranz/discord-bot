import winston from 'winston';

class LoggerService {
  private static instance: winston.Logger;

  // Private constructor prevents direct instantiation
  private constructor() {}

  // Returns the singleton instance of the logger
  public static getInstance(): winston.Logger {
    if (!LoggerService.instance) {
      LoggerService.instance = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
        ),
        transports: [new winston.transports.Console()],
      });
    }
    return LoggerService.instance;
  }
}

export default LoggerService;
