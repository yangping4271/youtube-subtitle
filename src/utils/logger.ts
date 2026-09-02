/**
 * 日志系统
 */

type LogLevel = 'info' | 'warn' | 'error';

export class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const formatted = `${time} [${this.module}] ${message}`;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

    if (data !== undefined) {
      console[method](formatted, data);
    } else {
      console[method](formatted);
    }
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', `⚠️ ${message}`, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', `❌ ${message}`, data);
  }
}

const loggers = new Map<string, Logger>();

export function setupLogger(module: string): Logger {
  if (!loggers.has(module)) {
    loggers.set(module, new Logger(module));
  }
  return loggers.get(module)!;
}
