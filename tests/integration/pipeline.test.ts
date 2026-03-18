/**
 * 集成测试 - 完整的流水线翻译流程
 */

import { SubtitleData } from '../../src/core/subtitle-data.js';
import { presplitByPunctuation, batchBySentenceCount } from '../../src/core/splitter.js';
import type { SubtitleEntry } from '../../src/types/index.js';

describe('流水线翻译集成测试', () => {
  it('应该完整处理从原始字幕到分批的流程', () => {
    // 1. 原始字幕（带标点）
    const originalSubtitles: SubtitleEntry[] = [
      {
        index: 1,
        startTime: 0,
        endTime: 3000,
        text: "Hello world. How are you? I'm fine."
      },
      {
        index: 2,
        startTime: 3000,
        endTime: 6000,
        text: "Thank you! What about you? Great to hear."
      }
    ];

    // 2. 转换为单词级（应该保留标点）
    const subtitleData = new SubtitleData(originalSubtitles);
    const wordSegments = subtitleData.splitToWordSegments();
    const words = wordSegments.getSegments();

    // 验证：应该包含单词和标点
    const texts = words.map(w => w.text);
    expect(texts).toContain('Hello');
    expect(texts).toContain('world');
    expect(texts).toContain('.');
    expect(texts).toContain('How');
    expect(texts).toContain('?');

    // 3. 预分句
    const preSplitSentences = presplitByPunctuation(words);

    // 验证：应该分成多个句子
    expect(preSplitSentences.length).toBeGreaterThan(1);

    // 验证：每个预分句应该有正确的索引范围
    for (const sentence of preSplitSentences) {
      expect(sentence.wordStartIndex).toBeGreaterThanOrEqual(0);
      expect(sentence.wordEndIndex).toBeGreaterThan(sentence.wordStartIndex);
      expect(sentence.wordEndIndex).toBeLessThanOrEqual(words.length);
      expect(sentence.startTime).toBeGreaterThanOrEqual(0);
      expect(sentence.endTime).toBeGreaterThan(sentence.startTime);
    }

    // 4. 分批
    const batches = batchBySentenceCount(preSplitSentences, 15, 15);

    // 验证：应该有批次
    expect(batches.length).toBeGreaterThan(0);

    // 验证：所有句子都被分配到批次中
    const totalSentences = batches.reduce((sum, batch) => sum + batch.length, 0);
    expect(totalSentences).toBe(preSplitSentences.length);
  });

  it('应该处理长文本', () => {
    // 创建一个包含多个句子的长文本
    const sentences = [
      "First sentence here.",
      "Second sentence here.",
      "Third sentence here.",
      "Fourth sentence here.",
      "Fifth sentence here.",
      "Sixth sentence here.",
      "Seventh sentence here.",
      "Eighth sentence here.",
    ];

    const originalSubtitles: SubtitleEntry[] = [{
      index: 1,
      startTime: 0,
      endTime: 10000,
      text: sentences.join(' ')
    }];

    const subtitleData = new SubtitleData(originalSubtitles);
    const wordSegments = subtitleData.splitToWordSegments();
    const words = wordSegments.getSegments();

    const preSplitSentences = presplitByPunctuation(words);

    // 应该分成8个句子
    expect(preSplitSentences.length).toBe(8);

    const batches = batchBySentenceCount(preSplitSentences, 15, 15);
    const totalSentences = batches.reduce((sum, batch) => sum + batch.length, 0);

    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].length).toBeGreaterThan(0);
    expect(totalSentences).toBe(8);
  });
});
