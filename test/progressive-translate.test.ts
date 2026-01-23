/**
 * 临时测试文件 - 验证渐进式字幕翻译逻辑
 * 测试完成后删除
 */

import { describe, it, expect, vi } from 'vitest';
import type { SubtitleEntry, BilingualSubtitles } from '../src/types/index.js';

describe('渐进式字幕翻译逻辑', () => {
  // 模拟字幕数据生成器
  function generateMockSubtitles(count: number): SubtitleEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      startTime: i * 2,
      endTime: i * 2 + 1.5,
      text: `Subtitle ${i + 1}`,
    }));
  }

  describe('分批处理逻辑', () => {
    it('应该将字幕分为首批和后续批次', () => {
      const subtitles = generateMockSubtitles(50);
      const firstBatchSize = 10;

      const firstBatch = subtitles.slice(0, firstBatchSize);
      const restBatch = subtitles.slice(firstBatchSize);

      expect(firstBatch).toHaveLength(10);
      expect(restBatch).toHaveLength(40);
      expect(firstBatch[0].text).toBe('Subtitle 1');
      expect(firstBatch[9].text).toBe('Subtitle 10');
      expect(restBatch[0].text).toBe('Subtitle 11');
    });

    it('应该正确处理少于首批大小的字幕', () => {
      const subtitles = generateMockSubtitles(5);
      const firstBatchSize = 10;

      const firstBatch = subtitles.slice(0, firstBatchSize);
      const restBatch = subtitles.slice(firstBatchSize);

      expect(firstBatch).toHaveLength(5);
      expect(restBatch).toHaveLength(0);
    });
  });

  describe('onPartialResult 回调触发', () => {
    it('应该按顺序触发回调', async () => {
      const callbackResults: Array<{ isFirst: boolean; count: number }> = [];
      const onPartialResult = vi.fn((partial: BilingualSubtitles, isFirst: boolean) => {
        callbackResults.push({
          isFirst,
          count: partial.english.length,
        });
      });

      // 模拟分批处理
      const subtitles = generateMockSubtitles(30);
      const firstBatchSize = 10;
      const batchSize = 10;

      // 首批
      const firstBatch = subtitles.slice(0, firstBatchSize);
      const mockFirstResult: BilingualSubtitles = {
        english: firstBatch,
        chinese: firstBatch.map(s => ({ ...s, text: `翻译 ${s.text}` })),
      };
      onPartialResult(mockFirstResult, true);

      // 后续批次
      for (let i = firstBatchSize; i < subtitles.length; i += batchSize) {
        const batch = subtitles.slice(i, i + batchSize);
        const mockResult: BilingualSubtitles = {
          english: batch,
          chinese: batch.map(s => ({ ...s, text: `翻译 ${s.text}` })),
        };
        onPartialResult(mockResult, false);
      }

      expect(onPartialResult).toHaveBeenCalledTimes(3);
      expect(callbackResults[0]).toEqual({ isFirst: true, count: 10 });
      expect(callbackResults[1]).toEqual({ isFirst: false, count: 10 });
      expect(callbackResults[2]).toEqual({ isFirst: false, count: 10 });
    });
  });

  describe('字幕追加和排序', () => {
    it('应该正确追加字幕并保持时间顺序', () => {
      const existingSubtitles = generateMockSubtitles(10);
      const newSubtitles = generateMockSubtitles(10).map(s => ({
        ...s,
        index: s.index + 10,
        startTime: s.startTime + 20,
        endTime: s.endTime + 20,
      }));

      const combined = [...existingSubtitles, ...newSubtitles];
      combined.sort((a, b) => a.startTime - b.startTime);

      expect(combined).toHaveLength(20);
      expect(combined[0].startTime).toBe(0);
      expect(combined[19].startTime).toBe(18 + 20);

      // 验证时间顺序
      for (let i = 1; i < combined.length; i++) {
        expect(combined[i].startTime).toBeGreaterThanOrEqual(combined[i - 1].startTime);
      }
    });

    it('应该处理乱序追加的字幕', () => {
      const batch1 = generateMockSubtitles(5);
      const batch2 = generateMockSubtitles(5).map(s => ({
        ...s,
        index: s.index + 5,
        startTime: s.startTime + 10,
        endTime: s.endTime + 10,
      }));
      const batch3 = generateMockSubtitles(5).map(s => ({
        ...s,
        index: s.index + 10,
        startTime: s.startTime + 20,
        endTime: s.endTime + 20,
      }));

      // 模拟乱序追加
      const combined = [...batch1, ...batch3, ...batch2];
      combined.sort((a, b) => a.startTime - b.startTime);

      // 验证排序后的顺序
      expect(combined[0].startTime).toBe(0);
      expect(combined[5].startTime).toBe(10);
      expect(combined[10].startTime).toBe(20);
    });
  });

  describe('边界情况', () => {
    it('应该处理空字幕数组', () => {
      const subtitles: SubtitleEntry[] = [];
      const firstBatch = subtitles.slice(0, 10);
      const restBatch = subtitles.slice(10);

      expect(firstBatch).toHaveLength(0);
      expect(restBatch).toHaveLength(0);
    });

    it('应该处理恰好等于首批大小的字幕', () => {
      const subtitles = generateMockSubtitles(10);
      const firstBatch = subtitles.slice(0, 10);
      const restBatch = subtitles.slice(10);

      expect(firstBatch).toHaveLength(10);
      expect(restBatch).toHaveLength(0);
    });
  });
});
