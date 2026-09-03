import { describe, expect, it } from 'vitest';

import {
  extractTranscriptPanelResponseSubtitles,
  extractTranscriptSegmentData,
  extractTranscriptSegmentStartTime,
  findTranscriptTrigger,
  getTranscriptPanel,
  getTranscriptSegmentElements,
  isTranscriptReady,
  parseTranscriptTimestamp,
  shouldForceLegacyTranscriptOpen,
  shouldWaitForTranscriptPanel,
} from '../../src/extension/youtube-subtitle-fetch.js';

describe('youtube subtitle fetch helpers', () => {
  it('识别新的中文 transcript 入口文案', () => {
    const transcriptButton = {
      textContent: '内容转文字',
      getAttribute(name: string) {
        return name === 'aria-label' ? '内容转文字' : null;
      },
    };

    const root = {
      querySelector() {
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === 'button') {
          return [transcriptButton];
        }

        return [];
      },
    };

    expect(findTranscriptTrigger(root)).toBe(transcriptButton);
  });

  it('点击新 transcript 入口后不再强开旧 panel', () => {
    expect(shouldForceLegacyTranscriptOpen(true, true)).toBe(false);
    expect(shouldForceLegacyTranscriptOpen(false, true)).toBe(true);
  });

  it('找不到 transcript 入口和 panel 时不进入轮询等待', () => {
    expect(shouldWaitForTranscriptPanel(false, false)).toBe(false);
    expect(shouldWaitForTranscriptPanel(true, false)).toBe(true);
    expect(shouldWaitForTranscriptPanel(false, true)).toBe(true);
  });

  it('只从当前 transcript panel 读取 segments，不读取页面中的隐藏副本', () => {
    const panelSegment = {};
    const hiddenPageSegment = {};
    const panel = {
      querySelector(selector: string) {
        return selector === 'tp-yt-paper-spinner' ? null : null;
      },
      querySelectorAll(selector: string) {
        return selector === 'transcript-segment-view-model' ? [panelSegment] : [];
      },
    };
    const root = {
      querySelector(selector: string) {
        return selector.includes('engagement-panel-searchable-transcript') ? panel : null;
      },
      querySelectorAll(selector: string) {
        return selector === 'transcript-segment-view-model'
          ? [panelSegment, hiddenPageSegment]
          : [];
      },
    };

    expect(getTranscriptSegmentElements(root as unknown as ParentNode)).toEqual([panelSegment]);
  });

  it('隐藏 transcript panel 排在前面时仍选择可见 panel', () => {
    const hiddenPanel = {
      hidden: true,
      getAttribute(name: string) {
        return name === 'aria-hidden' ? 'true' : null;
      },
    };
    const visiblePanel = {
      hidden: false,
      getAttribute() {
        return null;
      },
    };
    const root = {
      querySelector() {
        return hiddenPanel;
      },
      querySelectorAll(selector: string) {
        return selector.includes('engagement-panel-searchable-transcript')
          ? [hiddenPanel, visiblePanel]
          : [];
      },
    };

    expect(getTranscriptPanel(root as unknown as ParentNode)).toBe(visiblePanel);
  });

  it('识别没有 target-id 但包含字幕节点的新版可见 transcript panel', () => {
    const modernPanel = {
      hidden: false,
      getAttribute() {
        return null;
      },
    };
    const segment = {
      closest(selector: string) {
        return selector === 'ytd-engagement-panel-section-list-renderer'
          ? modernPanel
          : null;
      },
    };
    const root = {
      querySelector() {
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === 'transcript-segment-view-model' ? [segment] : [];
      },
    };

    expect(getTranscriptPanel(root as unknown as ParentNode)).toBe(modernPanel);
  });

  it('没有可见 transcript panel 时不扫描整个 document 的 segment', () => {
    const hiddenPanel = {
      hidden: true,
      getAttribute: () => null,
    };
    const hiddenPageSegment = {};
    const root = {
      querySelector() {
        return hiddenPanel;
      },
      querySelectorAll(selector: string) {
        if (selector.includes('engagement-panel-searchable-transcript')) {
          return [hiddenPanel];
        }
        return selector === 'transcript-segment-view-model' ? [hiddenPageSegment] : [];
      },
    };

    expect(getTranscriptSegmentElements(root as unknown as ParentNode)).toEqual([]);
  });

  it('无 UI 接口加载旧版隐藏 panel 后可以读取 segments', () => {
    const hiddenSegment = {};
    const emptyHiddenPanel = {
      hidden: true,
      getAttribute: () => null,
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const loadedHiddenPanel = {
      hidden: true,
      getAttribute: () => null,
      querySelector(selector: string) {
        return selector.includes('ytd-transcript-segment-renderer')
          ? hiddenSegment
          : null;
      },
      querySelectorAll(selector: string) {
        return selector === 'ytd-transcript-segment-renderer' ? [hiddenSegment] : [];
      },
    };
    const root = {
      querySelector() {
        return emptyHiddenPanel;
      },
      querySelectorAll(selector: string) {
        if (selector.includes('engagement-panel-searchable-transcript')) {
          return [emptyHiddenPanel, loadedHiddenPanel];
        }
        if (selector === 'ytd-transcript-segment-renderer') {
          return [{
            closest() {
              return loadedHiddenPanel;
            },
          }];
        }
        return [];
      },
    };

    expect(getTranscriptSegmentElements(root as unknown as ParentNode, true)).toEqual([
      hiddenSegment,
    ]);
  });

  it('解析新的 transcript-segment-view-model 节点', () => {
    const segment = {
      querySelector(selector: string) {
        if (selector.includes('Timestamp')) {
          return { textContent: '5:46' };
        }

        if (selector === 'span[role="text"]') {
          return { textContent: 'that these things would be really' };
        }

        return null;
      },
    };

    expect(extractTranscriptSegmentData(segment)).toEqual({
      timestampText: '5:46',
      bodyText: 'that these things would be really',
    });
  });

  it('优先读取 transcript 节点的可见文本，避免 textContent 混入重复的无障碍文本', () => {
    const segment = {
      querySelector(selector: string) {
        if (selector.includes('Timestamp')) {
          return { textContent: '0:05', innerText: '0:05' };
        }

        if (selector === 'span[role="text"]') {
          return {
            textContent: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.',
            innerText: 'This is a Raspberry Pi 5.',
          };
        }

        return null;
      },
    };

    expect(extractTranscriptSegmentData(segment)).toEqual({
      timestampText: '0:05',
      bodyText: 'This is a Raspberry Pi 5.',
    });
  });

  it('transcript 的可见文本本身包含重复词时应保留源文本', () => {
    const segment = {
      querySelector(selector: string) {
        if (selector.includes('Timestamp')) {
          return { textContent: '0:05', innerText: '0:05' };
        }

        if (selector === 'span[role="text"]') {
          return {
            textContent: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.',
            innerText: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.',
          };
        }

        return null;
      },
    };

    expect(extractTranscriptSegmentData(segment)).toEqual({
      timestampText: '0:05',
      bodyText: 'This This is is a a Raspberry Raspberry Pi Pi 5 5.',
    });
  });

  it('支持解析带小数秒的 transcript 时间文本', () => {
    expect(parseTranscriptTimestamp('1:02.345')).toBe(62.345);
    expect(parseTranscriptTimestamp('01:02:03.250')).toBe(3723.25);
  });

  it('从新版 get_panel 响应中读取字幕且不依赖可见面板', () => {
    const subtitles = extractTranscriptPanelResponseSubtitles({
      content: {
        sectionListRenderer: {
          contents: [
            {
              macroMarkersPanelItemViewModel: {
                item: {
                  transcriptSegmentViewModel: {
                    timestamp: '0:05',
                    simpleText: 'First sentence.',
                  },
                },
              },
            },
            {
              macroMarkersPanelItemViewModel: {
                item: {
                  transcriptSegmentViewModel: {
                    timestamp: '0:08.500',
                    simpleText: 'Second sentence.',
                  },
                },
              },
            },
          ],
        },
      },
    });

    expect(subtitles).toEqual([
      { startTime: 5, endTime: 8.5, text: 'First sentence.' },
      { startTime: 8.5, endTime: 13.5, text: 'Second sentence.' },
    ]);
  });

  it('只解析本次旧版命令返回的 DOM 字幕快照', () => {
    expect(extractTranscriptPanelResponseSubtitles({
      legacyDomSegments: [
        { timestamp: '0:00', text: 'Current video first sentence.' },
        { timestamp: '0:04', text: 'Current video second sentence.' },
      ],
    })).toEqual([
      { startTime: 0, endTime: 4, text: 'Current video first sentence.' },
      { startTime: 4, endTime: 9, text: 'Current video second sentence.' },
    ]);
  });

  it('优先使用 transcript 节点中的毫秒属性作为开始时间', () => {
    const timestampNode = {
      textContent: '5:46',
      getAttribute(name: string) {
        return name === 'data-start-ms' ? '345678' : null;
      },
    };

    const segment = {
      getAttribute() {
        return null;
      },
      querySelector(selector: string) {
        if (selector.includes('Timestamp')) {
          return timestampNode;
        }

        if (selector === 'span[role="text"]') {
          return { textContent: 'that these things would be really' };
        }

        return null;
      },
    };

    expect(extractTranscriptSegmentStartTime(segment)).toBe(345.678);
  });

  it('在 transcript 面板还在加载时不误判为可解析', () => {
    expect(isTranscriptReady({ segmentCount: 0, hasSpinner: true })).toBe(false);
    expect(isTranscriptReady({ segmentCount: 3, hasSpinner: false })).toBe(true);
  });
});
