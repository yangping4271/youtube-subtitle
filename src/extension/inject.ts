/**
 * YouTube Subtitle Translator - Main World 注入脚本
 * 在页面上下文中运行，可访问 YouTube 的自定义元素属性
 */
import { rewriteTranscriptParamsVideoId } from '../core/youtube-transcript-params.js';

interface YouTubeEngagementPanel extends HTMLElement {
  visibility?: string;
}

interface YouTubePageWindow extends Window {
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
  ytcfg?: {
    get?(key: string): unknown;
  };
}

interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
  getVideoData?: () => { video_id?: string };
}

interface YouTubeAppElement extends HTMLElement {
  resolveCommand?: (command: unknown) => unknown;
}

interface YouTubeDataElement extends HTMLElement {
  data?: {
    command?: {
      commandExecutorCommand?: {
        commands?: Array<{
          updateEngagementPanelContentCommand?: {
            contentSourcePanelIdentifier?: {
              tag?: string;
            };
            globalConfiguration?: {
              params?: string;
            };
          };
        }>;
      };
    };
  };
}

async function createYouTubeAuthorizationHeader(): Promise<string | null> {
  const sapisid = document.cookie.match(
    /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/
  )?.[1];
  if (!sapisid) {
    return null;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${timestamp} ${sapisid} https://www.youtube.com`)
  );
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');

  return `SAPISIDHASH ${timestamp}_${hash}`;
}

interface TranscriptPanelRequest {
  panelId: string;
  params: string;
}

interface LegacyTranscriptRequest {
  getTranscriptEndpoint: {
    params: string;
  };
}

function readTranscriptPanelRequest(command: unknown): TranscriptPanelRequest | null {
  if (!command || typeof command !== 'object') {
    return null;
  }

  const panelCommand = (
    command as {
      updateEngagementPanelContentCommand?: {
        contentSourcePanelIdentifier?: {
          tag?: string;
        };
        globalConfiguration?: {
          params?: string;
        };
      };
    }
  ).updateEngagementPanelContentCommand;
  const panelId = panelCommand?.contentSourcePanelIdentifier?.tag;
  const params = panelCommand?.globalConfiguration?.params;

  return typeof panelId === 'string' && typeof params === 'string'
    ? { panelId, params }
    : null;
}

function findTranscriptPanelRequestInData(data: unknown): TranscriptPanelRequest | null {
  const pending: unknown[] = [data];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const request = readTranscriptPanelRequest(value);
    if (request) {
      return request;
    }

    pending.push(...Object.values(value));
  }

  return null;
}

function findTranscriptPanelRequest(): TranscriptPanelRequest | null {
  const transcriptButton = Array.from(document.querySelectorAll('button')).find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
    return /show transcript|内容转文字|转写文稿|文字记录/i.test(label);
  });
  const commands = (
    transcriptButton?.closest('ytd-button-renderer') as YouTubeDataElement | null
  )?.data?.command?.commandExecutorCommand?.commands;
  for (const command of commands || []) {
    const request = readTranscriptPanelRequest(command);
    if (request) {
      return request;
    }
  }

  return findTranscriptPanelRequestInData(
    (window as YouTubePageWindow).ytInitialData
  );
}

function findLegacyTranscriptRequest(data: unknown): LegacyTranscriptRequest | null {
  const pending: unknown[] = [data];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const endpoint = (value as LegacyTranscriptRequest).getTranscriptEndpoint;
    if (typeof endpoint?.params === 'string') {
      return value as LegacyTranscriptRequest;
    }

    pending.push(...Object.values(value));
  }

  return null;
}

async function waitForLegacyTranscriptRefresh(
  previousSegments: Map<Element, string>,
  timeoutMs = 5000
): Promise<Element[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const segments = Array.from(
      document.querySelectorAll('ytd-transcript-segment-renderer')
    );
    const changedSegment = segments.find((segment) =>
      previousSegments.get(segment) !== readLegacyTranscriptSegment(segment)
    );
    if (changedSegment) {
      const panel = changedSegment.closest(
        'ytd-engagement-panel-section-list-renderer'
      );
      return panel
        ? Array.from(panel.querySelectorAll('ytd-transcript-segment-renderer'))
        : segments;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return [];
}

function readLegacyTranscriptSegment(segment: Element): string {
  const timestamp = (
    segment.querySelector('.segment-timestamp, #start-offset')
      ?.textContent || ''
  ).trim();
  const text = (
    segment.querySelector('#segment-text, .segment-text, yt-formatted-string')
      ?.textContent || ''
  ).trim();
  return `${timestamp}\u0000${text}`;
}

function extractLegacyTranscriptSegments(
  segments: Element[]
): Array<{ timestamp: string; text: string }> {
  return segments.flatMap((segment) => {
    const [timestamp, text] = readLegacyTranscriptSegment(segment).split('\u0000');
    return timestamp && text ? [{ timestamp, text }] : [];
  });
}

function getMarkedLegacyTranscriptSegments(videoId: string): Element[] {
  const panel = document.querySelector(
    `ytd-engagement-panel-section-list-renderer[data-ytsp-video-id="${videoId}"]`
  );
  return panel
    ? Array.from(panel.querySelectorAll('ytd-transcript-segment-renderer'))
    : [];
}

function markLegacyTranscriptPanel(segments: Element[], videoId: string): void {
  segments[0]
    ?.closest('ytd-engagement-panel-section-list-renderer')
    ?.setAttribute('data-ytsp-video-id', videoId);
}

window.addEventListener('YTSP_OpenTranscript', () => {
  const engagementPanel = document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"], ' +
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  ) as YouTubeEngagementPanel | null;

  if (engagementPanel) {
    engagementPanel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  }
});

window.addEventListener('YTSP_StartTranslation', () => {
  window.postMessage({ type: 'YTSP_StartTranslation' }, '*');
});

window.addEventListener('YTSP_MarkTranscriptPanel', (event) => {
  const videoId = (
    event as CustomEvent<{ videoId?: unknown }>
  ).detail?.videoId;
  if (typeof videoId !== 'string') {
    return;
  }

  const panels = Array.from(document.querySelectorAll(
    'ytd-engagement-panel-section-list-renderer'
  ));
  const panel = panels.find((candidate) =>
    candidate.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' &&
    candidate.querySelector('ytd-transcript-segment-renderer')
  );
  panel?.setAttribute('data-ytsp-video-id', videoId);
});

window.addEventListener('YTSP_RequestTranscriptPanel', async (event) => {
  const pageWindow = window as YouTubePageWindow;
  const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
  const requestedVideoId = (
    event as CustomEvent<{ videoId?: unknown }>
  ).detail?.videoId;
  const playerVideoId = player?.getVideoData?.()?.video_id;
  if (
    typeof requestedVideoId === 'string' &&
    typeof playerVideoId === 'string' &&
    requestedVideoId !== playerVideoId
  ) {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'unavailable', videoId: requestedVideoId },
    }, '*');
    return;
  }
  const playerResponse = (
    player?.getPlayerResponse?.() || pageWindow.ytInitialPlayerResponse
  ) as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{ languageCode?: string; kind?: string }>;
      };
    };
  } | null;
  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const englishTracks = tracks.filter((track) =>
    /^en(?:-|$)/i.test(track.languageCode || '')
  );
  const englishTrack =
    englishTracks.find((track) => track.kind !== 'asr') || englishTracks[0];
  if (
    tracks.length > 0 &&
    !englishTrack
  ) {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'english-unavailable', videoId: requestedVideoId },
    }, '*');
    return;
  }

  const context = pageWindow.ytcfg?.get?.('INNERTUBE_CONTEXT');
  const request = findTranscriptPanelRequest();
  const legacyRequest = findLegacyTranscriptRequest(pageWindow.ytInitialData);
  const clientName = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_NAME');
  const clientVersion = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION');

  if (!request && legacyRequest) {
    if (typeof requestedVideoId === 'string') {
      const cachedSegments = getMarkedLegacyTranscriptSegments(requestedVideoId);
      if (cachedSegments.length > 0) {
        window.postMessage({
          type: 'YTSP_TranscriptPanelResponse',
          payload: {
            status: 'ok',
            response: {
              legacyDomSegments: extractLegacyTranscriptSegments(cachedSegments),
            },
            videoId: requestedVideoId,
          },
        }, '*');
        return;
      }
    }

    const app = document.querySelector('ytd-app') as YouTubeAppElement | null;
    if (typeof app?.resolveCommand === 'function') {
      try {
        const params = typeof requestedVideoId === 'string'
          ? rewriteTranscriptParamsVideoId(
            legacyRequest.getTranscriptEndpoint.params,
            requestedVideoId,
            englishTrack?.languageCode || 'en',
            englishTrack?.kind
          )
          : legacyRequest.getTranscriptEndpoint.params;
        if (!params) {
          throw new Error('transcript params 与当前视频不匹配');
        }
        const currentRequest: LegacyTranscriptRequest = {
          ...legacyRequest,
          getTranscriptEndpoint: {
            ...legacyRequest.getTranscriptEndpoint,
            params,
          },
        };
        const previousSegments = new Map(
          Array.from(
            document.querySelectorAll('ytd-transcript-segment-renderer'),
            (segment) => [segment, readLegacyTranscriptSegment(segment)]
          )
        );
        app.resolveCommand(currentRequest);
        const freshSegments = await waitForLegacyTranscriptRefresh(previousSegments);
        if (freshSegments.length > 0 && typeof requestedVideoId === 'string') {
          markLegacyTranscriptPanel(freshSegments, requestedVideoId);
        }
        window.postMessage({
          type: 'YTSP_TranscriptPanelResponse',
          payload: {
            status: freshSegments.length > 0 ? 'ok' : 'unavailable',
            response: {
              legacyDomSegments: extractLegacyTranscriptSegments(freshSegments),
            },
            videoId: requestedVideoId,
          },
        }, '*');
        return;
      } catch {
        // 继续返回 unavailable，让 content script 使用可视面板兜底。
      }
    }
  }

  if (!context || !request) {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'unavailable', videoId: requestedVideoId },
    }, '*');
    return;
  }

  try {
    const authorization = await createYouTubeAuthorizationHeader();
    const response = await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Origin': 'https://www.youtube.com',
        ...(authorization ? { Authorization: authorization } : {}),
        ...(typeof clientName === 'string' || typeof clientName === 'number'
          ? { 'X-Youtube-Client-Name': String(clientName) }
          : {}),
        ...(typeof clientVersion === 'string'
          ? { 'X-Youtube-Client-Version': clientVersion }
          : {}),
      },
      body: JSON.stringify({
        context,
        panelId: request.panelId,
        params: request.params,
      }),
    });
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: response.ok
        ? { status: 'ok', response: await response.json(), videoId: requestedVideoId }
        : { status: 'unavailable', videoId: requestedVideoId },
    }, '*');
  } catch {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'unavailable', videoId: requestedVideoId },
    }, '*');
  }
});
