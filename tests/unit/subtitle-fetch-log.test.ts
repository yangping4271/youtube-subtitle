import { describe, expect, it } from 'vitest';

import {
  formatSubtitleFetchLog,
  normalizeSubtitleFetchErrorMessage,
} from '../../src/extension/subtitle-fetch-log.js';

describe('subtitle fetch log helpers', () => {
  it('格式化日志时包含回退原因和错误详情', () => {
    const message = formatSubtitleFetchLog({
      source: 'transcript-panel',
      subtitleCount: 47,
      fallbackReason: '转写接口不可用',
      transcriptApiError: '转写接口未返回可用字幕',
    }, 'pkSxISewcw8', 'https://www.youtube.com/watch?v=pkSxISewcw8');

    expect(message).toContain('source=transcript-panel');
    expect(message).toContain('subtitles=47');
    expect(message).toContain('videoId=pkSxISewcw8');
    expect(message).toContain('fallbackReason=转写接口不可用');
    expect(message).toContain('transcriptApiError=转写接口未返回可用字幕');
  });

  it('清理错误消息中的多余空白', () => {
    expect(normalizeSubtitleFetchErrorMessage('  字幕轨   返回空响应 \n 请重试  '))
      .toBe('字幕轨 返回空响应 请重试');
  });
});
