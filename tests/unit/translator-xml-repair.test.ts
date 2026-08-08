import { describe, expect, it } from 'vitest';
import { Translator } from '../../src/core/translator.js';
import type { TranslatorConfig } from '../../src/types/index.js';

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

describe('Translator XML repair', () => {
  it('普通内容解析失败时重试同一格式，不请求 XML 输出格式', async () => {
    let callCount = 0;
    const responseFormats: Array<string | undefined> = [];
    const client = {
      async callChat(_systemPrompt: string, _userPrompt: string, options: { responseFormat?: { type: string } } = {}): Promise<string> {
        callCount += 1;
        responseFormats.push(options.responseFormat?.type);
        if (options.responseFormat) {
          return [
            '<1>第一句</1>',
            '<2>第二句</2',
            '<3>第三句</4>',
          ].join('\n');
        }
        return ['第一句', '第二句', '第三句'][callCount - 3];
      },
    };

    const translator = new Translator(client, createConfig());
    const result = await translator.translate({
      '1': 'first',
      '2': 'second',
      '3': 'third',
    });

    expect(callCount).toBe(5);
    expect(responseFormats).toEqual([
      'json_schema',
      'json_schema',
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.map((item) => item.translation)).toEqual(['第一句', '第二句', '第三句']);
  });
});
