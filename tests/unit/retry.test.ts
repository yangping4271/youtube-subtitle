import { describe, expect, it, vi } from 'vitest';

import { classifyError, withRetry } from '../../src/utils/retry.js';
import { classifyErrorWithSuggestion } from '../../src/utils/error-handler.js';

describe('withRetry', () => {
  it('HTTP 400 在重试器和错误详情中都被视为不可重试', () => {
    const error = Object.assign(new Error('invalid request'), { status: 400 });

    expect(classifyError(error)).toBe('fatal');
    expect(classifyErrorWithSuggestion(error).isRetryable).toBe(false);
  });

  it('优先使用服务端提供的 retryAfterMs，而不是固定延迟', async () => {
    const error = Object.assign(new Error('rate limited'), { retryAfterMs: 0 });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(operation, {
      maxRetries: 1,
      delays: [60_000],
    })).rejects.toThrow('rate limited');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('Retry-After 等待期间可以及时响应取消', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(
      Object.assign(new Error('rate limited'), { retryAfterMs: 200 })
    );
    const retryPromise = withRetry(operation, {
      maxRetries: 1,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 5);
    const outcome = await Promise.race([
      retryPromise.then(() => 'resolved', error => error),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(outcome).toMatchObject({ name: 'AbortError' });
    await retryPromise.catch(() => undefined);
  });
});
