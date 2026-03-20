import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslatorConfig, BilingualSubtitles } from '../../src/types/index.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  buildTranslatorConfig: vi.fn(),
  serviceCtor: vi.fn(),
  serviceTranslateFull: vi.fn(),
  serviceCancel: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock('../../src/extension/config.js', () => ({
  loadConfig: mocks.loadConfig,
  buildTranslatorConfig: mocks.buildTranslatorConfig,
}));

vi.mock('../../src/services/translator-service.js', () => ({
  TranslatorService: mocks.serviceCtor,
}));

import { TranslatorService as TranslatorServiceWrapper } from '../../src/extension/translator.js';

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
    maxMultiplier: 2.0,
  };
}

describe('TranslatorServiceWrapper', () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset();
    mocks.serviceCtor.mockReset();
    mocks.serviceTranslateFull.mockReset();
    mocks.serviceCancel.mockReset();
    mocks.storageSet.mockReset();
    mocks.storageRemove.mockReset();
    mocks.buildTranslatorConfig.mockReset();

    mocks.serviceCtor.mockImplementation(function MockTranslatorService() {
      return {
        translateFull: mocks.serviceTranslateFull,
        cancel: mocks.serviceCancel,
      };
    });

    mocks.serviceTranslateFull.mockResolvedValue({
      english: [],
      chinese: [],
    } satisfies BilingualSubtitles);

    mocks.buildTranslatorConfig.mockImplementation((apiConfig) => createConfig(apiConfig?.llmModel || 'default-model'));

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

  it('每次翻译都会重新加载最新配置', async () => {
    mocks.loadConfig
      .mockResolvedValueOnce(createConfig('old-model'))
      .mockResolvedValueOnce(createConfig('new-model'));

    const wrapper = new TranslatorServiceWrapper();
    const subtitles = [{ startTime: 0, endTime: 1, text: 'hello world' }];

    await wrapper.translateFull(subtitles);
    await wrapper.translateFull(subtitles);

    expect(mocks.loadConfig).toHaveBeenCalledTimes(2);
    expect(mocks.serviceCtor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'old-model' })
    );
    expect(mocks.serviceCtor).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ model: 'new-model' })
    );
  });

  it('优先使用当前请求传入的最新配置', async () => {
    mocks.loadConfig.mockResolvedValue(createConfig('stored-model'));

    const wrapper = new TranslatorServiceWrapper();
    const subtitles = [{ startTime: 0, endTime: 1, text: 'hello world' }];

    await wrapper.translateFull(
      subtitles,
      'zh',
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { llmModel: 'request-model', openaiApiKey: 'test-key' }
    );

    expect(mocks.buildTranslatorConfig).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'request-model' })
    );
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.serviceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'request-model' })
    );
  });
});
