/**
 * 日志系统
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private module: string;
  private debugEnabled: boolean;

  constructor(module: string, debugEnabled = false) {
    this.module = module;
    this.debugEnabled = debugEnabled;
  }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (level === 'debug' && !this.debugEnabled) return;

    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const formatted = `${time} [${this.module}] ${message}`;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

    if (data !== undefined) {
      console[method](formatted, data);
    } else {
      console[method](formatted);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', `🔍 ${message}`, data);
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

export function setGlobalDebug(enabled: boolean): void {
  loggers.forEach(logger => logger.setDebug(enabled));
}
