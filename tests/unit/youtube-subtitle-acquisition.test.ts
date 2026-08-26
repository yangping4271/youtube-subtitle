import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createYouTubeSubtitleAcquirer as createCoreYouTubeSubtitleAcquirer,
  normalizeSubtitleText,
  normalizeSubtitleTiming,
} from '../../src/core/subtitle-acquisition.js';
import type {
  SubtitleAcquisitionDependencies,
  TimedTextDocument,
  YouTubeSubtitleAcquirer,
} from '../../src/core/subtitle-acquisition.js';

let installedCaptionTrackDocument: TimedTextDocument;

type SingleStrategyDependencies = Omit<
  SubtitleAcquisitionDependencies,
  'captionTrackStrategies' | 'parseCaptionTrackDocument'
> & {
  captionTrackStrategy: SubtitleAcquisitionDependencies['captionTrackStrategies'][number];
};

function createYouTubeSubtitleAcquirer(
  dependencies: SingleStrategyDependencies
): YouTubeSubtitleAcquirer {
  return createCoreYouTubeSubtitleAcquirer({
    captionTrackStrategies: [dependencies.captionTrackStrategy],
    parseCaptionTrackDocument: () => installedCaptionTrackDocument,
    acquireTranscriptPanelSubtitles: dependencies.acquireTranscriptPanelSubtitles,
    reportAcquisition: dependencies.reportAcquisition,
  });
}

function installTimedTextDocument(
  entries: Array<{ start: string; dur?: string; text: string }>
): void {
  const nodes = entries.map((entry) => ({
    textContent: entry.text,
    getAttribute(name: string) {
      if (name === 'start') return entry.start;
      if (name === 'dur') return entry.dur ?? null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  }));

  installedCaptionTrackDocument = {
    querySelector(selector: string) {
      return selector === 'parsererror' ? null : null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'p') return [];
      if (selector === 'text') return nodes;
      return [];
    },
  };
}

function installSrv3Document(): void {
  const spans = [
    {
      textContent: ' first ',
      getAttribute(name: string) {
        return name === 't' ? '0' : null;
      },
      querySelectorAll() {
        return [];
      },
    },
    {
      textContent: ' second ',
      getAttribute(name: string) {
        return name === 't' ? '1500' : null;
      },
      querySelectorAll() {
        return [];
      },
    },
  ];
  const paragraph = {
    textContent: ' first second ',
    getAttribute(name: string) {
      if (name === 't') return '1000';
      if (name === 'd') return '3000';
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === 's' ? spans : [];
    },
  };
  installedCaptionTrackDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'p') return [paragraph];
      return [];
    },
  };
}

function installSrv3ParagraphDocument(): void {
  const paragraph = {
    textContent: ' paragraph   subtitle ',
    getAttribute(name: string) {
      if (name === 't') return '2000';
      if (name === 'd') return '3000';
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  installedCaptionTrackDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === 'p' ? [paragraph] : [];
    },
  };
}

describe('subtitle acquisition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('保留字幕源中的逐词重复，只规范化空白', () => {
    expect(normalizeSubtitleTiming([
      { startTime: 0, endTime: 1, text: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.' },
      { startTime: 1, endTime: 2, text: 'I I really really think.' },
    ])).toEqual([
      { startTime: 0, endTime: 1, text: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.' },
      { startTime: 1, endTime: 2, text: 'I I really really think.' },
    ]);
  });

  it('保留短句中的正常重复词语', () => {
    expect(normalizeSubtitleText('very very good good')).toBe('very very good good');
    expect(normalizeSubtitleText('I I can can')).toBe('I I can can');
  });

  it('保留较长的真实口语重复，不把它当作采集错误', () => {
    expect(normalizeSubtitleText('I I really really do do')).toBe('I I really really do do');
    expect(normalizeSubtitleText('very very very very good good')).toBe(
      'very very very very good good'
    );
  });

  it('去除 transcript panel 产生的相同时间和文本的重复字幕', () => {
    expect(normalizeSubtitleTiming([
      { startTime: 0, endTime: 2, text: 'This is a Raspberry Pi.' },
      { startTime: 0, endTime: 4, text: 'This is a Raspberry Pi.' },
      { startTime: 4, endTime: 6, text: 'It is a computer.' },
    ])).toEqual([
      { startTime: 0, endTime: 4, text: 'This is a Raspberry Pi.' },
      { startTime: 4, endTime: 6, text: 'It is a computer.' },
    ]);
  });

  it('把 SRV3 末词的留屏结束时间限制在下一词开始点', () => {
    expect(normalizeSubtitleTiming([
      { startTime: 2.08, endTime: 5.6, text: 'Raycast,' },
      { startTime: 2.8, endTime: 3.2, text: 'AI' },
      { startTime: 3.2, endTime: 3.52, text: 'chat' },
    ])).toEqual([
      { startTime: 2.08, endTime: 2.8, text: 'Raycast,' },
      { startTime: 2.8, endTime: 3.2, text: 'AI' },
      { startTime: 3.2, endTime: 3.52, text: 'chat' },
    ]);
  });

  it('通过 caption track 返回按时间排序且规范化的字幕', async () => {
    installTimedTextDocument([
      { start: '5', dur: '2', text: ' second   subtitle ' },
      { start: '1', text: ' first subtitle ' },
    ]);

    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext />',
        source: 'page-player-response',
        trackLanguageCode: 'en',
      }),
      acquireTranscriptPanelSubtitles: async () => {
        throw new Error('caption track 成功时不应读取 transcript panel');
      },
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).resolves.toEqual({
      subtitles: [
        { startTime: 1, endTime: 5, text: 'first subtitle' },
        { startTime: 5, endTime: 7, text: 'second subtitle' },
      ],
      source: 'caption-tracks',
      diagnostics: {
        strategy: 'page-player-response',
        trackLanguageCode: 'en',
      },
    });
  });

  it('通过同一个 acquire interface 解析 SRV3 span 时间', async () => {
    installSrv3Document();
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext format="3" />',
        source: 'youtubei-player',
      }),
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: async () => {},
    });

    const result = await acquirer.acquire('video-id');

    expect(result.subtitles).toEqual([
      { startTime: 1, endTime: 2.5, text: 'first' },
      { startTime: 2.5, endTime: 4, text: 'second' },
    ]);
  });

  it('SRV3 没有 span 时间时使用 paragraph 时间', async () => {
    installSrv3ParagraphDocument();
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext format="3" />',
        source: 'youtubei-player',
      }),
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: async () => {},
    });

    const result = await acquirer.acquire('video-id');

    expect(result.subtitles).toEqual([
      { startTime: 2, endTime: 5, text: 'paragraph subtitle' },
    ]);
  });

  it('caption track 失败后 fallback 到 transcript panel', async () => {
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => {
        throw new Error('caption track unavailable');
      },
      acquireTranscriptPanelSubtitles: async () => [
        { startTime: 5, endTime: 0, text: ' panel second ' },
        { startTime: 1, endTime: 3, text: 'panel first' },
      ],
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).resolves.toEqual({
      subtitles: [
        { startTime: 1, endTime: 3, text: 'panel first' },
        { startTime: 5, endTime: 10, text: 'panel second' },
      ],
      source: 'transcript-panel',
      diagnostics: {
        captionTrackError: 'caption track unavailable',
        fallbackReason: 'caption track unavailable',
      },
    });
  });

  it('全部来源失败时优先返回登录提示并保留诊断', async () => {
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => {
        throw new Error('YouTube 要求先登录以确认不是机器人');
      },
      acquireTranscriptPanelSubtitles: async () => {
        throw new Error('transcript panel unavailable');
      },
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: 'YouTube 要求先登录以确认不是机器人',
      diagnostics: {
        captionTrackError: 'YouTube 要求先登录以确认不是机器人',
        panelError: 'transcript panel unavailable',
      },
    });
  });

  it('多条 caption strategy 失败时只向用户返回登录提示', async () => {
    const acquirer = createCoreYouTubeSubtitleAcquirer({
      captionTrackStrategies: [
        async () => {
          throw new Error('页面 player response 未提供字幕轨');
        },
        async () => {
          throw new Error('YouTube 要求先登录以确认不是机器人');
        },
      ],
      parseCaptionTrackDocument: () => installedCaptionTrackDocument,
      acquireTranscriptPanelSubtitles: async () => {
        throw new Error('transcript panel unavailable');
      },
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: 'YouTube 要求先登录以确认不是机器人',
      diagnostics: {
        captionTrackError:
          '页面 player response 未提供字幕轨; YouTube 要求先登录以确认不是机器人',
        panelError: 'transcript panel unavailable',
      },
    });
  });

  it('caption track 解析为空时继续 fallback', async () => {
    installTimedTextDocument([]);
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext />',
        source: 'youtubei-player',
      }),
      acquireTranscriptPanelSubtitles: async () => [
        { startTime: 2, endTime: 4, text: 'panel subtitle' },
      ],
      reportAcquisition: async () => {},
    });

    const result = await acquirer.acquire('video-id');

    expect(result).toMatchObject({
      source: 'transcript-panel',
      subtitles: [{ startTime: 2, endTime: 4, text: 'panel subtitle' }],
      diagnostics: {
        captionTrackError: '字幕轨未返回可用字幕',
      },
    });
  });

  it('页面 caption track 解析为空时先尝试 youtubei/player', async () => {
    installTimedTextDocument([
      { start: '3', dur: '2', text: 'player subtitle' },
    ]);
    const playerDocument = installedCaptionTrackDocument;
    const emptyDocument: TimedTextDocument = {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    let panelAttempts = 0;
    const acquirer = createCoreYouTubeSubtitleAcquirer({
      captionTrackStrategies: [
        async () => ({
          trackText: '<page-track />',
          source: 'page-player-response',
        }),
        async () => ({
          trackText: '<player-track />',
          source: 'youtubei-player',
        }),
      ],
      parseCaptionTrackDocument: (xml) =>
        xml === '<page-track />' ? emptyDocument : playerDocument,
      acquireTranscriptPanelSubtitles: async () => {
        panelAttempts += 1;
        return [];
      },
      reportAcquisition: async () => {},
    });

    const result = await acquirer.acquire('video-id');

    expect(result).toMatchObject({
      source: 'caption-tracks',
      subtitles: [{ startTime: 3, endTime: 5, text: 'player subtitle' }],
      diagnostics: {
        strategy: 'youtubei-player',
        fallbackReason: '字幕轨未返回可用字幕',
      },
    });
    expect(panelAttempts).toBe(0);
  });

  it('诊断上报失败不影响已经获取的字幕', async () => {
    installTimedTextDocument([
      { start: '1', dur: '2', text: 'subtitle' },
    ]);
    let reportAttempts = 0;
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext />',
        source: 'page-player-response',
      }),
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: async () => {
        reportAttempts += 1;
        throw new Error('extension context invalidated');
      },
    });

    const result = await acquirer.acquire('video-id');

    expect(result.source).toBe('caption-tracks');
    expect(reportAttempts).toBe(1);
  });

  it('诊断上报一直 pending 也不阻塞字幕结果', async () => {
    installTimedTextDocument([
      { start: '1', dur: '2', text: 'subtitle' },
    ]);
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => ({
        trackText: '<timedtext />',
        source: 'page-player-response',
      }),
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: () => new Promise<void>(() => {}),
    });

    const outcome = await Promise.race([
      acquirer.acquire('video-id'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
  });

  it('全部来源失败时统一上报 unavailable 诊断', async () => {
    let reported: unknown;
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => {
        throw new Error('caption failed');
      },
      acquireTranscriptPanelSubtitles: async () => {
        throw new Error('panel failed');
      },
      reportAcquisition: async (_videoId, report) => {
        reported = report;
      },
    });

    await expect(acquirer.acquire('video-id')).rejects.toThrow('panel failed');
    expect(reported).toEqual({
      source: 'unavailable',
      subtitleCount: 0,
      diagnostics: {
        captionTrackError: 'caption failed',
        panelError: 'panel failed',
      },
    });
  });

  it('transcript panel 返回空数组时视为获取失败', async () => {
    const acquirer = createYouTubeSubtitleAcquirer({
      captionTrackStrategy: async () => {
        throw new Error('caption failed');
      },
      acquireTranscriptPanelSubtitles: async () => [],
      reportAcquisition: async () => {},
    });

    await expect(acquirer.acquire('video-id')).rejects.toMatchObject({
      message: '转写面板未返回可用字幕',
      diagnostics: {
        captionTrackError: 'caption failed',
        panelError: '转写面板未返回可用字幕',
      },
    });
  });
});

describe('normalizeSubtitleText 清洗', () => {
  it('解码 HTML 实体', () => {
    expect(normalizeSubtitleText('That&#39;s the &amp; gist')).toBe("That's the & gist");
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
