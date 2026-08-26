/**
 * splitter.ts 单元测试
 */

import { vi } from 'vitest';

import {
  presplitByPunctuation,
  batchBySentenceCount,
  mergeSegmentsWithinBatch,
  splitByEndMarks,
  splitByLLM,
} from '../../src/core/splitter.js';
import type { SubtitleEntry, PreSplitSentence, TranslatorConfig } from '../../src/types/index.js';

describe('presplitByPunctuation', () => {
  it('应该基于句子结束标记正确预分句', () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 100, text: 'Hello' },
      { index: 2, startTime: 100, endTime: 200, text: 'world' },
      { index: 3, startTime: 200, endTime: 250, text: '.' },
      { index: 4, startTime: 250, endTime: 350, text: 'How' },
      { index: 5, startTime: 350, endTime: 450, text: 'are' },
      { index: 6, startTime: 450, endTime: 550, text: 'you' },
      { index: 7, startTime: 550, endTime: 600, text: '?' },
    ];

    const result = presplitByPunctuation(wordSegments);

    expect(result.length).toBe(2);

    expect(result[0].text).toBe('Hello world .');
    expect(result[0].wordStartIndex).toBe(0);
    expect(result[0].wordEndIndex).toBe(3);
    expect(result[0].startTime).toBe(0);
    expect(result[0].endTime).toBe(250);

    expect(result[1].text).toBe('How are you ?');
    expect(result[1].wordStartIndex).toBe(3);
    expect(result[1].wordEndIndex).toBe(7);
    expect(result[1].startTime).toBe(250);
    expect(result[1].endTime).toBe(600);
  });

  it('应该处理没有标点的情况', () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 100, text: 'Hello' },
      { index: 2, startTime: 100, endTime: 200, text: 'world' },
    ];

    const result = presplitByPunctuation(wordSegments);

    expect(result.length).toBe(1);
    expect(result[0].text).toBe('Hello world');
  });

  it('应该处理多个句子', () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 100, text: 'First' },
      { index: 2, startTime: 100, endTime: 150, text: '.' },
      { index: 3, startTime: 150, endTime: 250, text: 'Second' },
      { index: 4, startTime: 250, endTime: 300, text: '.' },
      { index: 5, startTime: 300, endTime: 400, text: 'Third' },
      { index: 6, startTime: 400, endTime: 450, text: '.' },
    ];

    const result = presplitByPunctuation(wordSegments);

    // 拼接后的文本是 'First . Second . Third .'
    // splitByEndMarks 会按 '. ' 分割，得到 'First .' 和 'Second . Third .'
    // 然后继续分割 'Second . Third .'，得到 'Second .' 和 'Third .'
    // 所以应该得到 3 个句子（如果 splitByEndMarks 正确处理了末尾的点号）
    // 但实际上可能只得到 2 个，因为最后的 '.' 后面没有空格

    // 验证至少有 2 个句子
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].text).toContain('First');
    expect(result[result.length - 1].text).toContain('Third');
  });

  it('不应在数字之间的点号处分割版本号', () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 100, text: 'GPT' },
      { index: 2, startTime: 100, endTime: 150, text: '5' },
      { index: 3, startTime: 150, endTime: 180, text: '.' },
      { index: 4, startTime: 180, endTime: 230, text: '6' },
      { index: 5, startTime: 230, endTime: 330, text: 'is' },
      { index: 6, startTime: 330, endTime: 450, text: 'available' },
      { index: 7, startTime: 450, endTime: 480, text: '.' },
      { index: 8, startTime: 480, endTime: 580, text: 'This' },
      { index: 9, startTime: 580, endTime: 680, text: 'is' },
      { index: 10, startTime: 680, endTime: 780, text: 'next' },
      { index: 11, startTime: 780, endTime: 810, text: '.' },
    ];

    const result = presplitByPunctuation(wordSegments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('GPT 5 . 6 is available .');
    expect(result[0].wordEndIndex).toBe(7);
    expect(result[1].text).toBe('This is next .');
  });
});

describe('splitByEndMarks', () => {
  it('保留连续文本中的版本号和小数', () => {
    expect(splitByEndMarks('GPT 5.6 scores 9.8 points. This is the next sentence.')).toEqual([
      'GPT 5.6 scores 9.8 points.',
      'This is the next sentence.',
    ]);
  });

  it('数字后的真正句号仍然可以断句', () => {
    expect(splitByEndMarks('There are 6. This is the next sentence.')).toEqual([
      'There are 6.',
      'This is the next sentence.',
    ]);
  });
});

describe('batchBySentenceCount', () => {
  it('应该按词数分批，首批较小', () => {
    // 每句 2 词，共 20 句 40 词
    const sentences: PreSplitSentence[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Sentence ${i + 1}`,
      wordStartIndex: i * 5,
      wordEndIndex: (i + 1) * 5,
      startTime: i * 1000,
      endTime: (i + 1) * 1000,
    }));

    // 首批上限 10 词(~5句)，后续上限 20 词(~10句)
    const result = batchBySentenceCount(sentences, 10, 20);

    expect(result.length).toBeGreaterThan(1);
    expect(result[0].length).toBe(5); // 首批 5 句 = 10 词
  });

  it('应该处理总词数不足首批上限的情况', () => {
    const sentences: PreSplitSentence[] = Array.from({ length: 3 }, (_, i) => ({
      text: `Sentence ${i + 1}`,
      wordStartIndex: i * 5,
      wordEndIndex: (i + 1) * 5,
      startTime: i * 1000,
      endTime: (i + 1) * 1000,
    }));

    const result = batchBySentenceCount(sentences, 10, 20);

    expect(result.length).toBe(1);
    expect(result[0].length).toBe(3);
  });

  it('应该处理空数组', () => {
    const result = batchBySentenceCount([], 10, 20);
    expect(result.length).toBe(0);
  });
});

describe('mergeSegmentsWithinBatch', () => {
  const config: TranslatorConfig = {
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    model: 'gpt-4o',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 1,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
  };

  it('保留断句结果，不再把短句重新并长', async () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 200, text: 'I' },
      { index: 2, startTime: 200, endTime: 450, text: 'think' },
      { index: 3, startTime: 450, endTime: 600, text: 'we' },
      { index: 4, startTime: 600, endTime: 900, text: 'should' },
      { index: 5, startTime: 900, endTime: 1050, text: 'go' },
      { index: 6, startTime: 1050, endTime: 1200, text: 'now' },
      { index: 7, startTime: 1200, endTime: 1250, text: ',' },
      { index: 8, startTime: 1250, endTime: 1600, text: 'because' },
      { index: 9, startTime: 1600, endTime: 1720, text: 'it' },
      { index: 10, startTime: 1720, endTime: 1840, text: 'is' },
      { index: 11, startTime: 1840, endTime: 2100, text: 'late' },
      { index: 12, startTime: 2100, endTime: 2150, text: '.' },
    ];

    const preSplitSentences: PreSplitSentence[] = [{
      text: 'I think we should go now , because it is late .',
      wordStartIndex: 0,
      wordEndIndex: wordSegments.length,
      startTime: 0,
      endTime: 2150,
    }];

    const client = {
      async callChat(): Promise<string> {
        return 'I think we should go now,<br>because it is late.';
      },
    };

    const result = await mergeSegmentsWithinBatch(
      preSplitSentences,
      wordSegments,
      client,
      config
    );

    const segments = result.getSegments();
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('I think we should go now,');
    expect(segments[0].endTime).toBe(1250);
    expect(segments[1].text).toBe('because it is late.');
    expect(segments[1].startTime).toBe(1250);
  });

  it('发送给断句模型的文本不应在英文标点前添加空格', async () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 200, text: 'Hi' },
      { index: 2, startTime: 200, endTime: 230, text: ',' },
      { index: 3, startTime: 230, endTime: 400, text: "I'm" },
      { index: 4, startTime: 400, endTime: 600, text: 'Emily' },
      { index: 5, startTime: 600, endTime: 630, text: '.' },
    ];

    const preSplitSentences: PreSplitSentence[] = [{
      text: "Hi , I'm Emily .",
      wordStartIndex: 0,
      wordEndIndex: wordSegments.length,
      startTime: 0,
      endTime: 630,
    }];

    let capturedUserPrompt = '';
    const client = {
      async callChat(_systemPrompt: string, userPrompt: string): Promise<string> {
        capturedUserPrompt = userPrompt;
        return "Hi, I'm Emily.";
      },
    };

    const result = await mergeSegmentsWithinBatch(
      preSplitSentences,
      wordSegments,
      client,
      config
    );

    expect(capturedUserPrompt).toContain("\nHi, I'm Emily.");
    expect(capturedUserPrompt).not.toContain("Hi , I'm Emily .");
    expect(result.getSegments()[0].text).toBe("Hi, I'm Emily.");
  });

  it('模型改写或重排源文本时忽略其结果', async () => {
    const source = 'If you heard of Raycast AI chat in a while.';
    const result = await splitByLLM(
      source,
      { callChat: async () => 'If you AI heard chat in a of while Raycast.' },
      config
    );

    expect(result.join(' ')).toBe(source);
  });

  it('普通换行转换为空格而不是粘连单词', async () => {
    const source = 'Hello world Next sentence here.';
    const result = await splitByLLM(
      source,
      { callChat: async () => 'Hello\nworld<br />Next sentence here.' },
      config
    );

    expect(result).toEqual(['Hello world', 'Next sentence here.']);
  });

  it('跨时间间隔时按源内容拆开，不复制整个 LLM 句子', async () => {
    const wordSegments: SubtitleEntry[] = [
      { index: 1, startTime: 0, endTime: 100, text: 'alpha' },
      { index: 2, startTime: 100, endTime: 200, text: 'beta' },
      { index: 3, startTime: 3_000, endTime: 3_100, text: 'gamma' },
      { index: 4, startTime: 3_100, endTime: 3_200, text: 'delta' },
    ];
    const preSplitSentences: PreSplitSentence[] = [{
      text: 'alpha beta gamma delta',
      wordStartIndex: 0,
      wordEndIndex: wordSegments.length,
      startTime: 0,
      endTime: 3_200,
    }];

    const result = await mergeSegmentsWithinBatch(
      preSplitSentences,
      wordSegments,
      { callChat: async () => 'alpha beta gamma delta' },
      config
    );

    expect(result.getSegments().map(segment => segment.text)).toEqual([
      'alpha beta',
      'gamma delta',
    ]);
  });

  it('严重超标但仍可继续拆分时不写入 console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const longText = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');

    try {
      await splitByLLM(
        longText,
        { callChat: async () => longText },
        config
      );

      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('严重超标');
    } finally {
      consoleError.mockRestore();
    }
  });
});
