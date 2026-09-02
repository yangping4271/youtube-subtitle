import { describe, expect, it, vi } from 'vitest';

import {
  BrowserTranslationCoordinator,
  type BrowserTranslationJob,
  type BrowserTranslationStartRequest,
  type BrowserTranslationCoordinatorPublisher,
  type BrowserTranslationCoordinatorStore,
  type ExtensionBilingualSubtitles,
  type ExtensionTranslationExecutor,
} from '../../src/extension/translator.js';
import type { TranslationProgress, VideoSubtitleData } from '../../src/types/index.js';

const translatedResult: ExtensionBilingualSubtitles = {
  english: [{ startTime: 1, endTime: 2, text: 'hello' }],
  chinese: [{ startTime: 1, endTime: 2, text: '你好' }],
};

function createHarness(now: () => number = () => Date.now()) {
  let progress: TranslationProgress | null = null;
  let pendingJob: BrowserTranslationJob | null = null;
  const cachedResults = new Map<string, VideoSubtitleData>();

  const executor: ExtensionTranslationExecutor = {
    translate: vi.fn(async (request, observer) => {
      await observer.onProgress?.('translate', 1, 2);
      await observer.onPartialResult?.(translatedResult);
      return translatedResult;
    }),
  };

  const store: BrowserTranslationCoordinatorStore = {
    getProgress: vi.fn(async () => progress),
    saveProgress: vi.fn(async (nextProgress) => {
      progress = nextProgress;
    }),
    clearProgress: vi.fn(async () => {
      progress = null;
    }),
    getPendingJob: vi.fn(async () => pendingJob),
    savePendingJob: vi.fn(async (job) => {
      pendingJob = job;
    }),
    clearPendingJob: vi.fn(async () => {
      pendingJob = null;
    }),
    getVideoResult: vi.fn(async (videoId) => cachedResults.get(videoId) || null),
    saveVideoResult: vi.fn(async (videoId, result) => {
      cachedResults.set(videoId, result);
    }),
    clearVideoResult: vi.fn(async (videoId) => {
      cachedResults.delete(videoId);
    }),
  };

  const publisher: BrowserTranslationCoordinatorPublisher = {
    clear: vi.fn(async () => undefined),
    publishPartial: vi.fn(async () => undefined),
    publishFinal: vi.fn(async () => undefined),
  };

  return {
    executor,
    store,
    publisher,
    session: new BrowserTranslationCoordinator(executor, store, publisher, now),
  };
}

describe('BrowserTranslationCoordinator interface', () => {
  it('start 集中规范化请求、进度、partial result 和最终结果', async () => {
    const { executor, store, publisher, session } = createHarness();

    await session.start({
      videoId: 'video-1',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
      targetLanguage: 'zh',
      videoInfo: {
        title: 'Popup title',
        description: 'Description',
        aiSummary: 'Summary',
      },
    });

    expect(store.clearVideoResult).toHaveBeenCalledWith('video-1');
    expect(publisher.clear).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'activate',
        runId: expect.any(String),
        generation: expect.any(Number),
      })
    );
    expect(store.savePendingJob).toHaveBeenCalledWith(expect.objectContaining({
      generation: expect.any(Number),
    }));
    expect(executor.translate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          videoTitle: 'Popup title',
          videoDescription: 'Description',
          aiSummary: 'Summary',
        },
        signal: expect.any(AbortSignal),
      }),
      expect.anything()
    );
    expect(store.saveProgress).toHaveBeenCalledWith(expect.objectContaining({
      isTranslating: true,
      step: 'translate',
      current: 1,
      total: 2,
    }));
    expect(publisher.publishPartial).toHaveBeenCalledWith(
      42,
      translatedResult,
      expect.objectContaining({
        runId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
    expect(store.saveVideoResult).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({
        videoId: 'video-1',
        englishSubtitles: translatedResult.english,
        chineseSubtitles: translatedResult.chinese,
      })
    );
    expect(publisher.publishFinal).toHaveBeenCalledWith(
      42,
      translatedResult,
      expect.objectContaining({
        runId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
    expect(store.clearProgress).not.toHaveBeenCalled();
    expect(store.saveProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      isTranslating: false,
      completed: true,
      videoId: 'video-1',
      timestamp: expect.any(Number),
    }));
    expect(store.clearPendingJob).toHaveBeenCalledOnce();
  });

  it('status 在成功完成后返回持久化完成状态', async () => {
    const { session } = createHarness(() => 1_700);

    await session.start({
      videoId: 'video-complete',
      tabId: 7,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    });

    await expect(session.status({ videoId: 'video-complete' })).resolves.toEqual({
      isTranslating: false,
      progress: expect.objectContaining({
        isTranslating: false,
        completed: true,
        videoId: 'video-complete',
        timestamp: 1_700,
      }),
      cachedResult: expect.objectContaining({
        videoId: 'video-complete',
        englishSubtitles: translatedResult.english,
        chineseSubtitles: translatedResult.chinese,
      }),
    });
  });

  it('翻译失败时会取消已进入异步 publisher 的 partial 并清理当前 run', async () => {
    const { executor, store, publisher, session } = createHarness();
    let partialStartedResolve: (() => void) | undefined;
    const partialStarted = new Promise<void>((resolve) => {
      partialStartedResolve = resolve;
    });
    let committed = false;

    vi.mocked(publisher.publishPartial).mockImplementation(async (_tabId, _partial, context) => {
      const signal = context?.signal;
      if (!signal) {
        throw new Error('partial publisher 未收到取消 signal');
      }

      partialStartedResolve?.();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort);
      });

      if (!signal.aborted) {
        committed = true;
      }
    });

    vi.mocked(executor.translate).mockImplementation(async (_request, observer) => {
      void observer?.onPartialResult?.(translatedResult);
      await partialStarted;
      throw new Error('模拟外层批次失败');
    });

    await session.start({
      videoId: 'video-failure',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    });

    expect(committed).toBe(false);
    expect(publisher.publishPartial).toHaveBeenCalledWith(
      42,
      translatedResult,
      expect.objectContaining({
        runId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
    expect(publisher.clear).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        type: 'invalidate',
        runId: expect.any(String),
      })
    );
    expect(store.saveVideoResult).not.toHaveBeenCalled();
  });

  it('可以从持久化的 pending job 恢复翻译', async () => {
    const { executor, store, session } = createHarness();
    const request: BrowserTranslationStartRequest = {
      videoId: 'video-resume',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
      targetLanguage: 'zh',
    };
    await store.savePendingJob({
      id: 'job-1',
      request,
      updatedAt: 0,
    });

    await expect(session.resumePendingJob()).resolves.toBe(true);

    expect(executor.translate).toHaveBeenCalledWith(
      expect.objectContaining({ subtitles: request.subtitles }),
      expect.anything()
    );
    expect(store.clearPendingJob).toHaveBeenCalled();
  });

  it('只有在 pending job 持久化后才通知调用方已准备启动', async () => {
    const { store, session } = createHarness();
    const order: string[] = [];
    vi.mocked(store.savePendingJob).mockImplementationOnce(async () => {
      order.push('pending-job-persisted');
    });

    await session.start({
      videoId: 'video-prepared',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    }, undefined, () => {
      order.push('response-sent');
    });

    expect(order).toEqual(['pending-job-persisted', 'response-sent']);
  });

  it('同一视频的重复 start 不会取消并重启当前运行', async () => {
    const { executor, store, session } = createHarness();
    let firstSignal: AbortSignal | undefined;
    vi.mocked(executor.translate).mockImplementation(async (request) => {
      firstSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('翻译已取消');
          error.name = 'AbortError';
          reject(error);
        });
      });
      return translatedResult;
    });

    const first = session.start({
      videoId: 'video-1',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    await session.start({
      videoId: 'video-1',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    });

    expect(executor.translate).toHaveBeenCalledOnce();
    expect(firstSignal?.aborted).toBe(false);

    await session.cancel({ videoId: 'video-1', tabId: 42 });
    await first;
    expect(store.clearProgress).toHaveBeenCalled();
  });

  it('连续运行发布严格递增的 activation generation', async () => {
    const { publisher, session } = createHarness(() => 1_000);

    await session.start({
      videoId: 'video-a',
      tabId: 1,
      subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
    });
    await session.start({
      videoId: 'video-b',
      tabId: 2,
      subtitles: [{ startTime: 0, endTime: 1, text: 'second' }],
    });

    const activations = vi.mocked(publisher.clear).mock.calls
      .map(([, event]) => event)
      .filter((event) => event?.type === 'activate');
    expect(activations).toHaveLength(2);
    expect(activations[1]?.generation).toBeGreaterThan(activations[0]?.generation || 0);
  });

  it('cancel 只中止当前运行并清理当前视频', async () => {
    const { executor, store, publisher, session } = createHarness();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(executor.translate).mockImplementation(async (request) => {
      receivedSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('翻译已取消');
          error.name = 'AbortError';
          reject(error);
        });
      });
      return translatedResult;
    });

    const running = session.start({
      videoId: 'video-1',
      tabId: 42,
      subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
    });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    await session.cancel({ videoId: 'video-1', tabId: 42 });
    await running;

    expect(receivedSignal?.aborted).toBe(true);
    expect(store.clearVideoResult).toHaveBeenLastCalledWith('video-1');
    expect(store.clearVideoResult).not.toHaveBeenCalledWith('video-2');
    expect(publisher.clear).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        type: 'invalidate',
        runId: expect.any(String),
      })
    );
    expect(store.clearProgress).toHaveBeenCalled();
  });

  it('status 清理超时进度并返回当前视频结果', async () => {
    const elevenMinutes = 11 * 60 * 1000;
    const { store, session } = createHarness(() => elevenMinutes);
    const cachedResult: VideoSubtitleData = {
      videoId: 'video-1',
      timestamp: new Date(0).toISOString(),
      englishSubtitles: translatedResult.english,
      chineseSubtitles: translatedResult.chinese,
    };
    await store.saveProgress({ isTranslating: true, timestamp: 0 });
    await store.saveVideoResult('video-1', cachedResult);

    const status = await session.status({ videoId: 'video-1' });

    expect(status).toEqual({
      isTranslating: false,
      progress: null,
      cachedResult,
    });
    expect(store.clearProgress).toHaveBeenCalled();
    expect(store.getVideoResult).toHaveBeenCalledWith('video-1');
  });

  it('只有 pending job 时，status 也提供可显示的恢复进度', async () => {
    const { store, session } = createHarness(() => 1_000);
    await store.savePendingJob({
      id: 'job-resume-status',
      request: {
        videoId: 'video-resume-status',
        subtitles: [
          { startTime: 0, endTime: 1, text: 'one' },
          { startTime: 1, endTime: 2, text: 'two' },
        ],
      },
      updatedAt: 900,
    });

    const status = await session.status({ videoId: 'video-resume-status' });

    expect(status.progress).toMatchObject({
      isTranslating: true,
      step: 'resume',
      current: 0,
      total: 2,
      timestamp: 900,
    });
  });

  it('后启动的运行不被已取消的旧运行清除状态', async () => {
    const { executor, store, publisher, session } = createHarness();
    let firstSignal: AbortSignal | undefined;
    vi.mocked(executor.translate)
      .mockImplementationOnce(async (request) => {
        firstSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('翻译已取消');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return translatedResult;
      })
      .mockResolvedValueOnce(translatedResult);

    const first = session.start({
      videoId: 'video-1',
      tabId: 1,
      subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const second = session.start({
      videoId: 'video-2',
      tabId: 2,
      subtitles: [{ startTime: 0, endTime: 1, text: 'second' }],
    });

    await Promise.all([first, second]);

    expect(firstSignal?.aborted).toBe(true);
    expect(store.saveVideoResult).toHaveBeenCalledTimes(1);
    expect(store.saveVideoResult).toHaveBeenCalledWith('video-2', expect.anything());
    expect(publisher.publishFinal).toHaveBeenCalledTimes(1);
    expect(publisher.publishFinal).toHaveBeenCalledWith(
      2,
      translatedResult,
      expect.objectContaining({
        runId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
    expect(store.clearProgress).not.toHaveBeenCalled();
    expect(store.saveProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      isTranslating: false,
      completed: true,
      videoId: 'video-2',
    }));
  });

  it('一个视频不会显示或取消另一个视频的运行', async () => {
    const { executor, session } = createHarness();
    let firstSignal: AbortSignal | undefined;
    vi.mocked(executor.translate).mockImplementation(async (request) => {
      firstSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('翻译已取消');
          error.name = 'AbortError';
          reject(error);
        });
      });
      return translatedResult;
    });

    const running = session.start({
      videoId: 'video-a',
      tabId: 1,
      subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    expect(await session.status({ videoId: 'video-b' })).toMatchObject({
      isTranslating: false,
      progress: null,
    });
    await session.cancel({ videoId: 'video-b', tabId: 2 });
    expect(firstSignal?.aborted).toBe(false);
    expect(await session.status({ videoId: 'video-a' })).toMatchObject({
      isTranslating: true,
      progress: expect.objectContaining({ videoId: 'video-a' }),
    });

    await session.cancel({ videoId: 'video-a', tabId: 1 });
    await running;
    expect(firstSignal?.aborted).toBe(true);
  });

  it('等待存储的旧 cancel 不会清理后启动的新运行', async () => {
    const { executor, store, publisher, session } = createHarness();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let releaseProgressRead: (() => void) | undefined;
    const progressRead = new Promise<void>((resolve) => {
      releaseProgressRead = resolve;
    });

    vi.mocked(executor.translate)
      .mockImplementationOnce(async (request) => {
        firstSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('翻译已取消');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return translatedResult;
      })
      .mockImplementationOnce(async (request) => {
        secondSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('翻译已取消');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return translatedResult;
      });
    vi.mocked(store.getProgress).mockImplementationOnce(async () => {
      await progressRead;
      return { isTranslating: true, videoId: 'video-a' };
    });

    const first = session.start({
      videoId: 'video-a',
      tabId: 1,
      subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    const staleCancel = session.cancel({ videoId: 'video-a', tabId: 1 });
    await vi.waitFor(() => expect(store.getProgress).toHaveBeenCalled());
    const second = session.start({
      videoId: 'video-b',
      tabId: 2,
      subtitles: [{ startTime: 0, endTime: 1, text: 'second' }],
    });
    await vi.waitFor(() => expect(secondSignal).toBeDefined());

    releaseProgressRead?.();
    await staleCancel;

    expect(secondSignal?.aborted).toBe(false);
    expect(store.clearVideoResult).toHaveBeenLastCalledWith('video-a');
    expect(publisher.clear).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        type: 'invalidate',
        runId: expect.any(String),
      })
    );
    expect(await session.status({ videoId: 'video-b' })).toMatchObject({
      isTranslating: true,
      progress: expect.objectContaining({ videoId: 'video-b' }),
    });

    await session.cancel({ videoId: 'video-b', tabId: 2 });
    await Promise.all([first, second]);
  });

  it('仅有 pending job 的旧 cancel 不会向新运行发送全局 reset', async () => {
    const { executor, store, publisher, session } = createHarness();
    let secondSignal: AbortSignal | undefined;
    let releaseProgressRead: (() => void) | undefined;
    const progressRead = new Promise<void>((resolve) => {
      releaseProgressRead = resolve;
    });

    await store.savePendingJob({
      id: 'persisted-job-a',
      request: {
        videoId: 'video-a',
        tabId: 1,
        subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
      },
      updatedAt: 1,
    });
    vi.mocked(store.getProgress).mockImplementationOnce(async () => {
      await progressRead;
      return { isTranslating: true, videoId: 'video-a' };
    });
    vi.mocked(executor.translate).mockImplementationOnce(async (request) => {
      secondSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('翻译已取消');
          error.name = 'AbortError';
          reject(error);
        });
      });
      return translatedResult;
    });

    const staleCancel = session.cancel({ videoId: 'video-a', tabId: 1 });
    await vi.waitFor(() => expect(store.getProgress).toHaveBeenCalled());
    const second = session.start({
      videoId: 'video-b',
      tabId: 2,
      subtitles: [{ startTime: 0, endTime: 1, text: 'second' }],
    });
    await vi.waitFor(() => expect(secondSignal).toBeDefined());

    releaseProgressRead?.();
    await staleCancel;

    expect(secondSignal?.aborted).toBe(false);
    expect(publisher.clear).toHaveBeenCalledTimes(1);
    expect(publisher.clear).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'activate',
        runId: expect.any(String),
      })
    );

    await session.cancel({ videoId: 'video-b', tabId: 2 });
    await second;
  });

  it('cancel 清理旧视频期间启动的新运行保留进度', async () => {
    const { executor, store, session } = createHarness();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let releaseVideoCleanup: (() => void) | undefined;
    const videoCleanup = new Promise<void>((resolve) => {
      releaseVideoCleanup = resolve;
    });

    vi.mocked(executor.translate)
      .mockImplementationOnce(async (request) => {
        firstSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('翻译已取消');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return translatedResult;
      })
      .mockImplementationOnce(async (request) => {
        secondSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('翻译已取消');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return translatedResult;
      });

    const first = session.start({
      videoId: 'video-a',
      tabId: 1,
      subtitles: [{ startTime: 0, endTime: 1, text: 'first' }],
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    vi.mocked(store.clearVideoResult).mockImplementationOnce(async () => {
      await videoCleanup;
    });

    const cancel = session.cancel({ videoId: 'video-a', tabId: 1 });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    const second = session.start({
      videoId: 'video-b',
      tabId: 2,
      subtitles: [{ startTime: 0, endTime: 1, text: 'second' }],
    });
    await vi.waitFor(() => expect(secondSignal).toBeDefined());

    releaseVideoCleanup?.();
    await cancel;

    expect(await session.status({ videoId: 'video-b' })).toMatchObject({
      isTranslating: true,
      progress: expect.objectContaining({ videoId: 'video-b' }),
    });

    await session.cancel({ videoId: 'video-b', tabId: 2 });
    await Promise.all([first, second]);
  });
});
