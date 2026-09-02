/**
 * 日志系统
 */

export class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  info(message: string, data?: unknown): void {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const formatted = `${time} [${this.module}] ${message}`;

    if (data !== undefined) {
      console.log(formatted, data);
    } else {
      console.log(formatted);
    }
  }
}

const loggers = new Map<string, Logger>();

export function setupLogger(module: string): Logger {
  if (!loggers.has(module)) {
    loggers.set(module, new Logger(module));
  }
  return loggers.get(module)!;
}
