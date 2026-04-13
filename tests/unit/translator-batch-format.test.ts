import { describe, expect, it } from 'vitest';
import { Translator } from '../../src/core/translator.js';
import type { ChatOptions, TranslatorConfig } from '../../src/types/index.js';

function createConfig(): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: 'test-key',
    model: 'gpt-4o',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
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
  it('JSON Schema 不兼容时降级到 JSON，并沿用 JSON', async () => {
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
    expect(calls[1]?.options?.responseFormat).toBeUndefined();
    expect(calls[2]?.options?.responseFormat).toBeUndefined();
    expect(calls[1]?.systemPrompt).toContain('Return a single JSON object');
    expect(calls[2]?.systemPrompt).toContain('Return a single JSON object');
  });

  it('JSON 解析失败时降级到 XML，并沿用 XML', async () => {
    const { client, calls } = createClient([
      new Error('response_format json_schema is not supported'),
      'not-json-at-all',
      '<1>第一句</1>\n<2>第二句</2>',
      '<1>后续</1>\n<2>沿用XML</2>',
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
    expect(secondResult.map(item => item.translation)).toEqual(['后续', '沿用XML']);

    expect(calls).toHaveLength(4);
    expect(calls[0]?.options?.responseFormat?.type).toBe('json_schema');
    expect(calls[1]?.systemPrompt).toContain('Return a single JSON object');
    expect(calls[2]?.systemPrompt).toContain('Return translations using XML-style numbered tags');
    expect(calls[3]?.systemPrompt).toContain('Return translations using XML-style numbered tags');
  });
});
