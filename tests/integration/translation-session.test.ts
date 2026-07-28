import { describe, expect, it } from 'vitest';

import {
  TranslationSession,
  type ChatCompletionPort,
} from '../../src/core/translation-session.js';
import type {
  ChatOptions,
  SubtitleEntry,
  TranslatorConfig,
} from '../../src/types/index.js';
import type { CancellationSignal } from '../../src/utils/cancellation.js';

function createConfig(): TranslatorConfig {
  return {
    openaiBaseUrl: 'https://example.test/v1',
    openaiApiKey: 'test-key',
    model: 'test-model',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2,
  };
}

function readSubtitleMap(userPrompt: string): Record<string, string> {
  const match = userPrompt.match(/<subtitles>([\s\S]*?)<\/subtitles>/);
  if (!match) {
    throw new Error('fake adapter 未找到字幕 JSON');
  }
  return JSON.parse(match[1]) as Record<string, string>;
}

class FakeChatCompletionAdapter implements ChatCompletionPort {
  readonly splitCompletionOrder: string[] = [];

  async callChat(
    _systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): Promise<string> {
    if (!options.responseFormat) {
      const sourceText = userPrompt.slice(userPrompt.lastIndexOf('\n') + 1);
      if (sourceText.includes('first 0')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      this.splitCompletionOrder.push(sourceText.includes('first 0') ? 'first' : 'second');
      const words = sourceText.split(/\s+/);
      const sentences: string[] = [];
      for (let index = 0; index < words.length; index += 10) {
        sentences.push(words.slice(index, index + 10).join(' '));
      }
      return sentences.join('<br>');
    }

    const subtitles = readSubtitleMap(userPrompt);
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(subtitles).map(([key, text]) => [key, `译:${text}`])
      )
    );
  }
}

function createLongSubtitle(
  prefix: string,
  startTime: number,
  endTime: number
): SubtitleEntry {
  return {
    index: 1,
    startTime,
    endTime,
    text: Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`).join(' '),
  };
}

describe('TranslationSession interface', () => {
  it('返回完整有序结果，partial 只作为观察结果且保持批次顺序', async () => {
    const chatCompletion = new FakeChatCompletionAdapter();
    const session = new TranslationSession(
      createConfig(),
      chatCompletion
    );
    const partialStartTimes: number[] = [];

    const result = await session.translate(
      {
        subtitles: [
          createLongSubtitle('first', 0, 10_000),
          createLongSubtitle('second', 20_000, 30_000),
        ],
      },
      {
        onPartialResult: (partial) => {
          partialStartTimes.push(partial.english[0].startTime);
        },
      }
    );

    expect(partialStartTimes).toHaveLength(2);
    expect(chatCompletion.splitCompletionOrder).toEqual(['second', 'first']);
    expect(partialStartTimes).toEqual([...partialStartTimes].sort((a, b) => a - b));
    expect(result.english.length).toBeGreaterThan(0);
    expect(result.chinese).toHaveLength(result.english.length);
    expect(result.english.map((entry) => entry.startTime)).toEqual(
      [...result.english]
        .sort((a, b) => a.startTime - b.startTime)
        .map((entry) => entry.startTime)
    );
    expect(result.chinese.every((entry) => entry.text.startsWith('译:'))).toBe(true);
  });

  it('final result 与按顺序观察到的 partial result 一致', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    const observedEnglish: SubtitleEntry[] = [];
    const observedChinese: SubtitleEntry[] = [];

    const result = await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'first sentence.' },
          { index: 2, startTime: 1_000, endTime: 2_000, text: 'second sentence.' },
        ],
      },
      {
        onPartialResult: (partial) => {
          observedEnglish.push(...partial.english);
          observedChinese.push(...partial.chinese);
        },
      }
    );

    expect(result).toEqual({
      english: observedEnglish,
      chinese: observedChinese,
    });
  });

  it('只发送一次 complete progress', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    const steps: string[] = [];

    await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'one sentence.' },
        ],
      },
      {
        onProgress: (step) => {
          steps.push(step);
        },
      }
    );

    expect(steps.filter((step) => step === 'complete')).toHaveLength(1);
  });

  it('观察器失败不会改变翻译会话的最终结果', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );

    const result = await session.translate(
      {
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'one sentence.' },
        ],
      },
      {
        onProgress: () => {
          throw new Error('progress observer failed');
        },
        onPartialResult: () => {
          throw new Error('partial observer failed');
        },
      }
    );

    expect(result.english).toHaveLength(1);
    expect(result.chinese[0].text).toBe('译:one sentence');
  });

  it('空字幕和已取消请求通过 interface 返回明确错误', async () => {
    const session = new TranslationSession(
      createConfig(),
      new FakeChatCompletionAdapter()
    );
    await expect(session.translate({ subtitles: [] })).rejects.toThrow(
      'SRT文件为空，无法进行翻译'
    );

    const cancelledSignal: CancellationSignal = {
      aborted: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    await expect(
      session.translate({
        subtitles: [
          { index: 1, startTime: 0, endTime: 1_000, text: 'subtitle' },
        ],
        signal: cancelledSignal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
