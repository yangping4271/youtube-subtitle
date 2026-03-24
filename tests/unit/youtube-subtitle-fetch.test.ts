import { describe, expect, it } from 'vitest';

import {
  classifyCaptionTrackResponse,
  createYouTubeRequestInit,
  extractCaptionTracks,
  extractTranscriptSegmentData,
  findTranscriptTrigger,
  isTranscriptReady,
  shouldForceLegacyTranscriptOpen,
} from '../../src/extension/youtube-subtitle-fetch.js';

describe('youtube subtitle fetch helpers', () => {
  it('将 YouTube 反机器人登录校验识别为 login_required', () => {
    const result = classifyCaptionTrackResponse({
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [],
        },
      },
    });

    expect(result.kind).toBe('login_required');
    expect(result.message).toContain('登录');
  });

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

  it('访问 YouTube 接口时显式携带登录态 cookies', () => {
    expect(createYouTubeRequestInit().credentials).toBe('include');
  });

  it('从页面 player response 中提取 caption tracks', () => {
    const tracks = extractCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=1' }],
        },
      },
    });

    expect(tracks).toEqual([
      { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=1' },
    ]);
  });

  it('点击新 transcript 入口后不再强开旧 panel', () => {
    expect(shouldForceLegacyTranscriptOpen(true, true)).toBe(false);
    expect(shouldForceLegacyTranscriptOpen(false, true)).toBe(true);
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

  it('在 transcript 面板还在加载时不误判为可解析', () => {
    expect(isTranscriptReady({ segmentCount: 0, hasSpinner: true })).toBe(false);
    expect(isTranscriptReady({ segmentCount: 3, hasSpinner: false })).toBe(true);
  });
});
