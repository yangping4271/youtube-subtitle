import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTranslatorConfig,
  loadConfig,
  validateConfig,
} from '../../src/extension/config.js';
import { getApiHostPermissionPattern } from '../../src/extension/config-bridge.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { TranslatorConfig } from '../../src/types/index.js';
import {
  getModelConcurrencyLimit,
  migrateApiConfig,
  normalizeApiConfig,
} from '../../src/utils/api-config.js';
import {
  getApiEndpointValidationError,
  normalizeApiBaseUrl,
} from '../../src/utils/api-url.js';
import { formatApiResponseError } from '../../src/utils/error-handler.js';

function createConfig(overrides: Partial<TranslatorConfig> = {}): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://example.test/v1',
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

describe('OpenAI-compatible config', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('允许空 API Key 的配置通过校验', () => {
    const errors = validateConfig(createConfig());
    expect(errors).toEqual([]);
  });

  it('初始配置不预选模型，三个内置模型保持固定且只保留已保存的 API Key', () => {
    const config = normalizeApiConfig({
      providers: [{
        id: 'openai',
        name: '篡改的名称',
        providerType: 'custom',
        openaiBaseUrl: 'https://changed.example/v1',
        openaiApiKey: 'saved-key',
        llmModel: 'changed-model',
        threadNum: 99,
      }],
    });

    expect(config.activeProviderId).toBeUndefined();
    expect(config.requiresProviderSelection).toBe(true);
    expect(config.openaiBaseUrl).toBe('');
    expect(config.llmModel).toBe('');
    expect(config.providers?.find(provider => provider.id === 'openai')).toMatchObject({
      name: 'OpenAI',
      providerType: 'openai',
      openaiBaseUrl: 'https://api.openai.com',
      llmModel: '',
      openaiApiKey: 'saved-key',
      threadNum: 6,
    });
  });

  it('迁移旧版隐式 OpenAI 默认配置时清除选择', () => {
    const config = normalizeApiConfig({
      schemaVersion: 2,
      activeProviderId: 'openai',
      providers: [
        { id: 'openai', name: 'OpenAI', openaiBaseUrl: 'https://api.openai.com', openaiApiKey: '', llmModel: '' },
        { id: 'openrouter', name: 'OpenRouter', openaiBaseUrl: 'https://openrouter.ai/api/v1', openaiApiKey: '', llmModel: '' },
        { id: 'deepseek', name: 'DeepSeek', openaiBaseUrl: 'https://api.deepseek.com', openaiApiKey: '', llmModel: '' },
      ],
    });

    expect(config.activeProviderId).toBeUndefined();
    expect(config.requiresProviderSelection).toBe(true);
  });

  it.each([
    ['openai', 'gpt-4o-mini'],
    ['openrouter', 'openai/gpt-4o-mini'],
    ['deepseek', 'deepseek-v4-flash'],
  ])('迁移旧版 %s 内置模型时清空模型名并阻止翻译', (id, legacyModel) => {
    const config = normalizeApiConfig({
      schemaVersion: 3,
      activeProviderId: id,
      providers: [{
        id,
        name: id,
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: 'key',
        llmModel: legacyModel,
      }],
    });

    expect(config.providers?.find(provider => provider.id === id)?.llmModel).toBe('');
    expect(() => buildTranslatorConfig(config)).toThrow('翻译模型未配置');
  });

  it('升级 schema 时保留内置供应商由用户填写的模型和自定义并发数', () => {
    const config = normalizeApiConfig({
      schemaVersion: 4,
      activeProviderId: 'openai',
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        openaiBaseUrl: 'https://api.openai.com',
        openaiApiKey: 'key',
        llmModel: 'gpt-5.6',
        threadNum: 8,
      }],
    });

    expect(config.providers?.find(provider => provider.id === 'openai')).toMatchObject({
      llmModel: 'gpt-5.6',
      threadNum: 8,
    });
    expect(buildTranslatorConfig(config)).toMatchObject({ model: 'gpt-5.6', threadNum: 8 });
  });

  it('把上一版仍为旧默认值 3 的并发数迁移为 6', () => {
    const config = normalizeApiConfig({
      schemaVersion: 4,
      activeProviderId: 'openai',
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        openaiBaseUrl: 'https://api.openai.com',
        openaiApiKey: 'key',
        llmModel: 'gpt-5.6',
        threadNum: 3,
      }],
    });

    expect(config.schemaVersion).toBe(5);
    expect(config.providers?.find(provider => provider.id === 'openai')).toMatchObject({
      llmModel: 'gpt-5.6',
      threadNum: 6,
    });
    expect(buildTranslatorConfig(config)).toMatchObject({
      model: 'gpt-5.6',
      threadNum: 6,
    });
  });

  it('拒绝未填写模型名的自定义供应商进入翻译配置', () => {
    expect(() => buildTranslatorConfig({
      activeProviderId: 'custom',
      providers: [{
        id: 'custom',
        name: 'Custom',
        providerType: 'custom',
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: 'key',
        llmModel: '',
      }],
    })).toThrow('翻译模型未配置');
  });

  it('自定义供应商模型为空时优先提示模型未配置', () => {
    expect(() => buildTranslatorConfig({
      activeProviderId: 'custom',
      providers: [{
        id: 'custom',
        name: 'Custom',
        providerType: 'custom',
        openaiBaseUrl: 'http://127.0.0.1:1234/v1',
        openaiApiKey: 'key',
        llmModel: '',
      }],
    })).toThrow('翻译模型未配置');
  });

  it.each([undefined, null])('自定义供应商缺失或损坏的模型名也提示模型未配置', (llmModel) => {
    expect(() => buildTranslatorConfig({
      activeProviderId: 'custom',
      providers: [{
        id: 'custom',
        name: 'Custom',
        providerType: 'custom',
        openaiBaseUrl: 'http://127.0.0.1:1234/v1',
        openaiApiKey: 'key',
        llmModel,
      }],
    } as unknown as Parameters<typeof buildTranslatorConfig>[0])).toThrow('翻译模型未配置');
  });

  it('自定义供应商缺失类型且 URL 为 null 时提示填写 Base URL', () => {
    expect(() => buildTranslatorConfig({
      activeProviderId: 'custom',
      providers: [{
        id: 'custom',
        name: 'Custom',
        openaiBaseUrl: null,
        openaiApiKey: 'key',
        llmModel: 'model',
      }],
    } as unknown as Parameters<typeof buildTranslatorConfig>[0]))
      .toThrow('自定义模型必须填写 API Base URL 和翻译模型');
  });

  it('拒绝带有内置 providerType 的不完整自定义供应商进入翻译配置', () => {
    expect(() => buildTranslatorConfig({
      activeProviderId: 'custom-router',
      providers: [{
        id: 'custom-router',
        name: 'Custom Router',
        providerType: 'openrouter',
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: 'key',
        llmModel: '',
      }],
    })).toThrow('翻译模型未配置');
  });

  it.each([
    'http://127.0.0.1:1234/v1',
    'http://localhost:1234/v1',
    'https://192.168.31.18:1234/v1',
  ])('配置校验接受兼容 API 地址: %s', (openaiBaseUrl) => {
    expect(validateConfig(createConfig({ openaiBaseUrl }))).toEqual([]);
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

  it('迁移时保留兼容供应商', () => {
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
    expect(config.activeProviderId).toBe('local');
    expect(config.requiresProviderSelection).toBe(false);

    const migration = migrateApiConfig({
      activeProviderId: 'local',
      providers: [{
        id: 'local',
        name: '本地模型',
        openaiBaseUrl: 'http://127.0.0.1:1234/v1',
        openaiApiKey: '',
        llmModel: 'local-model',
      }],
    });
    expect(migration.removedProviderIds).toEqual([]);
    expect(migration.requiresProviderSelection).toBe(false);
    expect(migration.changed).toBe(true);
    expect(buildTranslatorConfig(migration.config)).toMatchObject({
      openaiBaseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
    });
  });

  it('迁移混合 provider 时保留全部兼容配置', () => {
    const migration = migrateApiConfig({
      schemaVersion: 1,
      activeProviderId: 'remote',
      providers: [
        {
          id: 'local',
          name: '本地模型',
          openaiBaseUrl: 'http://127.0.0.1:1234/v1',
          openaiApiKey: 'local-key',
          llmModel: 'local-model',
          threadNum: 2,
        },
        {
          id: 'remote',
          name: '远程 API',
          openaiBaseUrl: 'https://remote.example/v1',
          openaiApiKey: 'remote-key',
          llmModel: 'remote-model',
          threadNum: 7,
        },
      ],
      targetLanguage: 'ja',
    });

    expect(migration.config).toMatchObject({
      activeProviderId: 'remote',
      openaiBaseUrl: 'https://remote.example/v1',
      openaiApiKey: 'remote-key',
      llmModel: 'remote-model',
      threadNum: 7,
      targetLanguage: 'ja',
    });
    expect(migration.config.providers?.some(provider => provider.id === 'local')).toBe(true);
    expect(migration.requiresProviderSelection).toBe(false);
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
    expect(getApiHostPermissionPattern('http://127.0.0.1:1234/v1'))
      .toBe('http://127.0.0.1:1234/*');
    expect(getApiHostPermissionPattern('http://localhost:1234/v1'))
      .toBe('http://localhost:1234/*');
  });

  it('拒绝非 HTTPS 的第三方 API 地址', () => {
    expect(() => getApiHostPermissionPattern('http://192.168.31.18:8012/v1'))
      .toThrow('第三方 API 必须使用 HTTPS');
  });

  it.each([
    'https://localhost/v1',
    'https://127.0.0.1:1234/v1',
    'https://192.168.31.18:8012/v1',
    'https://printer.local/v1',
    'https://fc.example.com/v1',
    'https://[2606:4700:4700::1111]/v1',
    'https://8.8.8.8/v1',
  ])('接受 HTTPS API 地址: %s', (baseUrl) => {
    expect(getApiEndpointValidationError(baseUrl)).toBeNull();
  });

  it('存储中的兼容 provider 可直接加载', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((_keys: string[], callback: (value: Record<string, unknown>) => void) => {
            callback({
              apiConfig: {
                activeProviderId: 'local',
                providers: [{
                  id: 'local',
                  name: '本地模型',
                  openaiBaseUrl: 'http://127.0.0.1:1234/v1',
                  openaiApiKey: '',
                  llmModel: 'local-model',
                }],
              },
            });
          }),
          set: storageSet,
        },
      },
    });

    await expect(loadConfig()).resolves.toMatchObject({
      openaiBaseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
    });
    expect(storageSet).toHaveBeenCalledWith(expect.objectContaining({
      apiConfig: expect.objectContaining({
        requiresProviderSelection: false,
        activeProviderId: 'local',
      }),
    }));
    expect(storageSet).not.toHaveBeenCalledWith(expect.objectContaining({
      apiConfigMigrationNotice: expect.anything(),
    }));
  });

  it('缺少供应商时要求选择，且不写入迁移提示', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((_keys: string[], callback: (value: Record<string, unknown>) => void) => {
            callback({ apiConfig: { openaiBaseUrl: 'http://127.0.0.1:1234/v1' } });
          }),
          set: storageSet,
        },
      },
    });

    await expect(loadConfig()).rejects.toThrow('请选择 API 供应商');
    expect(storageSet).toHaveBeenCalledWith(expect.objectContaining({
      apiConfig: expect.any(Object),
    }));
    expect(storageSet).not.toHaveBeenCalledWith(expect.objectContaining({
      apiConfigMigrationNotice: expect.anything(),
    }));
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
    ['兼容 Qwen 端点', 'http://127.0.0.1:1234/v1', 'custom', 'Qwen3.6-35B-A3B'],
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

  it('OpenAI 客户端接受兼容 API 地址', () => {
    expect(() => new OpenAIClient(createConfig({
      openaiBaseUrl: 'http://127.0.0.1:1234/v1',
    }))).not.toThrow();
  });

  it('直接构建兼容 provider 的翻译配置', () => {
    expect(buildTranslatorConfig({
      activeProviderId: 'local',
      providers: [{
        id: 'local',
        name: '本地模型',
        openaiBaseUrl: 'http://localhost:1234/v1',
        openaiApiKey: '',
        llmModel: 'local-model',
      }],
    })).toMatchObject({
      openaiBaseUrl: 'http://localhost:1234/v1',
      model: 'local-model',
    });
  });

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

  it('旧版单 API 字段不再迁移，也不预选内置供应商', () => {
    const config = normalizeApiConfig({
      openaiBaseUrl: 'http://192.168.31.18:8012/v1',
      openaiApiKey: '',
      llmModel: 'Qwen3.6-35B-A3B',
      targetLanguage: 'zh',
      threadNum: 4,
      disableThinking: true,
    });

    expect(config.activeProviderId).toBeUndefined();
    expect(config.providers).toHaveLength(3);
    expect(config.providers?.map(provider => provider.id)).toEqual(['openai', 'openrouter', 'deepseek']);
    expect(config).toMatchObject({
      openaiBaseUrl: '',
      llmModel: '',
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

    expect(() => buildTranslatorConfig(config)).toThrow('翻译模型未配置');
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
    expect(() => buildTranslatorConfig({
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
    })).toThrow('翻译模型未配置');
  });
});
