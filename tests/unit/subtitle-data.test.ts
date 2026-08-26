/**
 * subtitle-data.ts 单元测试
 */

import { SubtitleData } from '../../src/core/subtitle-data.js';
import type { SubtitleEntry } from '../../src/types/index.js';

describe('SubtitleData', () => {
  describe('splitToWordSegments', () => {
    it('应该将句子分割成单词，并保留标点作为单独的单词', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 3000,
          text: "Hello world. How are you?"
        }
      ];

      const data = new SubtitleData(input);
      const result = data.splitToWordSegments();
      const segments = result.getSegments();

      // 应该包含: Hello, world, ., How, are, you, ?
      expect(segments.length).toBe(7);
      expect(segments[0].text).toBe('Hello');
      expect(segments[1].text).toBe('world');
      expect(segments[2].text).toBe('.');
      expect(segments[3].text).toBe('How');
      expect(segments[4].text).toBe('are');
      expect(segments[5].text).toBe('you');
      expect(segments[6].text).toBe('?');
    });

    it('应该为每个单词和标点分配时间戳', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 1000,
          text: "Hi."
        }
      ];

      const data = new SubtitleData(input);
      const result = data.splitToWordSegments();
      const segments = result.getSegments();

      expect(segments.length).toBe(2);
      expect(segments[0].text).toBe('Hi');
      expect(segments[0].startTime).toBe(0);
      expect(segments[0].endTime).toBeGreaterThan(0);
      expect(segments[0].endTime).toBeLessThanOrEqual(1000);

      expect(segments[1].text).toBe('.');
      expect(segments[1].startTime).toBeGreaterThanOrEqual(0);
      expect(segments[1].endTime).toBe(1000);
    });

    it('短片段中的所有 token 都保持正时长', () => {
      const segments = new SubtitleData([{
        index: 1,
        startTime: 0,
        endTime: 100,
        text: 'one two three four',
      }]).splitToWordSegments().getSegments();

      expect(segments).toHaveLength(4);
      expect(segments.every(segment => segment.endTime > segment.startTime)).toBe(true);
      expect(segments.at(-1)?.endTime).toBe(100);
    });

    it('应该处理多种标点符号', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 2000,
          text: "Hello, world! How are you?"
        }
      ];

      const data = new SubtitleData(input);
      const result = data.splitToWordSegments();
      const segments = result.getSegments();

      const texts = segments.map(s => s.text);
      expect(texts).toContain(',');
      expect(texts).toContain('!');
      expect(texts).toContain('?');
    });

    it('应该处理连续的标点符号', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 1000,
          text: "Wait... Really?!"
        }
      ];

      const data = new SubtitleData(input);
      const result = data.splitToWordSegments();
      const segments = result.getSegments();

      const texts = segments.map(s => s.text);
      expect(texts).toContain('Wait');
      expect(texts).toContain('.');
      expect(texts).toContain('Really');
      expect(texts).toContain('?');
      expect(texts).toContain('!');
    });

    it('应该保留模型版本号、小数和语义版本号中的点号', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 3000,
          text: 'GPT-5.6 uses Python 3.12.1 and scores 9.8.'
        }
      ];

      const segments = new SubtitleData(input).splitToWordSegments().getSegments();
      const texts = segments.map(segment => segment.text);

      expect(texts).toContain('5.6');
      expect(texts).toContain('3.12.1');
      expect(texts).toContain('9.8');
      expect(texts.filter(text => text === '.')).toHaveLength(1);
    });

    it('应该完整保留百分比 token', () => {
      const input: SubtitleEntry[] = [
        {
          index: 1,
          startTime: 0,
          endTime: 3000,
          text: '30% increased to 95% while GPT-5.6 stayed stable.'
        }
      ];

      const texts = new SubtitleData(input)
        .splitToWordSegments()
        .getSegments()
        .map(segment => segment.text);

      expect(texts).toContain('30%');
      expect(texts).toContain('95%');
      expect(texts).toContain('5.6');
    });

    it('应该过滤整段声音提示，但保留其他方括号文本', () => {
      const input: SubtitleEntry[] = [
        { index: 1, startTime: 0, endTime: 100, text: '[music]' },
        { index: 2, startTime: 100, endTime: 200, text: '[React]' },
        { index: 3, startTime: 200, endTime: 300, text: '(snorts)' },
        { index: 4, startTime: 300, endTime: 400, text: 'works' },
      ];

      const texts = new SubtitleData(input)
        .splitToWordSegments()
        .getSegments()
        .map(segment => segment.text);

      expect(texts).toEqual(['React', 'works']);
    });
  });
});
