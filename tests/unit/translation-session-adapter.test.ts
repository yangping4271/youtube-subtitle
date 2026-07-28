import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BilingualSubtitles,
  TranslatorConfig,
} from '../../src/types/index.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  buildTranslatorConfig: vi.fn(),
  sessionCtor: vi.fn(),
  sessionTranslate: vi.fn(),
  clientCtor: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock('../../src/extension/config.js', () => ({
  loadConfig: mocks.loadConfig,
  buildTranslatorConfig: mocks.buildTranslatorConfig,
}));

vi.mock('../../src/core/translation-session.js', () => ({
  TranslationSession: mocks.sessionCtor,
}));

vi.mock('../../src/services/openai-client.js', () => ({
  OpenAIClient: mocks.clientCtor,
}));

import { TranslationSessionAdapter } from '../../src/extension/translator.js';

function createConfig(model: string): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: 'test-key',
    model,
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2,
  };
}

const coreResult: BilingualSubtitles = {
  english: [
    { index: 1, startTime: 1_000, endTime: 2_000, text: 'hello' },
  ],
  chinese: [
    { index: 1, startTime: 1_000, endTime: 2_000, text: '你好' },
  ],
};

describe('TranslationSessionAdapter interface', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.sessionCtor.mockImplementation(function MockTranslationSession() {
      return { translate: mocks.sessionTranslate };
    });
    mocks.clientCtor.mockImplementation(function MockChatCompletionAdapter() {
      return {};
    });
    mocks.sessionTranslate.mockResolvedValue(coreResult);
    mocks.buildTranslatorConfig.mockImplementation((apiConfig) =>
      createConfig(apiConfig?.llmModel || 'default-model')
    );

    (globalThis as typeof globalThis & {
      chrome?: {
        storage: {
          local: {
            set: typeof mocks.storageSet;
            remove: typeof mocks.storageRemove;
          };
        };
      };
    }).chrome = {
      storage: {
        local: {
          set: mocks.storageSet,
          remove: mocks.storageRemove,
        },
      },
    };
  });

  it('每个 session 都加载最新配置并创建新的生产 adapter', async () => {
    mocks.loadConfig
      .mockResolvedValueOnce(createConfig('old-model'))
      .mockResolvedValueOnce(createConfig('new-model'));
    const adapter = new TranslationSessionAdapter();
    const request = {
      subtitles: [{ startTime: 0, endTime: 1, text: 'hello world' }],
    };

    await adapter.translate(request);
    await adapter.translate(request);

    expect(mocks.loadConfig).toHaveBeenCalledTimes(2);
    expect(mocks.clientCtor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'old-model' })
    );
    expect(mocks.clientCtor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'new-model' })
    );
    expect(mocks.sessionCtor).toHaveBeenCalledTimes(2);
  });

  it('请求对象中的配置优先于 storage 配置', async () => {
    const adapter = new TranslationSessionAdapter();

    await adapter.translate({
      subtitles: [{ startTime: 0, endTime: 1, text: 'hello world' }],
      apiConfig: { llmModel: 'request-model', openaiApiKey: 'test-key' },
    });

    expect(mocks.buildTranslatorConfig).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'request-model' })
    );
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.sessionCtor).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'request-model' }),
      expect.anything()
    );
  });

  it('通过同一个 interface 转换时间单位并返回完整结果', async () => {
    mocks.loadConfig.mockResolvedValue(createConfig('model'));
    const adapter = new TranslationSessionAdapter();
    const partials: BilingualSubtitles[] = [];
    mocks.sessionTranslate.mockImplementation(async (_request, observer) => {
      await observer.onPartialResult(coreResult);
      return coreResult;
    });

    const result = await adapter.translate(
      {
        subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
        videoTitle: 'video title',
      },
      {
        onPartialResult: (partial) => {
          partials.push(partial);
        },
      }
    );

    expect(mocks.sessionTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        subtitles: [
          { index: 1, startTime: 1_000, endTime: 2_000, text: 'hello' },
        ],
        videoTitle: 'video title',
      }),
      expect.anything()
    );
    expect(result.english[0]).toMatchObject({ startTime: 1, endTime: 2 });
    expect(partials[0].chinese[0]).toMatchObject({ startTime: 1, endTime: 2 });
    expect(mocks.storageRemove).toHaveBeenCalledWith('translationProgress');
  });

  it('进度存储失败不会阻断外部观察器和最终结果', async () => {
    mocks.loadConfig.mockResolvedValue(createConfig('model'));
    mocks.storageSet.mockRejectedValue(new Error('storage unavailable'));
    const onProgress = vi.fn();
    mocks.sessionTranslate.mockImplementation(async (_request, observer) => {
      await observer.onProgress('translate', 1, 1);
      return coreResult;
    });

    const result = await new TranslationSessionAdapter().translate(
      {
        subtitles: [{ startTime: 1, endTime: 2, text: 'hello' }],
      },
      { onProgress }
    );

    expect(onProgress).toHaveBeenCalledWith('translate', 1, 1);
    expect(result.english).toHaveLength(1);
  });
});
