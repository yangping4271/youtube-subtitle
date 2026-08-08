import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTranslatorConfig,
  getApiHostPermissionPattern,
  getModelConcurrencyLimit,
  isDefaultApiProviderId,
  normalizeApiBaseUrl,
  normalizeApiConfig,
  validateConfig,
} from '../../src/extension/config.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { TranslatorConfig } from '../../src/types/index.js';
import { formatApiResponseError } from '../../src/utils/error-handler.js';

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

  it('按模型动态应用并发上限', () => {
    expect(getModelConcurrencyLimit('deepseek-v4-flash')).toBe(2500);
    expect(getModelConcurrencyLimit('deepseek-v4-pro')).toBe(500);
    expect(getModelConcurrencyLimit('unknown-model')).toBeUndefined();

    const unknownConfig = normalizeApiConfig({
      activeProviderId: 'unknown',
      providers: [{
        id: 'unknown',
        name: 'Unknown',
        providerType: 'custom',
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: '',
        llmModel: 'unknown-model',
        threadNum: 9999,
      }],
    });
    expect(unknownConfig.threadNum).toBe(9999);

    const flashConfig = normalizeApiConfig({
      activeProviderId: 'flash',
      providers: [{
        id: 'flash',
        name: 'DeepSeek Flash',
        providerType: 'deepseek',
        openaiBaseUrl: 'https://api.deepseek.com',
        openaiApiKey: '',
        llmModel: 'deepseek-v4-flash',
        threadNum: 9999,
      }],
    });
    expect(flashConfig.threadNum).toBe(2500);

    const proConfig = normalizeApiConfig({
      activeProviderId: 'pro',
      providers: [{
        id: 'pro',
        name: 'DeepSeek Pro',
        providerType: 'deepseek',
        openaiBaseUrl: 'https://api.deepseek.com',
        openaiApiKey: '',
        llmModel: 'deepseek-v4-pro',
        threadNum: 9999,
      }],
    });
    expect(proConfig.threadNum).toBe(500);
  });

  it('默认三个供应商始终存在，且自定义供应商不会被覆盖', () => {
    const config = normalizeApiConfig({
      activeProviderId: 'local',
      providers: [{
        id: 'local',
        name: '本地模型',
        openaiBaseUrl: 'http://127.0.0.1:1234/v1',
        openaiApiKey: '',
        llmModel: 'local-model',
        threadNum: 3,
      }],
    });

    expect(config.providers?.map(provider => provider.id)).toEqual([
      'openai',
      'openrouter',
      'deepseek',
      'local',
    ]);
    expect(config.providers?.filter(provider => isDefaultApiProviderId(provider.id))).toHaveLength(3);
    expect(config.activeProviderId).toBe('local');
  });

  it('OpenAI 只填写域名时自动补全实际 Base URL', () => {
    expect(normalizeApiBaseUrl('https://api.openai.com', 'openai'))
      .toBe('https://api.openai.com/v1');
    expect(normalizeApiBaseUrl('https://api.openai.com/v1/', 'openai'))
      .toBe('https://api.openai.com/v1');
    expect(normalizeApiBaseUrl('https://api.krill-ai.net/codex/v1', 'custom'))
      .toBe('https://api.krill-ai.net/codex/v1');
    expect(normalizeApiBaseUrl('https://api.deepseek.com', 'deepseek'))
      .toBe('https://api.deepseek.com');
  });

  it('OpenAI 客户端会使用补全后的 /v1/chat/completions 地址', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.openai.com',
      providerType: 'openai',
    }));

    await expect(client.callChat('system', 'user')).resolves.toBe('ok');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
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

  it('将第三方 API 地址转换为按域名申请的 host permission', () => {
    expect(getApiHostPermissionPattern('https://api.krill-ai.net/codex/v1'))
      .toBe('https://api.krill-ai.net/*');
    expect(getApiHostPermissionPattern('https://example.com:8443/v1/'))
      .toBe('https://example.com:8443/*');
  });

  it('拒绝非 HTTPS 的第三方 API 地址', () => {
    expect(() => getApiHostPermissionPattern('http://192.168.31.18:8012/v1'))
      .toThrow('第三方 API 必须使用 HTTPS');
  });

  it('保留 API HTTP 状态、响应正文和 request ID，且 400 不重复重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: {
        get: (name: string) => {
          const header = name.toLowerCase();
          if (header === 'x-request-id') return 'req-400';
          if (header === 'retry-after') return '0';
          return null;
        },
      },
      text: async () => JSON.stringify({
        error: { message: 'invalid_request_error: bad request' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig({
      openaiBaseUrl: 'https://api.krill-ai.net/codex/v1',
      model: 'gpt-5.6-luna',
    }));

    let error: Error | undefined;
    try {
      await client.callChat('system', 'user');
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain('HTTP 400 Bad Request');
    expect(error?.message).toContain('request_id=req-400');
    expect((error as Error & { retryAfterMs?: number })?.retryAfterMs).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('测试连接错误同时显示 HTTP 状态、正文和 request ID', async () => {
    const response = new Response('plain upstream error', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'x-request-id': 'req-test-502' },
    });

    await expect(formatApiResponseError(response)).resolves.toContain('HTTP 502 Bad Gateway');
    await expect(formatApiResponseError(new Response('plain upstream error', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'x-request-id': 'req-test-502' },
    }))).resolves.toMatch(/plain upstream error|request_id=req-test-502/);
  });

  it('保留结构化响应的完整 raw body 和正文 request_id', async () => {
    const responseBody = {
      error: {
        message: 'bad request',
        type: 'invalid_request_error',
        code: 'bad_code',
      },
      request_id: 'body-req',
      diagnostic: {
        upstream: 'details',
      },
    };
    const rawBody = JSON.stringify(responseBody);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: {
        get: () => null,
      },
      text: async () => rawBody,
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient(createConfig());
    let error: (Error & { rawBody?: string; requestId?: string }) | undefined;
    try {
      await client.callChat('system', 'user');
    } catch (caught) {
      error = caught as Error & { rawBody?: string; requestId?: string };
    }

    expect(error?.requestId).toBe('body-req');
    expect(error?.rawBody).toBe(rawBody);
    expect(error?.message).toContain('bad_code');
    expect(error?.message).toContain('details');
    expect(error?.message).toContain('body-req');
  });

  it.each(['deepseek-v4-flash', 'deepseek-chat', 'custom-deepseek-model'])(
    'DeepSeek 供应商的任意模型都发送关闭思考模式参数: %s',
    async (model) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'translated content' } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new OpenAIClient(createConfig({
        openaiBaseUrl: 'https://api.deepseek.com',
        model,
        providerType: 'deepseek',
      }));
      await client.callChat('system', 'user');

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body).not.toHaveProperty('reasoning');
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  );

  it.each(['openai/gpt-4o-mini', 'google/gemini-flash', 'qwen/qwen3'])(
    'OpenRouter 的任意模型都发送关闭 reasoning 参数: %s',
    async (model) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'translated content' } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new OpenAIClient(createConfig({
        openaiBaseUrl: 'https://openrouter.ai/api/v1',
        model,
        providerType: 'openrouter',
      }));
      await client.callChat('system', 'user');

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.reasoning).toEqual({ effort: 'none' });
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  );

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
    ['OpenAI 非推理模型', 'https://api.openai.com/v1', 'openai', 'gpt-4o-mini'],
    ['自定义 Gemini 端点', 'https://example.com/v1', 'custom', 'gemini-3-flash'],
    ['本地 Qwen 端点', 'http://127.0.0.1:1234/v1', 'custom', 'Qwen3.6-35B-A3B'],
    ['未知兼容模型', 'https://third-party.example/v1', 'custom', 'vendor/model'],
  ] as const)(
    '%s始终发送 reasoning_effort none',
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

  it('旧配置不能通过 disableThinking false 重新开启思考模式', async () => {
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
      disableThinking: false,
    }));
    await client.callChat('system', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning_effort).toBe('none');
  });

  it.each([
    [
      'OpenAI-compatible',
      'https://compatible.example/v1',
      'custom',
      "Unsupported parameter: 'reasoning_effort'",
      'reasoning_effort',
    ],
    [
      'OpenRouter',
      'https://openrouter.ai/api/v1',
      'openrouter',
      "Unknown parameter: 'reasoning'",
      'reasoning',
    ],
    [
      'DeepSeek',
      'https://api.deepseek.com',
      'deepseek',
      "Parameter 'thinking' is not supported",
      'thinking',
    ],
  ] as const)(
    '%s 不支持关闭参数时移除该参数并按默认模式继续',
    async (_name, openaiBaseUrl, providerType, errorMessage, parameterName) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({
            error: { message: errorMessage },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'translated with default thinking' } }],
          }),
        });
      vi.stubGlobal('fetch', fetchMock);

      const client = new OpenAIClient(createConfig({
        openaiBaseUrl,
        model: 'legacy-reasoning-model',
        providerType,
      }));

      await expect(client.callChat('system', 'user'))
        .resolves.toBe('translated with default thinking');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const fallbackBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(firstBody).toHaveProperty(parameterName);
      expect(fallbackBody).not.toHaveProperty('reasoning_effort');
      expect(fallbackBody).not.toHaveProperty('reasoning');
      expect(fallbackBody).not.toHaveProperty('thinking');
    }
  );

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
      openaiBaseUrl: 'https://api.openai.com',
      llmModel: 'gpt-4o-mini',
      disableThinking: true,
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

    const savedProvider = config.providers?.find(provider => provider.id === 'saved-provider');
    const newProvider = config.providers?.find(provider => provider.id === 'new-provider');
    expect(savedProvider).toMatchObject({
      openaiBaseUrl: 'https://saved.example/v1',
      openaiApiKey: 'saved-key',
      llmModel: 'saved-model',
    });
    expect(newProvider).toMatchObject({
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

  it('允许同一供应商类型保存多个独立配置', () => {
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

    expect(config.providers).toHaveLength(4);
    expect(config.activeProviderId).toBe('openrouter-custom');
    expect(config.openaiApiKey).toBe('second-key');
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
