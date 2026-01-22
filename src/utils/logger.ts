/**
 * 日志系统
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

// 日志格式化
function formatLog(entry: LogEntry): string {
  const time = entry.timestamp.split('T')[1].split('.')[0]; // HH:MM:SS
  return `${time} [${entry.module}] ${entry.message}`;
}

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
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }

    const entry: LogEntry = {
      level,
      module: this.module,
      message,
      timestamp: new Date().toISOString(),
      data,
    };

    const formatted = formatLog(entry);
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

// 全局 logger 实例缓存
const loggers = new Map<string, Logger>();

/**
 * 获取或创建 Logger 实例
 * @param module 模块名称
 */
export function setupLogger(module: string): Logger {
  if (!loggers.has(module)) {
    loggers.set(module, new Logger(module));
  }
  return loggers.get(module)!;
}

/**
 * 设置所有 logger 的 debug 模式
 */
export function setGlobalDebug(enabled: boolean): void {
  loggers.forEach(logger => logger.setDebug(enabled));
}
