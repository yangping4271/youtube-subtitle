/**
 * punctuation.ts 单元测试
 */

import { normalizeChinesePunctuation } from '../../src/utils/punctuation.js';

describe('normalizeChinesePunctuation', () => {
  it('应该保留中文句内标点，只删除行尾弱标点', () => {
    expect(normalizeChinesePunctuation('您将学习如何构建记忆系统，赋予智能体长期记忆。')).toBe(
      '您将学习如何构建记忆系统，赋予智能体长期记忆'
    );
  });

  it('应该补齐中文和英文/数字之间的空格', () => {
    expect(normalizeChinesePunctuation('谢谢Andrew，今天介绍Oracle AI数据库2种用法。')).toBe(
      '谢谢 Andrew，今天介绍 Oracle AI 数据库 2 种用法'
    );
  });

  it('应该保留问号和感叹号', () => {
    expect(normalizeChinesePunctuation('这是什么？')).toBe('这是什么？');
    expect(normalizeChinesePunctuation('太好了！')).toBe('太好了！');
  });
});
