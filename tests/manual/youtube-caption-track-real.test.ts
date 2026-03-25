import { describe, expect, it } from 'vitest';

import {
  classifyCaptionTrackResponse,
  createYouTubeRequestInit,
  extractCaptionTracks,
} from '../../src/extension/youtube-subtitle-fetch.js';

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
}

interface YouTubePlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
}

const REAL_VIDEO_ID = 'pkSxISewcw8';

async function fetchYouTubePlayerResponse(videoId: string): Promise<YouTubePlayerResponse> {
  const response = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    createYouTubeRequestInit({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
          },
        },
        videoId,
      }),
    })
  );

  if (!response.ok) {
    throw new Error(`player 接口请求失败: ${response.status}`);
  }

  return response.json() as Promise<YouTubePlayerResponse>;
}

describe('真实 YouTube 字幕轨测试', () => {
  it('指定视频应该能通过 player 接口拿到英文字幕轨并返回 timedtext XML', async () => {
    const playerResponse = await fetchYouTubePlayerResponse(REAL_VIDEO_ID);
    const responseClassification = classifyCaptionTrackResponse(playerResponse);
    expect(responseClassification.kind).toBe('ok');

    const tracks = extractCaptionTracks(playerResponse) as YouTubeCaptionTrack[];
    expect(tracks.length).toBeGreaterThan(0);

    const track = tracks.find((item) => item.languageCode === 'en') || tracks[0];
    expect(track?.baseUrl).toBeTruthy();

    const timedTextResponse = await fetch(track!.baseUrl!, createYouTubeRequestInit());
    expect(timedTextResponse.ok).toBe(true);

    const xml = await timedTextResponse.text();
    expect(xml).toContain('<timedtext');
    expect(xml.includes('<p ') || xml.includes('<text ')).toBe(true);
  }, 30000);
});
