import { describe, expect, it } from 'vitest';
import { Translator } from '../../src/core/translator.js';
import type { ChatOptions, TranslatorConfig } from '../../src/types/index.js';

function createConfig(overrides: Partial<TranslatorConfig> = {}): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: 'test-key',
    model: 'gpt-4o',
    providerType: 'openai',
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

function createClient(responses: Array<string | Error>) {
  const calls: Array<{ systemPrompt: string; userPrompt: string; options?: ChatOptions }> = [];

  return {
    calls,
    client: {
      async callChat(systemPrompt: string, userPrompt: string, options?: ChatOptions): Promise<string> {
        calls.push({ systemPrompt, userPrompt, options });
        const next = responses.shift();
        if (next instanceof Error) {
          throw next;
        }
        if (typeof next !== 'string') {
          throw new Error('No mock response available');
        }
        return next;
      },
    },
  };
}

describe('Translator batch output format fallback', () => {
  it('JSON Schema 不兼容时降级到 JSON Object，并沿用 JSON Object', async () => {
    const { client, calls } = createClient([
      new Error('response_format json_schema is not supported'),
      '{"1":"第一句","2":"第二句"}',
      '{"1":"再次翻译","2":"第二次"}',
    ]);

    const translator = new Translator(client, createConfig());

    const firstResult = await translator.translate({
      '1': 'first',
      '2': 'second',
    });
    const secondResult = await translator.translate({
      '1': 'first',
      '2': 'second',
    });

    expect(firstResult.map(item => item.translation)).toEqual(['第一句', '第二句']);
    expect(secondResult.map(item => item.translation)).toEqual(['再次翻译', '第二次']);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
    expect(calls[1]?.options?.responseFormat?.type).toBe('json_object');
    expect(calls[2]?.options?.responseFormat?.type).toBe('json_object');
    expect(calls[1]?.systemPrompt).toContain('Return a single JSON object');
    expect(calls[2]?.systemPrompt).toContain('Return a single JSON object');
  });

  it('普通内容解析失败时只重试相同格式，不降级为其他输出格式', async () => {
    const { client, calls } = createClient([
      'not-json-at-all',
      'still-not-json',
      '第一句',
      '第二句',
    ]);

    const translator = new Translator(client, createConfig());

    const result = await translator.translate({
      '1': 'first',
      '2': 'second',
    });

    expect(result.map(item => item.translation)).toEqual(['第一句', '第二句']);

    expect(calls).toHaveLength(4);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
    expect(calls[1]?.options?.responseFormat?.type).toBe('json_schema');
    expect(calls.slice(2).every(call => call.options?.responseFormat === undefined)).toBe(true);
  });

  it('无关参数的 400 错误不会被误判为 response_format 不兼容', async () => {
    const parameterError = new Error(
      'invalid parameter: temperature; request included response_format=json_schema'
    ) as Error & { status: number; parsedBody: unknown };
    parameterError.name = 'ApiRequestError';
    parameterError.status = 400;
    parameterError.parsedBody = {
      error: {
        message: 'invalid parameter: temperature',
        param: 'temperature',
        code: 'invalid_parameter',
      },
    };

    const { client, calls } = createClient([
      parameterError,
      '{"1":"不应发送第二种格式"}',
    ]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
  });

  it('正文顺带提到 response_format 时不会把其他参数错误降级', async () => {
    const unrelatedUnsupportedError = new Error(
      'unsupported parameter: temperature; request included response_format=json_schema'
    ) as Error & { status: number; parsedBody: unknown };
    unrelatedUnsupportedError.name = 'ApiRequestError';
    unrelatedUnsupportedError.status = 400;
    unrelatedUnsupportedError.parsedBody = {
      error: {
        message: 'unsupported parameter: temperature; request included response_format=json_schema',
        code: 'unsupported_parameter',
      },
    };

    const { client, calls } = createClient([
      unrelatedUnsupportedError,
      '{"1":"不应发送第二种格式"}',
    ]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it('逗号连接的无关参数错误也不能触发 response_format 降级', async () => {
    const unrelatedUnsupportedError = new Error(
      'unsupported parameter: temperature, request included response_format=json_schema'
    ) as Error & { status: number; parsedBody: unknown };
    unrelatedUnsupportedError.name = 'ApiRequestError';
    unrelatedUnsupportedError.status = 400;
    unrelatedUnsupportedError.parsedBody = {
      error: {
        message: 'unsupported parameter: temperature, request included response_format=json_schema',
        code: 'unsupported_parameter',
      },
    };

    const { client, calls } = createClient([
      unrelatedUnsupportedError,
      '{"1":"不应发送第二种格式"}',
    ]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it('response_format 参数对应的 schema 内容无效时不降级格式', async () => {
    const schemaError = new Error('invalid JSON schema: required field missing') as Error & {
      status: number;
      parsedBody: unknown;
    };
    schemaError.name = 'ApiRequestError';
    schemaError.status = 400;
    schemaError.parsedBody = {
      error: {
        message: 'invalid JSON schema: required field missing',
        param: 'response_format',
        code: 'invalid_json_schema',
      },
    };

    const { client, calls } = createClient([
      schemaError,
      '{"1":"不应降级"}',
    ]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
  });

  it.each([400, 422])(
    '明确的格式不支持错误（HTTP %s）可以降级到 JSON Object',
    async (status) => {
      const unsupportedError = new Error(
        'response_format=json_schema, unsupported for this model'
      ) as Error & { status: number; parsedBody: unknown };
      unsupportedError.name = 'ApiRequestError';
      unsupportedError.status = status;
      unsupportedError.parsedBody = {
        error: {
          message: 'response_format=json_schema, unsupported for this model',
          param: 'response_format',
          code: 'unsupported_model_format',
        },
      };

      const { client, calls } = createClient([
        unsupportedError,
        '{"1":"降级成功"}',
      ]);
      const translator = new Translator(client, createConfig());

      await expect(translator.translate({ '1': 'first' })).resolves.toMatchObject([
        { translation: '降级成功' },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
      expect(calls[1]?.options?.responseFormat?.type).toBe('json_object');
    }
  );

  it('明确的 unknown parameter: response_format 错误可以降级', async () => {
    const unsupportedError = new Error(
      'unknown parameter: response_format'
    ) as Error & { status: number; parsedBody: unknown };
    unsupportedError.name = 'ApiRequestError';
    unsupportedError.status = 400;
    unsupportedError.parsedBody = {
      error: {
        message: 'unknown parameter: response_format',
        code: 'unknown_parameter',
      },
    };

    const { client, calls } = createClient([
      unsupportedError,
      '{"1":"降级成功"}',
    ]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).resolves.toMatchObject([
      { translation: '降级成功' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options?.responseFormat?.type).toBe('json_object');
  });

  it.each([401, 403, 404])(
    'HTTP %s 即使携带 response_format 字段也不触发格式降级',
    async (status) => {
      const authError = new Error('response_format is not supported') as Error & {
        status: number;
        parsedBody: unknown;
      };
      authError.name = 'ApiRequestError';
      authError.status = status;
      authError.parsedBody = {
        error: {
          message: 'response_format is not supported',
          param: 'response_format',
          code: 'unsupported_response_format',
        },
      };

      const { client, calls } = createClient([
        authError,
        '{"1":"不应发送第二次请求"}',
      ]);
      const translator = new Translator(client, createConfig());

      await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
        name: 'ApiRequestError',
        status,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
    }
  );

  it('DeepSeek 直接优先使用 JSON Object', async () => {
    const { client, calls } = createClient([
      '{"1":"第一句","2":"第二句"}',
    ]);

    const translator = new Translator(client, createConfig({ providerType: 'deepseek' }));

    const result = await translator.translate({
      '1': 'first',
      '2': 'second',
    });

    expect(result.map(item => item.translation)).toEqual(['第一句', '第二句']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_object');
  });

  it('遇到 API 限流时直接向上抛出，不继续触发格式降级和单条并发请求', async () => {
    const rateLimitError = new Error('请求过于频繁') as Error & { status: number };
    rateLimitError.name = 'ApiRequestError';
    rateLimitError.status = 429;
    const { client, calls } = createClient([rateLimitError]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'first' })).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toHaveLength(1);
  });

  it('遇到 API 鉴权错误时直接向上抛出，不返回空翻译', async () => {
    const authError = new Error('HTTP 401 Unauthorized: invalid api key (request_id=req-401)') as Error & {
      status: number;
    };
    authError.name = 'ApiRequestError';
    authError.status = 401;
    const { client, calls } = createClient([authError]);
    const translator = new Translator(client, createConfig());

    await expect(translator.translate({ '1': 'hello' })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });
});
