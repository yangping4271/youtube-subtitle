import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTranslatorConfig, normalizeApiConfig, validateConfig } from '../../src/extension/config.js';
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

  it('DeepSeek V4 默认发送关闭思考模式参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      providerType: 'deepseek',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('OpenRouter 默认发送关闭 reasoning 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      providerType: 'openrouter',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('OpenAI GPT-5.1 默认发送 reasoning_effort none', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.1',
      providerType: 'openai',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning_effort).toBe('none');
  });

  it('非 reasoning 接口不发送非标准思考参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      providerType: 'openai',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('旧版单 API 字段不再迁移，直接使用预设供应商', () => {
    const config = normalizeApiConfig({
      openaiBaseUrl: 'http://192.168.31.18:8012/v1',
      openaiApiKey: '',
      llmModel: 'Qwen3.6-35B-A3B',
      targetLanguage: 'zh',
      threadNum: 4,
      disableThinking: true,
    });

    expect(config.activeProviderId).toBe('openai');
    expect(config.providers).toHaveLength(3);
    expect(config.providers?.map(provider => provider.id)).toEqual(['openai', 'openrouter', 'deepseek']);
    expect(config).toMatchObject({
      openaiBaseUrl: 'https://api.openai.com/v1',
      llmModel: 'gpt-4o-mini',
    });
  });

  it('供应商列表按内置 providerType 去重', () => {
    const config = normalizeApiConfig({
      activeProviderId: 'openrouter-custom',
      targetLanguage: 'zh',
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          providerType: 'openrouter',
          openaiBaseUrl: 'https://openrouter.ai/api/v1',
          openaiApiKey: 'first-key',
          llmModel: 'openai/gpt-4o-mini',
          threadNum: 3,
        },
        {
          id: 'openrouter-custom',
          name: 'OpenRouter Copy',
          providerType: 'openrouter',
          openaiBaseUrl: 'https://openrouter.ai/api/v1',
          openaiApiKey: 'second-key',
          llmModel: 'google/gemini-3-flash-preview',
          threadNum: 3,
        },
      ],
    });

    expect(config.providers).toHaveLength(1);
    expect(config.activeProviderId).toBe('openrouter');
    expect(config.openaiApiKey).toBe('first-key');
  });

  it('构建翻译配置时使用当前激活供应商', () => {
    const config = buildTranslatorConfig({
      activeProviderId: 'openrouter',
      targetLanguage: 'ja',
      providers: [
        {
          id: 'local',
          name: '本地模型',
          openaiBaseUrl: 'http://127.0.0.1:1234/v1',
          openaiApiKey: '',
          llmModel: 'local-model',
          threadNum: 2,
        },
        {
          id: 'openrouter',
          name: 'OpenRouter',
          providerType: 'openrouter',
          openaiBaseUrl: 'https://openrouter.ai/api/v1',
          openaiApiKey: 'router-key',
          llmModel: 'openai/gpt-4o-mini',
          threadNum: 5,
        },
      ],
    });

    expect(config).toMatchObject({
      openaiBaseUrl: 'https://openrouter.ai/api/v1',
      openaiApiKey: 'router-key',
      model: 'openai/gpt-4o-mini',
      providerType: 'openrouter',
      targetLanguage: 'ja',
      threadNum: 5,
    });
  });
});
