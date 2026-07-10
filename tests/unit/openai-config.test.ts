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

  it('OpenRouter 代理 URL 默认发送关闭 reasoning 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://ai-proxy.chatwise.app/openrouter/api/v1',
      model: 'openai/gpt-4o-mini',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('OpenRouter 代理 URL 会推断为 openrouter 供应商', () => {
    const config = normalizeApiConfig({
      activeProviderId: 'openrouter-proxy',
      targetLanguage: 'zh',
      providers: [
        {
          id: 'openrouter-proxy',
          name: 'OpenRouter Proxy',
          openaiBaseUrl: 'https://ai-proxy.chatwise.app/openrouter/api/v1',
          openaiApiKey: 'proxy-key',
          llmModel: 'openai/gpt-4o-mini',
          threadNum: 3,
        },
      ],
    });

    expect(config.providerType).toBe('openrouter');
    expect(config.openaiBaseUrl).toBe('https://ai-proxy.chatwise.app/openrouter/api/v1');
  });

  it.each([
    ['OpenAI 官方端点', 'https://api.openai.com/v1', 'openai', 'gpt-5.6'],
    ['自定义端点', 'https://example.com/v1', 'custom', 'gpt-6'],
    ['第三方端点', 'https://third-party.example/v1', 'custom', 'GPT-7-fast'],
  ] as const)(
    '%s使用 GPT 开头的模型时发送 reasoning_effort none',
    async (_name, openaiBaseUrl, providerType, model) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'translated content' } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new OpenAIClient(createConfig({
        openaiBaseUrl,
        model,
        providerType,
      }));
      await client.callChat('system', 'user');

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.reasoning_effort).toBe('none');
    }
  );

  it('OpenRouter 的 GPT 模型只发送 OpenRouter reasoning 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'gpt-6',
      providerType: 'openrouter',
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('非 GPT 模型不发送 GPT 思考参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'translated content' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.openai.com/v1',
      model: 'gemini-3-flash',
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

  it('保留新增供应商的空白配置，不从已有供应商填充', () => {
    const config = normalizeApiConfig({
      activeProviderId: 'new-provider',
      targetLanguage: 'zh',
      providers: [
        {
          id: 'saved-provider',
          name: '已保存供应商',
          openaiBaseUrl: 'https://saved.example/v1',
          openaiApiKey: 'saved-key',
          llmModel: 'saved-model',
          threadNum: 3,
        },
        {
          id: 'new-provider',
          name: '未命名供应商',
          openaiBaseUrl: '',
          openaiApiKey: '',
          llmModel: '',
          threadNum: 3,
        },
      ],
    });

    expect(config.providers?.[0]).toMatchObject({
      openaiBaseUrl: 'https://saved.example/v1',
      openaiApiKey: 'saved-key',
      llmModel: 'saved-model',
    });
    expect(config.providers?.[1]).toMatchObject({
      openaiBaseUrl: '',
      openaiApiKey: '',
      llmModel: '',
    });
    expect(config).toMatchObject({
      activeProviderId: 'new-provider',
      openaiBaseUrl: '',
      openaiApiKey: '',
      llmModel: '',
    });

    expect(buildTranslatorConfig(config)).toMatchObject({
      openaiBaseUrl: '',
      openaiApiKey: '',
      model: '',
      providerType: 'custom',
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
