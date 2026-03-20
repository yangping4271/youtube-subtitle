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
  it('在常见闭合标签损坏时先修补再解析', async () => {
    let callCount = 0;
    const client = {
      async callChat(): Promise<string> {
        callCount += 1;
        return [
          '<1>第一句</1>',
          '<2>第二句</2',
          '<3>第三句</4>',
        ].join('\n');
      },
    };

    const translator = new Translator(client, createConfig());
    const result = await translator.translate({
      '1': 'first',
      '2': 'second',
      '3': 'third',
    });

    expect(callCount).toBe(1);
    expect(result.map((item) => item.translation)).toEqual(['第一句', '第二句', '第三句']);
  });
});
