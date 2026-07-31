import { describe, expect, it } from 'vitest';

import { buildPlainTextTranscript } from '../../src/core/transcript-text.js';

describe('buildPlainTextTranscript', () => {
  it('将单词级字幕连接为连续的纯文本，而不是每个单词一行', () => {
    expect(buildPlainTextTranscript([
      { startTime: 0, endTime: 0.5, text: 'One' },
      { startTime: 0.5, endTime: 1, text: 'word' },
      { startTime: 1, endTime: 1.5, text: 'per' },
      { startTime: 1.5, endTime: 2, text: 'line.' },
    ])).toBe('One word per line.');
  });

  it('清理字幕片段内部的换行和多余空白', () => {
    expect(buildPlainTextTranscript([
      { startTime: 0, endTime: 1, text: '  Hello\n  world  ' },
      { startTime: 1, endTime: 2, text: '' },
      { startTime: 2, endTime: 3, text: 'from\tYouTube' },
    ])).toBe('Hello world from YouTube');
  });
});
