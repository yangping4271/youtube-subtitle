/**
 * 平台无关的取消 interface。
 * AbortSignal 是生产 adapter；测试可以提供轻量的内存 adapter。
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface CancellationScope {
  readonly signal: CancellationSignal;
  abort(): void;
  dispose(): void;
}

/** 创建一个可主动取消、并会跟随父 signal 的取消作用域。 */
export function createLinkedCancellationScope(
  parent?: CancellationSignal
): CancellationScope {
  const controller = new AbortController();
  const parentAbortHandler = (): void => controller.abort();

  parent?.addEventListener('abort', parentAbortHandler);
  if (parent?.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent?.removeEventListener('abort', parentAbortHandler),
  };
}

export function createCancellationError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
