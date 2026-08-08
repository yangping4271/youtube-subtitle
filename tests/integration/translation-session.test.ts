import { describe, expect, it, vi } from 'vitest';

import {
  TranslationSession,
  type ChatCompletionPort,
} from '../../src/core/translation-session.js';
import type {
  ChatOptions,
  SubtitleEntry,
  TranslatorConfig,
} from '../../src/types/index.js';
import type { CancellationSignal } from '../../src/utils/cancellation.js';

function createConfig(): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://example.test/v1',
    openaiApiKey: 'test-key',
    model: 'test-model',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2,
  };
}

function readSubtitleMap(userPrompt: string): Record<string, string> {
  const match = userPrompt.match(/<subtitles>([\s\S]*?)<\/subtitles>/);
  if (!match) {
    throw new Error('fake adapter 未找到字幕 JSON');
  }
  return JSON.parse(match[1]) as Record<string, string>;
}

class FakeChatCompletionAdapter implements ChatCompletionPort {
  readonly splitCompletionOrder: string[] = [];

  async callChat(
    _systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): Promise<string> {
    if (!options.responseFormat) {
      const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
      if (sourceText.includes('first 0')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      this.splitCompletionOrder.push(sourceText.includes('first 0') ? 'first' : 'second');
      const words = sourceText.split(/\s+/);
      const sentences: string[] = [];
      for (let index = 0; index < words.length; index += 10) {
        sentences.push(words.slice(index, index + 10).join(' '));
      }
      return sentences.join('<br>');
    }

    const subtitles = readSubtitleMap(userPrompt);
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
      )
    );
  }
}

function createLongSubtitle(
  prefix: string,
  startTime: number,
  endTime: number
): SubtitleEntry {
  return {
    index: 1,
    startTime,
    endTime,
    text: Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`).join(' '),
  };
}

describe('TranslationSession interface', () => {
  it('后续先完成的翻译子批立即发送 partial', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondPartial!: () => void;
    const secondPartialPromise = new Promise<void>((resolve) => {
      secondPartial = resolve;
    });
    const partialTexts: string[] = [];

    const fakeTranslator = {
      async translate(subtitles: Record<string, string>) {
        const text = Object.values(subtitles)[0];
        if (text === 'first') {
          firstStarted();
          await firstGate;
        }
        return [{
          index: 1,
          startTime: 0,
          endTime: 1_000,
          original: text,
          translation: `译:${text}`,
        }];
      },
    };
    const session = new TranslationSession({ ...createConfig(), batchSize: 1 }, {
      callChat: async () => '',
    });
    const internals = session as unknown as {
      translateBatch: (
        segments: SubtitleEntry[],
        translator: typeof fakeTranslator,
        request: { subtitles: SubtitleEntry[] },
        batchNumber: number,
        onPartialResult: (partial: { english: SubtitleEntry[]; chinese: SubtitleEntry[] }) => void
      ) => Promise<unknown>;
    };
    const segments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 1_000, text: 'first' },
      { index: 2, startTime: 1_000, endTime: 2_000, text: 'second' },
    ];

    const translation = internals.translateBatch(
      segments,
      fakeTranslator,
      { subtitles: segments },
      1,
      (partial) => {
        partialTexts.push(partial.english[0]?.text || '');
        if (partial.english[0]?.text === 'second') secondPartial();
      }
    );

    try {
      await firstStartedPromise;
      const arrived = await Promise.race([
        secondPartialPromise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);
      expect(arrived).toBe(true);
      expect(partialTexts[0]).toBe('second');
    } finally {
      releaseFirst();
      await translation;
    }
  });

  it('子批失败后取消 sibling，并阻止 sibling 发布 partial', async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const partials: string[] = [];
    const fakeTranslator = {
      async translate(subtitles: Record<string, string>) {
        const text = Object.values(subtitles)[0];
        if (text === 'first') {
          firstStarted();
          const error = new Error('HTTP 401 Unauthorized') as Error & { status: number };
          error.name = 'ApiRequestError';
          error.status = 401;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        return [{
          index: 1,
          startTime: 0,
          endTime: 1_000,
          original: text,
          translation: `译:${text}`,
        }];
      },
    };
    const session = new TranslationSession({ ...createConfig(), batchSize: 1 }, {
      callChat: async () => '',
    });
    const internals = session as unknown as {
      translateBatch: (
        segments: SubtitleEntry[],
        translator: typeof fakeTranslator,
        request: { subtitles: SubtitleEntry[] },
        batchNumber: number,
        onPartialResult: (partial: { english: SubtitleEntry[]; chinese: SubtitleEntry[] }) => void
      ) => Promise<unknown>;
    };
    const segments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 1_000, text: 'first' },
      { index: 2, startTime: 1_000, endTime: 2_000, text: 'second' },
    ];
    const translation = internals.translateBatch(
      segments,
      fakeTranslator,
      { subtitles: segments },
      1,
      (partial) => partials.push(partial.english[0]?.text || '')
    );

    await firstStartedPromise;
    await expect(translation).rejects.toMatchObject({ status: 401 });
    expect(partials).toEqual([]);
  });

  it('外层批次失败会取消其他批次，并阻止慢批次发布 partial', async () => {
    let slowTranslationStarted!: () => void;
    let fatalTranslationStarted!: () => void;
    const slowTranslationStartedPromise = new Promise<void>((resolve) => {
      slowTranslationStarted = resolve;
    });
    const fatalTranslationStartedPromise = new Promise<void>((resolve) => {
      fatalTranslationStarted = resolve;
    });
    let releaseSlowTranslation!: () => void;
    const slowTranslationGate = new Promise<void>((resolve) => {
      releaseSlowTranslation = resolve;
    });
    let slowAborted = false;
    const partials: string[] = [];

    const waitForAbortOrRelease = (signal: ChatOptions['signal']): Promise<void> => (
      new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          slowAborted = true;
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('翻译已取消');
          error.name = 'AbortError';
          reject(error);
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener('abort', onAbort);
        slowTranslationGate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      })
    );

    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        const isTranslationRequest = userPrompt.includes('<subtitles>');
        if (!isTranslationRequest) {
          const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          if (sourceText.includes('fatal sentence')) {
            await slowTranslationStartedPromise;
            fatalTranslationStarted();
            const error = new Error('HTTP 401 Unauthorized') as Error & { status: number };
            error.name = 'ApiRequestError';
            error.status = 401;
            throw error;
          }
          return sourceText;
        }

        const subtitles = readSubtitleMap(userPrompt);
        const sourceText = Object.values(subtitles).join(' ');

        if (sourceText.includes('slowword')) {
          slowTranslationStarted();
          await waitForAbortOrRelease(options.signal);
          return JSON.stringify(
            Object.fromEntries(
              Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
            )
          );
        }

        return JSON.stringify(
          Object.fromEntries(
            Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
          )
        );
      },
    };

    const slowText = `${Array.from({ length: 79 }, () => 'slowword').join(' ')}.`;
    const session = new TranslationSession({
      ...createConfig(),
      threadNum: 2,
      batchSize: 10,
    }, chatCompletion);
    const translation = session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 10_000, text: slowText },
          { index: 2, startTime: 10_000, endTime: 11_000, text: 'fatal sentence.' },
        ],
      },
      {
        onPartialResult: (partial) => {
          partials.push(partial.english[0]?.text || '');
        },
      }
    );

    try {
      await Promise.all([
        slowTranslationStartedPromise,
        fatalTranslationStartedPromise,
      ]);

      const settledBeforeRelease = await Promise.race([
        translation.then(() => true, () => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);

      expect(settledBeforeRelease).toBe(true);
      await expect(translation).rejects.toMatchObject({
        name: 'ApiRequestError',
        status: 401,
      });
      expect(slowAborted).toBe(true);
      expect(partials).toEqual([]);
    } finally {
      releaseSlowTranslation();
      await translation.catch(() => undefined);
    }
  });

  it('外层批次失败会取消已经进入异步 publisher 的 partial', async () => {
    let partialStarted!: () => void;
    const partialStartedPromise = new Promise<void>((resolve) => {
      partialStarted = resolve;
    });
    let releasePartial!: () => void;
    const partialGate = new Promise<void>((resolve) => {
      releasePartial = resolve;
    });
    let partialAborted = false;
    let partialCommitted = false;

    const waitForAbortOrRelease = (signal?: CancellationSignal): Promise<void> => (
      new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          partialAborted = true;
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('partial 已取消');
          error.name = 'AbortError';
          reject(error);
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener('abort', onAbort);
        partialGate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      })
    );

    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        if (!userPrompt.includes('<subtitles>')) {
          const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          if (sourceText.includes('fatal sentence')) {
            await partialStartedPromise;
            const error = new Error('HTTP 401 Unauthorized') as Error & { status: number };
            error.name = 'ApiRequestError';
            error.status = 401;
            throw error;
          }
          return sourceText;
        }

        const subtitles = readSubtitleMap(userPrompt);
        return JSON.stringify(
          Object.fromEntries(
            Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
          )
        );
      },
    };

    const session = new TranslationSession({
      ...createConfig(),
      threadNum: 2,
      batchSize: 10,
    }, chatCompletion);
    const partials = session.translate(
      {
        subtitles: [
          {
            index: 1,
            startTime: 0,
            endTime: 10_000,
            text: `${Array.from({ length: 79 }, () => 'publisherword').join(' ')}.`,
          },
          { index: 2, startTime: 10_000, endTime: 11_000, text: 'fatal sentence.' },
        ],
      },
      {
        onPartialResult: async (...args: [
          { english: SubtitleEntry[]; chinese: SubtitleEntry[] },
          CancellationSignal?
        ]) => {
          const [, signal] = args;
          partialStarted();
          await waitForAbortOrRelease(signal);
          if (!signal?.aborted) {
            partialCommitted = true;
          }
        },
      }
    );

    try {
      await partialStartedPromise;
      const settledBeforeRelease = await Promise.race([
        partials.then(() => true, () => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);

      expect(settledBeforeRelease).toBe(true);
      expect(partialAborted).toBe(true);
      expect(partialCommitted).toBe(false);
      await expect(partials).rejects.toBeInstanceOf(Error);
    } finally {
      releasePartial();
      await partials.catch(() => undefined);
    }
  });

  it('后续外层批次的 partial 也会继承 pipeline signal 并在失败时取消', async () => {
    let secondPartialStarted!: () => void;
    const secondPartialStartedPromise = new Promise<void>((resolve) => {
      secondPartialStarted = resolve;
    });
    let releaseSecondPartial!: () => void;
    const secondPartialGate = new Promise<void>((resolve) => {
      releaseSecondPartial = resolve;
    });
    let secondPartialSignal: CancellationSignal | undefined;
    let secondPartialAborted = false;
    let secondPartialCommitted = false;

    const waitForPipelineAbort = (signal?: CancellationSignal): Promise<void> => (
      new Promise<void>((resolve) => {
        if (!signal) {
          secondPartialGate.then(() => {
            secondPartialCommitted = true;
            resolve();
          });
          return;
        }

        if (signal.aborted) {
          secondPartialAborted = true;
          resolve();
          return;
        }

        const onAbort = (): void => {
          secondPartialAborted = true;
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort);
      })
    );

    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        if (!userPrompt.includes('<subtitles>')) {
          const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          if (sourceText.includes('fatal sentence')) {
            await secondPartialStartedPromise;
            const error = new Error('HTTP 401 Unauthorized') as Error & { status: number };
            error.name = 'ApiRequestError';
            error.status = 401;
            throw error;
          }
          return sourceText;
        }

        const subtitles = readSubtitleMap(userPrompt);
        return JSON.stringify(
          Object.fromEntries(
            Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
          )
        );
      },
    };

    const secondText = `${Array.from({ length: 300 }, () => 'secondword').join(' ')}.`;
    const session = new TranslationSession({
      ...createConfig(),
      threadNum: 3,
      batchSize: 10,
    }, chatCompletion);
    const translation = session.translate(
      {
        subtitles: [
          {
            index: 1,
            startTime: 0,
            endTime: 10_000,
            text: `${Array.from({ length: 79 }, () => 'firstword').join(' ')}.`,
          },
          { index: 2, startTime: 10_000, endTime: 50_000, text: secondText },
          { index: 3, startTime: 50_000, endTime: 51_000, text: 'fatal sentence.' },
        ],
      },
      {
        onPartialResult: async (partial, signal) => {
          if (!partial.english.some(entry => entry.text.includes('secondword'))) return;

          secondPartialSignal = signal;
          secondPartialStarted();
          await waitForPipelineAbort(signal);
          if (!signal?.aborted) {
            secondPartialCommitted = true;
          }
        },
      }
    );

    try {
      await secondPartialStartedPromise;
      const settledBeforeRelease = await Promise.race([
        translation.then(() => true, () => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);

      expect(settledBeforeRelease).toBe(true);
      expect(secondPartialSignal).toBeDefined();
      expect(secondPartialAborted).toBe(true);
      expect(secondPartialCommitted).toBe(false);
      await expect(translation).rejects.toMatchObject({
        name: 'ApiRequestError',
        status: 401,
      });
    } finally {
      releaseSecondPartial();
      await translation.catch(() => undefined);
    }
  });

  it('返回完整有序结果，partial 只作为观察结果且保持批次顺序', async () => {
    const chatCompletion = new FakeChatCompletionAdapter();
    const session = new TranslationSession(
      createConfig(),
      chatCompletion
    );
    const partialStartTimes: number[] = [];

    const result = await session.translate(
      {
        subtitles: [
          createLongSubtitle('first', 0, 10_000),
          createLongSubtitle('second', 20_000, 30_000),
        ],
      },
      {
        onPartialResult: (partial) => {
          partialStartTimes.push(partial.english[0].startTime);
        },
      }
    );

    expect(partialStartTimes).toHaveLength(2);
    expect(chatCompletion.splitCompletionOrder).toEqual(['second', 'first']);
    expect(partialStartTimes).toEqual([...partialStartTimes].sort((a, b) => a - b));
    expect(result.english.length).toBeGreaterThan(0);
    expect(result.chinese).toHaveLength(result.english.length);
    expect(result.english.map((entry) => entry.startTime)).toEqual(
      [...result.english]
        .sort((a, b) => a.startTime - b.startTime)
        .map((entry) => entry.startTime)
    );
    expect(result.chinese.every((entry) => entry.text.startsWith('译:'))).toBe(true);
  });

  it('final result 与按顺序观察到的 partial result 一致', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    const observedEnglish: SubtitleEntry[] = [];
    const observedChinese: SubtitleEntry[] = [];

    const result = await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'first sentence.' },
          { index: 2, startTime: 1_000, endTime: 2_000, text: 'second sentence.' },
        ],
      },
      {
        onPartialResult: (partial) => {
          observedEnglish.push(...partial.english);
          observedChinese.push(...partial.chinese);
        },
      }
    );

    expect(result).toEqual({
      english: observedEnglish,
      chinese: observedChinese,
    });
  });

  it('全局 Chat 并发上限覆盖断句和并行翻译子批', async () => {
    let activeRequests = 0;
    let peakRequests = 0;

    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        activeRequests++;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));

        try {
          if (!options.responseFormat) {
            const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
            return sourceText.replace(/([.!?])\s+/g, '$1<br>');
          }

          const subtitles = readSubtitleMap(userPrompt);
          return JSON.stringify(
            Object.fromEntries(
              Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
            )
          );
        } finally {
          activeRequests--;
        }
      },
    };

    const config = { ...createConfig(), threadNum: 2, batchSize: 1 };
    const session = new TranslationSession(config, chatCompletion);
    const result = await session.translate({
      subtitles: [{
        index: 1,
        startTime: 0,
        endTime: 4_000,
        text: 'One sentence. Two sentence. Three sentence. Four sentence.',
      }],
    });

    expect(result.english).toHaveLength(4);
    expect(peakRequests).toBeGreaterThan(1);
    expect(peakRequests).toBeLessThanOrEqual(2);
  });

  it('多个 translation session 共享同一 Chat 并发上限', async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        activeRequests++;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          if (!options.responseFormat) {
            return userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          }
          const subtitles = readSubtitleMap(userPrompt);
          return JSON.stringify(
            Object.fromEntries(
              Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
            )
          );
        } finally {
          activeRequests--;
        }
      },
    };
    const config = {
      ...createConfig(),
      openaiBaseUrl: 'https://shared-gate.example/v1',
      model: 'shared-gate-model',
      threadNum: 1,
    };

    await Promise.all([
      new TranslationSession(config, chatCompletion).translate({
        subtitles: [{ index: 1, startTime: 0, endTime: 1_000, text: 'first sentence.' }],
      }),
      new TranslationSession(config, chatCompletion).translate({
        subtitles: [{ index: 1, startTime: 0, endTime: 1_000, text: 'second sentence.' }],
      }),
    ]);

    expect(peakRequests).toBe(1);
  });

  it('不同 host 或 model 的 translation session 也共享同一 Chat 并发上限', async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        activeRequests++;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          if (!options.responseFormat) {
            return userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          }
          const subtitles = readSubtitleMap(userPrompt);
          return JSON.stringify(
            Object.fromEntries(
              Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
            )
          );
        } finally {
          activeRequests--;
        }
      },
    };

    await Promise.all([
      new TranslationSession({
        ...createConfig(),
        openaiBaseUrl: 'https://host-a.example/v1',
        model: 'model-a',
        threadNum: 1,
      }, chatCompletion).translate({
        subtitles: [{ index: 1, startTime: 0, endTime: 1_000, text: 'first sentence.' }],
      }),
      new TranslationSession({
        ...createConfig(),
        openaiBaseUrl: 'https://host-b.example/v1',
        model: 'model-b',
        threadNum: 1,
      }, chatCompletion).translate({
        subtitles: [{ index: 1, startTime: 0, endTime: 1_000, text: 'second sentence.' }],
      }),
    ]);

    expect(peakRequests).toBe(1);
  });

  it('首批翻译子批完成后立即通知 partial，不等待更慢的子批', async () => {
    let resolveSlowStarted!: () => void;
    let releaseSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      resolveSlowStarted = resolve;
    });
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let resolveFirstPartial!: () => void;
    const firstPartial = new Promise<void>((resolve) => {
      resolveFirstPartial = resolve;
    });

    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        if (!options.responseFormat) {
          return 'first sentence.<br>slow sentence.<br>third sentence.';
        }

        const subtitles = readSubtitleMap(userPrompt);
        if (Object.values(subtitles).some(text => text.includes('slow sentence'))) {
          resolveSlowStarted();
          await slowGate;
        }

        return JSON.stringify(
          Object.fromEntries(
            Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
          )
        );
      },
    };

    const session = new TranslationSession({
      ...createConfig(),
      threadNum: 3,
      batchSize: 1,
    }, chatCompletion);
    const translation = session.translate({
      subtitles: [{
        index: 1,
        startTime: 0,
        endTime: 3_000,
        text: 'first sentence. slow sentence. third sentence.',
      }],
    }, {
      onPartialResult: (partial) => {
        if (partial.english[0]?.text === 'first sentence.') {
          resolveFirstPartial();
        }
      },
    });

    try {
      await slowStarted;
      const partialArrivedBeforeTimeout = await Promise.race([
        firstPartial.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);
      expect(partialArrivedBeforeTimeout).toBe(true);
    } finally {
      releaseSlow();
      await translation;
    }
  });

  it('同一个翻译 session 不会为每个子批重复探测不支持的 JSON Schema', async () => {
    let schemaRequestCount = 0;
    let translationRequestCount = 0;
    const chatCompletion: ChatCompletionPort = {
      async callChat(_systemPrompt, userPrompt, options = {}) {
        if (options.responseFormat?.type === 'json_schema') {
          schemaRequestCount++;
          throw Object.assign(new Error('response_format json_schema unsupported'), { status: 400 });
        }
        if (!options.responseFormat) {
          const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
          return sourceText.replace(/([.!?])\s+/g, '$1<br>');
        }
        translationRequestCount++;
        const subtitles = readSubtitleMap(userPrompt);
        return JSON.stringify(
          Object.fromEntries(
            Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
          )
        );
      },
    };
    const session = new TranslationSession({
      ...createConfig(),
      openaiBaseUrl: 'https://format-probe.example/v1',
      model: 'format-probe-model',
      threadNum: 4,
      batchSize: 1,
    }, chatCompletion);

    await session.translate({
      subtitles: [
        { index: 1, startTime: 0, endTime: 1_000, text: 'One.' },
        { index: 2, startTime: 1_000, endTime: 2_000, text: 'Two.' },
        { index: 3, startTime: 2_000, endTime: 3_000, text: 'Three.' },
        { index: 4, startTime: 3_000, endTime: 4_000, text: 'Four.' },
      ],
    });

    expect(schemaRequestCount).toBeLessThanOrEqual(1);
    expect(translationRequestCount).toBe(4);
  });

  it('只发送一次 complete progress', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    const steps: string[] = [];

    await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'one sentence.' },
        ],
      },
      {
        onProgress: (step) => {
          steps.push(step);
        },
      }
    );

    expect(steps.filter((step) => step === 'complete')).toHaveLength(1);
  });

  it('记录从翻译会话开始到结束的总耗时', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const session = new TranslationSession(
        createConfig(),
        new FakeChatCompletionAdapter()
      );

      await session.translate({
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'one sentence.' },
        ],
      });

      expect(consoleLog.mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('[translation-session] 翻译会话总耗时:')
      )).toBe(true);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('观察器失败不会改变翻译会话的最终结果', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );

    const result = await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'one sentence.' },
        ],
      },
      {
        onProgress: () => {
          throw new Error('progress observer failed');
        },
        onPartialResult: () => {
          throw new Error('partial observer failed');
        },
      }
    );

    expect(result.english).toHaveLength(1);
    expect(result.chinese[0].text).toBe('译:one sentence');
  });

  it('空字幕和已取消请求通过 interface 返回明确错误', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    await expect(session.translate({ subtitles: [] })).rejects.toThrow(
      'SRT文件为空，无法进行翻译'
    );

    const cancelledSignal: CancellationSignal = {
      aborted: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    await expect(
      session.translate({
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'subtitle' },
        ],
        signal: cancelledSignal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
