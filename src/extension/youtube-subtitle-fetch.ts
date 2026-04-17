export interface CaptionTrackResponseLike {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown[];
    };
  };
}

export interface CaptionTrackLike {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface WindowCaptionTrackMessage {
  type: 'YTSP_PageCaptionTracks';
  payload: CaptionTrackResponseLike | null;
}

interface QueryElementLike {
  textContent?: string | null;
  tagName?: string;
  getAttribute?(name: string): string | null;
  querySelector?(selector: string): QueryElementLike | null;
}

interface TranscriptQueryRoot {
  querySelector(selector: string): QueryElementLike | null;
  querySelectorAll(selector: string): QueryElementLike[] | NodeListOf<Element>;
}

export interface CaptionTrackResponseClassification {
  kind: 'ok' | 'login_required' | 'no_captions';
  message: string | null;
}

export interface TranscriptPanelState {
  segmentCount: number;
  hasSpinner: boolean;
  hasContinuation?: boolean;
}

export interface ResolvedCaptionTrackText {
  trackText: string;
  source: 'page-player-response' | 'youtubei-player';
  fallbackReason?: string;
  trackLanguageCode?: string;
  trackKind?: string;
}

const TRANSCRIPT_PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

const TRANSCRIPT_TRIGGER_PATTERNS = [
  /show transcript/i,
  /\btranscript\b/i,
  /内容转文字/i,
  /转写文稿/i,
  /文字记录/i,
];

const TRANSCRIPT_TRIGGER_SELECTORS = [
  '#button-container button[aria-label="Show transcript"]',
  'button[aria-label*="transcript" i]',
  'button[aria-label*="Show transcript" i]',
  '.ytd-video-description-transcript-section-renderer button',
  'ytd-video-description-transcript-section-renderer button',
  '#primary-button button',
];

const TRANSCRIPT_START_TIME_ATTRIBUTES = [
  'data-start-ms',
  'data-start-offset-ms',
  'data-start-time-ms',
  'start-ms',
  'start-offset-ms',
  'start-time-ms',
  'offset-ms',
];

export function createYouTubeRequestInit(init: RequestInit = {}): RequestInit {
  return {
    credentials: 'include',
    ...init,
  };
}

export function extractCaptionTracks(response: CaptionTrackResponseLike | null | undefined): CaptionTrackLike[] {
  return (response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []) as CaptionTrackLike[];
}

export function pickPreferredCaptionTrack<T extends CaptionTrackLike>(tracks: T[]): T | undefined {
  return tracks.find((track) => track.languageCode === 'en' && track.kind !== 'asr') ||
    tracks.find((track) => track.languageCode === 'en') ||
    tracks.find((track) => track.kind !== 'asr') ||
    tracks[0];
}

export function classifyCaptionTrackResponse(
  response: CaptionTrackResponseLike
): CaptionTrackResponseClassification {
  const status = response.playabilityStatus?.status || '';
  const reason = response.playabilityStatus?.reason || '';
  const captionTracks = extractCaptionTracks(response);

  if (status === 'LOGIN_REQUIRED') {
    return {
      kind: 'login_required',
      message: 'YouTube 要求先登录以确认不是机器人，请登录 YouTube 后重试。',
    };
  }

  if (captionTracks.length === 0) {
    return {
      kind: 'no_captions',
      message: reason || null,
    };
  }

  return {
    kind: 'ok',
    message: null,
  };
}

export function requestPageCaptionTrackResponse(timeoutMs = 1000): Promise<CaptionTrackResponseLike | null> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent<WindowCaptionTrackMessage>): void => {
      if (event.source !== window || event.data?.type !== 'YTSP_PageCaptionTracks') {
        return;
      }

      window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      resolve((event.data.payload as CaptionTrackResponseLike | null) || null);
    };

    window.addEventListener('message', onMessage);
    window.dispatchEvent(new CustomEvent('YTSP_RequestCaptionTracks'));
  });
}

export async function fetchYouTubePlayerResponse(videoId: string): Promise<CaptionTrackResponseLike> {
  const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', createYouTubeRequestInit({
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
  }));

  if (!response.ok) {
    throw new Error(`player 接口请求失败: ${response.status}`);
  }

  return response.json() as Promise<CaptionTrackResponseLike>;
}

export async function fetchCaptionTrackText(track: CaptionTrackLike): Promise<string> {
  if (!track.baseUrl) {
    throw new Error('字幕轨缺少 baseUrl');
  }

  const captionUrl = new URL(track.baseUrl);
  const isYouTubeHost = captionUrl.hostname === 'www.youtube.com' || captionUrl.hostname.endsWith('.youtube.com');
  if (!isYouTubeHost) {
    throw new Error(`字幕轨地址不是 YouTube 域名: ${captionUrl.hostname}`);
  }

  const response = await fetch(track.baseUrl, createYouTubeRequestInit());
  if (!response.ok) {
    throw new Error(`字幕轨请求失败: ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    const contentType = response.headers.get('content-type') || 'unknown';
    throw new Error(`字幕轨返回空响应 (content-type: ${contentType})`);
  }

  return text;
}

export async function resolveCaptionTrackText(
  videoId: string,
  options: {
    requestPageResponse?: () => Promise<CaptionTrackResponseLike | null>;
    requestPlayerResponse?: (videoId: string) => Promise<CaptionTrackResponseLike>;
    requestTrackText?: (track: CaptionTrackLike) => Promise<string>;
  } = {}
): Promise<ResolvedCaptionTrackText> {
  const requestPageResponse = options.requestPageResponse || requestPageCaptionTrackResponse;
  const requestPlayerResponse = options.requestPlayerResponse || fetchYouTubePlayerResponse;
  const requestTrackText = options.requestTrackText || fetchCaptionTrackText;
  let pageTrackError: Error | null = null;

  const pagePlayerResponse = await requestPageResponse();
  const pageTracks = extractCaptionTracks(pagePlayerResponse);
  if (pageTracks.length > 0) {
    const track = pickPreferredCaptionTrack(pageTracks);
    if (track?.baseUrl) {
      try {
        return {
          trackText: await requestTrackText(track),
          source: 'page-player-response',
          trackLanguageCode: track.languageCode,
          trackKind: track.kind,
        };
      } catch (error) {
        pageTrackError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  const playerResponse = await requestPlayerResponse(videoId);
  const responseClassification = classifyCaptionTrackResponse(playerResponse);
  if (responseClassification.kind === 'login_required') {
    throw new Error(responseClassification.message || '请先登录 YouTube 后重试。');
  }

  const tracks = extractCaptionTracks(playerResponse);
  if (tracks.length === 0) {
    const reason = responseClassification.message || 'player 响应未提供字幕轨';
    if (pageTrackError) {
      throw new Error(
        `页面字幕轨失败: ${pageTrackError.message}; youtubei/player 未提供字幕轨: ${reason}`
      );
    }

    throw new Error(reason);
  }

  const track = pickPreferredCaptionTrack(tracks);
  if (!track?.baseUrl) {
    const error = new Error('字幕轨缺少 baseUrl');
    if (pageTrackError) {
      throw new Error(`页面字幕轨失败: ${pageTrackError.message}; ${error.message}`);
    }

    throw error;
  }

  try {
    return {
      trackText: await requestTrackText(track),
      source: 'youtubei-player',
      fallbackReason: pageTrackError?.message,
      trackLanguageCode: track.languageCode,
      trackKind: track.kind,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (pageTrackError) {
      throw new Error(
        `页面字幕轨失败: ${pageTrackError.message}; youtubei/player 字幕轨失败: ${normalizedError.message}`
      );
    }

    throw normalizedError;
  }
}

export function findTranscriptTrigger(root: TranscriptQueryRoot): QueryElementLike | null {
  for (const selector of TRANSCRIPT_TRIGGER_SELECTORS) {
    const candidate = root.querySelector(selector);
    if (candidate && isTranscriptTriggerLabel(readElementLabel(candidate))) {
      return candidate;
    }
  }

  for (const candidate of Array.from(root.querySelectorAll('button'))) {
    if (isTranscriptTriggerLabel(readElementLabel(candidate))) {
      return candidate;
    }
  }

  return null;
}

export function getTranscriptPanel(root: ParentNode = document): Element | null {
  return root.querySelector(TRANSCRIPT_PANEL_SELECTOR);
}

export function getTranscriptPanelState(root: ParentNode = document): TranscriptPanelState {
  const panel = getTranscriptPanel(root);

  return {
    segmentCount: getTranscriptSegmentElements(root).length,
    hasSpinner: !!panel?.querySelector('tp-yt-paper-spinner'),
    hasContinuation: !!panel?.querySelector('ytd-continuation-item-renderer'),
  };
}

export function getTranscriptSegmentElements(root: ParentNode = document): Element[] {
  const selectors = [
    'transcript-segment-view-model',
    'ytd-transcript-segment-renderer',
    'ytd-transcript-segment-list-renderer #segments-container > ytd-transcript-segment-renderer',
    'ytd-transcript-segment-list-renderer #segments-container > *',
  ];

  for (const selector of selectors) {
    const elements = Array.from(root.querySelectorAll(selector));
    if (elements.length > 0) {
      return elements;
    }
  }

  return [];
}

export function isTranscriptReady(state: TranscriptPanelState): boolean {
  return state.segmentCount > 0;
}

export function hasYouTubeLoginPrompt(root: ParentNode = document): boolean {
  const pageText = root.textContent || '';
  return pageText.includes('确认你不是机器人') || pageText.includes('Sign in to confirm you’re not a bot');
}

export function shouldForceLegacyTranscriptOpen(
  clickedTranscriptTrigger: boolean,
  hasTranscriptPanel: boolean
): boolean {
  return !clickedTranscriptTrigger && hasTranscriptPanel;
}

function getTranscriptTimestampElement(segment: QueryElementLike): QueryElementLike | null {
  return (
    segment.querySelector?.('.segment-timestamp') ||
    segment.querySelector?.('[class*="timestamp"]') ||
    segment.querySelector?.('div[class*="time"]') ||
    segment.querySelector?.('#start-offset') ||
    segment.querySelector?.('.ytwTranscriptSegmentViewModelTimestamp') ||
    null
  );
}

function getTranscriptBodyElement(segment: QueryElementLike): QueryElementLike | null {
  return (
    segment.querySelector?.('.segment-text') ||
    segment.querySelector?.('[class*="text"]') ||
    segment.querySelector?.('yt-formatted-string') ||
    segment.querySelector?.('#segment-text') ||
    segment.querySelector?.('span[role="text"]') ||
    null
  );
}

function readNumericAttribute(
  element: QueryElementLike | null,
  attributeNames: readonly string[]
): number | null {
  if (!element?.getAttribute) {
    return null;
  }

  for (const attributeName of attributeNames) {
    const rawValue = element.getAttribute(attributeName);
    if (!rawValue) {
      continue;
    }

    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export function parseTranscriptTimestamp(timestampText: string): number {
  const normalized = timestampText.trim().replace(/[^\d:.]/g, '');
  if (!normalized) {
    return 0;
  }

  const parts = normalized.split(':');
  if (parts.some((part) => part.length === 0 || Number.isNaN(Number(part)))) {
    return 0;
  }

  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }

  return 0;
}

export function extractTranscriptSegmentStartTime(segment: QueryElementLike): number | null {
  const timestampElement = getTranscriptTimestampElement(segment);
  const attributeValueMs =
    readNumericAttribute(segment, TRANSCRIPT_START_TIME_ATTRIBUTES) ??
    readNumericAttribute(timestampElement, TRANSCRIPT_START_TIME_ATTRIBUTES);

  if (attributeValueMs !== null) {
    return attributeValueMs / 1000;
  }

  const timestampText = timestampElement?.textContent?.trim() || '';
  if (!timestampText) {
    return null;
  }

  return parseTranscriptTimestamp(timestampText);
}

export function extractTranscriptSegmentData(segment: QueryElementLike): {
  timestampText: string;
  bodyText: string;
} | null {
  const timestampElement = getTranscriptTimestampElement(segment);
  const bodyElement = getTranscriptBodyElement(segment);

  const timestampText = timestampElement?.textContent?.trim() || '';
  const bodyText = bodyElement?.textContent?.trim() || '';

  if (!timestampText || !bodyText) {
    return null;
  }

  return { timestampText, bodyText };
}

function readElementLabel(element: QueryElementLike): string {
  const ariaLabel = element.getAttribute?.('aria-label') || '';
  const text = element.textContent || '';
  return `${ariaLabel} ${text}`.trim();
}

function isTranscriptTriggerLabel(label: string): boolean {
  return TRANSCRIPT_TRIGGER_PATTERNS.some((pattern) => pattern.test(label));
}
