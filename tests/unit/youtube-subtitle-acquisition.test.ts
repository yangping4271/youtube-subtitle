import { describe, expect, it, vi } from 'vitest';

import {
  createYouTubeSubtitleAcquirer,
  EnglishSubtitleRequiredError,
  ENGLISH_SUBTITLE_REQUIRED_MESSAGE,
  normalizeSubtitleText,
  normalizeSubtitleTiming,
} from '../../src/core/subtitle-acquisition.js';

describe('subtitle acquisition', () => {
  it('优先使用不展开 UI 的转写接口', async () => {
    const acquireTranscriptPanelSubtitles = vi.fn(async () => []);
    const acquirer = createYouTubeSubtitleAcquirer({
      acquireTranscriptApiSubtitles: async () => [
        { startTime: 5, endTime: 7, text: ' second   subtitle ' },
        { startTime: 1, endTime: 3, text: 'first subtitle' },
      ],
      acquireTranscriptPanelSubtitles,
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).resolves.toEqual({
      subtitles: [
        { startTime: 1, endTime: 3, text: 'first subtitle' },
        { startTime: 5, endTime: 7, text: 'second subtitle' },
      ],
      source: 'transcript-api',
      diagnostics: {},
    });
    expect(acquireTranscriptPanelSubtitles).not.toHaveBeenCalled();
  });

  it('转写接口失败后才展开面板兜底', async () => {
    const acquirer = createYouTubeSubtitleAcquirer({
      acquireTranscriptApiSubtitles: async () => {
        throw new Error('转写接口不可用');
      },
      acquireTranscriptPanelSubtitles: async () => [
        { startTime: 1, endTime: 3, text: 'panel subtitle' },
      ],
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).resolves.toEqual({
      subtitles: [
        { startTime: 1, endTime: 3, text: 'panel subtitle' },
      ],
      source: 'transcript-panel',
      diagnostics: {
        transcriptApiError: '转写接口不可用',
        fallbackReason: '转写接口不可用',
      },
    });
  });

  it('确认没有英文字幕时不展开面板', async () => {
    const acquireTranscriptPanelSubtitles = vi.fn(async () => []);
    const acquirer = createYouTubeSubtitleAcquirer({
      acquireTranscriptApiSubtitles: async () => {
        throw new EnglishSubtitleRequiredError();
      },
      acquireTranscriptPanelSubtitles,
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: ENGLISH_SUBTITLE_REQUIRED_MESSAGE,
      diagnostics: {
        transcriptApiError: ENGLISH_SUBTITLE_REQUIRED_MESSAGE,
      },
    });
    expect(acquireTranscriptPanelSubtitles).not.toHaveBeenCalled();
  });

  it('全部来源失败时返回面板错误和两级诊断', async () => {
    let reported: unknown;
    const acquirer = createYouTubeSubtitleAcquirer({
      acquireTranscriptApiSubtitles: async () => {
        throw new Error('api failed');
      },
      acquireTranscriptPanelSubtitles: async () => {
        throw new Error('panel failed');
      },
      reportAcquisition: async (_videoId, report) => {
        reported = report;
      },
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: 'panel failed',
      diagnostics: {
        transcriptApiError: 'api failed',
        panelError: 'panel failed',
      },
    });
    expect(reported).toEqual({
      source: 'unavailable',
      subtitleCount: 0,
      diagnostics: {
        transcriptApiError: 'api failed',
        panelError: 'panel failed',
      },
    });
  });

  it('空结果会继续兜底，并把空面板视为最终失败', async () => {
    const acquirer = createYouTubeSubtitleAcquirer({
      acquireTranscriptApiSubtitles: async () => [],
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: '转写面板未返回可用字幕',
      diagnostics: {
        transcriptApiError: '转写接口未返回可用字幕',
        panelError: '转写面板未返回可用字幕',
      },
    });
  });

  it('诊断上报失败或 pending 都不影响获取结果', async () => {
    const create = (reportAcquisition: () => Promise<void> | void) =>
      createYouTubeSubtitleAcquirer({
        acquireTranscriptApiSubtitles: async () => [
          { startTime: 1, endTime: 3, text: 'subtitle' },
        ],
        acquireTranscriptPanelSubtitles: async () => [],
        reportAcquisition,
      });

    await expect(create(() => {
      throw new Error('extension context invalidated');
    }).acquire('video-id')).resolves.toMatchObject({
      source: 'transcript-api',
    });

    const outcome = await Promise.race([
      create(() => new Promise<void>(() => {})).acquire('video-id'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);
    expect(outcome).not.toBe('timed-out');
  });

  it('保留字幕源中的重复，只规范化文本、顺序、时间和重复记录', () => {
    expect(normalizeSubtitleTiming([
      { startTime: 4, endTime: 6, text: 'It is a computer.' },
      { startTime: 0, endTime: 2, text: 'This This is is a Raspberry Pi.' },
      { startTime: 0, endTime: 4, text: 'This This is is a Raspberry Pi.' },
    ])).toEqual([
      { startTime: 0, endTime: 4, text: 'This This is is a Raspberry Pi.' },
      { startTime: 4, endTime: 6, text: 'It is a computer.' },
    ]);
  });
});

describe('normalizeSubtitleText 清洗', () => {
  it('解码 HTML 实体并保留真实重复', () => {
    expect(normalizeSubtitleText('That&#39;s the &amp; gist')).toBe("That's the & gist");
    expect(normalizeSubtitleText('very very good good')).toBe('very very good good');
  });

  it('只去除明确的非语音标注', () => {
    expect(normalizeSubtitleText('[music] basic gist')).toBe('basic gist');
    expect(normalizeSubtitleText('execute bash, [applause] read that file')).toBe(
      'execute bash, read that file'
    );
    expect(normalizeSubtitleText('(laughs) it works')).toBe('it works');
  });

  it('保留有意义的括号内容和技术运算符', () => {
    expect(normalizeSubtitleText('Use [React] with hooks')).toBe('Use [React] with hooks');
    expect(normalizeSubtitleText('Call foo(bar) next')).toBe('Call foo(bar) next');
    expect(normalizeSubtitleText('x >> 2 means shift')).toBe('x >> 2 means shift');
  });

  it('只去除行首 >> 说话人标记并清理纯标注片段', () => {
    expect(normalizeSubtitleText('>> I am Mario')).toBe('I am Mario');
    expect(normalizeSubtitleText('>> [music]')).toBe('');
  });
});
