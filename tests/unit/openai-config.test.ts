import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/extension/config.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { TranslatorConfig } from '../../src/types/index.js';

function createConfig(overrides: Partial<TranslatorConfig> = {}): TranslatorConfig {
  return {
    openaiBaseUrl: 'http://127.0.0.1:1234/v1',
    openaiApiKey: '',
    model: 'gemma-4-e4b-it',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
    ...overrides,
  };
}

describe('local OpenAI-compatible config', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('允许空 API Key 的配置通过校验', () => {
    const errors = validateConfig(createConfig());
    expect(errors).toEqual([]);
  });

  it('空 API Key 时不发送 Authorization 请求头', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig());
    const result = await client.callChat('system', 'user');

    expect(result).toBe('translated content');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });
});
