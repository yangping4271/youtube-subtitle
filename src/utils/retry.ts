/**
 * 通用重试工具
 */

import { setupLogger } from './logger.js';

const logger = setupLogger('retry');

export type ErrorType = 'retryable' | 'fatal';

export interface RetryOptions {
  /** 最大重试次数（不包括首次尝试） */
  maxRetries?: number;
  /** 每次重试的延迟时间（毫秒），支持指数退避 */
  delays?: number[];
  /** 错误分类函数 */
  shouldRetry?: (error: Error) => boolean;
  /** 操作名称，用于日志 */
  operationName?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 致命错误模式 - 不应重试 */
const FATAL_PATTERNS = [
  'invalid api key', 'incorrect api key', 'api key not found',
  'authentication failed', 'invalid_api_key',
  'model_not_found', 'model does not exist',
  '404', 'not found', '401', 'unauthorized', '403', 'forbidden',
];

/** 可重试错误模式 */
const RETRYABLE_PATTERNS = [
  'timeout', 'timed out', 'aborterror',
  'econnreset', 'econnrefused', 'network', 'fetch failed',
  'rate_limit_exceeded', 'rate limit', 'too many requests', '429',
  '500', '502', '503', 'service unavailable', 'internal server error', 'bad gateway',
  'temporarily unavailable',
];

/**
 * 分类错误类型
 */
export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (FATAL_PATTERNS.some(p => message.includes(p))) return 'fatal';
  if (RETRYABLE_PATTERNS.some(p => message.includes(p))) return 'retryable';

  return 'retryable'; // 默认可重试
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的异步函数包装器
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 1,  // 首次 + 1次重试 = 总共2次（与Python项目一致）
    delays = [1000, 2000, 4000],
    shouldRetry = (error: Error) => classifyError(error) === 'retryable',
    operationName = 'Operation',
    signal,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 检查是否已取消
    if (signal?.aborted) {
      throw new DOMException('操作已取消', 'AbortError');
    }

    try {
      if (attempt > 0) {
        const delayMs = delays[Math.min(attempt - 1, delays.length - 1)];
        logger.info(`⏳ ${operationName} 第 ${attempt} 次重试，延迟 ${delayMs}ms`);
        await delay(delayMs);

        // 延迟后再次检查是否已取消
        if (signal?.aborted) {
          throw new DOMException('操作已取消', 'AbortError');
        }
      }

      const result = await fn();

      if (attempt > 0) {
        logger.info(`✅ ${operationName} 重试成功（第 ${attempt} 次重试）`);
      }

      return result;

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // AbortError 不重试，直接抛出
      if (lastError.name === 'AbortError') {
        logger.info(`🛑 ${operationName} 已取消`);
        throw lastError;
      }

      if (!shouldRetry(lastError)) {
        logger.error(`❌ ${operationName} 遇到致命错误，不再重试: ${lastError.message}`);
        throw lastError;
      }

      if (attempt === maxRetries) {
        logger.error(`❌ ${operationName} 重试 ${maxRetries} 次后仍失败: ${lastError.message}`);
        throw lastError;
      }

      logger.warn(`⚠️ ${operationName} 失败（尝试 ${attempt + 1}/${maxRetries + 1}）: ${lastError.message}`);
    }
  }

  throw lastError || new Error(`${operationName} 失败`);
}

