/**
 * 平台无关的取消 interface。
 * AbortSignal 是生产 adapter；测试可以提供轻量的内存 adapter。
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export function createCancellationError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
