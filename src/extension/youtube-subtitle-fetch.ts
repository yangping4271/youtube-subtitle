import {
  createYouTubeSubtitleAcquirer,
  normalizeSubtitleText,
  normalizeSubtitleTiming,
} from '../core/subtitle-acquisition.js';
import type {
  ResolvedCaptionTrackText,
  SubtitleAcquisitionReport,
  SubtitleAcquisitionResult,
  TimedTextDocument,
} from '../core/subtitle-acquisition.js';
import type { SimpleSubtitleEntry } from '../types/index.js';
import { normalizeSubtitleFetchErrorMessage } from './subtitle-fetch-log.js';

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
  type: 'YTSP_PageCaptionTracks' | 'YTSP_WebPlayerResponse';
  payload: CaptionTrackResponseLike | null;
}

interface QueryElementLike {
  textContent?: string | null;
  innerText?: string | null;
  hidden?: boolean;
  style?: {
    display?: string;
    visibility?: string;
  };
  tagName?: string;
  getAttribute?(name: string): string | null;
  querySelector?(selector: string): QueryElementLike | null;
  getClientRects?(): { length: number };
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

export interface PageCaptionTrackResolutionOptions {
  requestPageResponse?: () => Promise<CaptionTrackResponseLike | null>;
  requestTrackText?: (track: CaptionTrackLike) => Promise<string>;
}

export interface PlayerCaptionTrackResolutionOptions {
  requestPlayerResponse?: (videoId: string) => Promise<CaptionTrackResponseLike>;
  requestTrackText?: (track: CaptionTrackLike) => Promise<string>;
}

const TRANSCRIPT_PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"], ' +
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
  return requestMainWorldPlayerResponse(
    'YTSP_RequestCaptionTracks',
    'YTSP_PageCaptionTracks',
    undefined,
    timeoutMs
  );
}

export function requestWebPlayerResponse(
  videoId: string,
  timeoutMs = 5000
): Promise<CaptionTrackResponseLike | null> {
  return requestMainWorldPlayerResponse(
    'YTSP_RequestWebPlayerResponse',
    'YTSP_WebPlayerResponse',
    { videoId },
    timeoutMs
  );
}

function requestMainWorldPlayerResponse(
  requestType: string,
  responseType: WindowCaptionTrackMessage['type'],
  detail: unknown,
  timeoutMs: number
): Promise<CaptionTrackResponseLike | null> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent<WindowCaptionTrackMessage>): void => {
      if (event.source !== window || event.data?.type !== responseType) {
        return;
      }

      window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      resolve((event.data.payload as CaptionTrackResponseLike | null) || null);
    };

    window.addEventListener('message', onMessage);
    window.dispatchEvent(new CustomEvent(requestType, { detail }));
  });
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

export async function resolvePageCaptionTrackText(
  options: PageCaptionTrackResolutionOptions = {}
): Promise<ResolvedCaptionTrackText> {
  const requestPageResponse = options.requestPageResponse || requestPageCaptionTrackResponse;
  const requestTrackText = options.requestTrackText || fetchCaptionTrackText;
  const pagePlayerResponse = await requestPageResponse();
  const track = pickPreferredCaptionTrack(extractCaptionTracks(pagePlayerResponse));
  if (!track?.baseUrl) {
    throw new Error('页面 player response 未提供字幕轨');
  }

  return {
    trackText: await requestTrackText(track),
    source: 'page-player-response',
    trackLanguageCode: track.languageCode,
    trackKind: track.kind,
  };
}

export async function resolvePlayerCaptionTrackText(
  videoId: string,
  options: PlayerCaptionTrackResolutionOptions = {}
): Promise<ResolvedCaptionTrackText> {
  const requestPlayerResponse = options.requestPlayerResponse ||
    (async (requestedVideoId: string) => {
      const response = await requestWebPlayerResponse(requestedVideoId);
      if (!response) {
        throw new Error('网页 player 接口未返回响应');
      }
      return response;
    });
  const requestTrackText = options.requestTrackText || fetchCaptionTrackText;
  const playerResponse = await requestPlayerResponse(videoId);
  const responseClassification = classifyCaptionTrackResponse(playerResponse);
  if (responseClassification.kind === 'login_required') {
    throw new Error(responseClassification.message || '请先登录 YouTube 后重试。');
  }

  const tracks = extractCaptionTracks(playerResponse);
  if (tracks.length === 0) {
    throw new Error(responseClassification.message || 'player 响应未提供字幕轨');
  }

  const track = pickPreferredCaptionTrack(tracks);
  if (!track?.baseUrl) {
    throw new Error('字幕轨缺少 baseUrl');
  }

  return {
    trackText: await requestTrackText(track),
    source: 'web-player-response',
    trackLanguageCode: track.languageCode,
    trackKind: track.kind,
  };
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
  const candidates = Array.from(root.querySelectorAll(TRANSCRIPT_PANEL_SELECTOR));
  const visiblePanel = candidates.find((candidate) => isVisibleElement(candidate));
  if (visiblePanel) {
    return visiblePanel;
  }

  // 保持对测试桩和旧 DOM 实现的兼容，但仍然拒绝明确隐藏的 panel。
  const candidate = root.querySelector(TRANSCRIPT_PANEL_SELECTOR);
  return isVisibleElement(candidate) ? candidate as Element : null;
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
  const transcriptPanel = getTranscriptPanel(root);
  if (!transcriptPanel) {
    return [];
  }

  const searchRoot = transcriptPanel;
  const selectors = [
    'transcript-segment-view-model',
    'ytd-transcript-segment-renderer',
    'ytd-transcript-segment-list-renderer #segments-container > ytd-transcript-segment-renderer',
    'ytd-transcript-segment-list-renderer #segments-container > *',
  ];

  for (const selector of selectors) {
    const elements = Array.from(searchRoot.querySelectorAll(selector));
    if (elements.length > 0) {
      return elements;
    }
  }

  return [];
}

function isVisibleElement(element: QueryElementLike | null | undefined): boolean {
  if (!element) return false;
  if (element.hidden) return false;
  if (element.getAttribute?.('aria-hidden') === 'true') return false;
  const hiddenAttribute = element.getAttribute?.('hidden');
  if (hiddenAttribute !== undefined && hiddenAttribute !== null) return false;

  const style = element.style;
  if (style?.display === 'none' || style?.visibility === 'hidden') {
    return false;
  }

  if (typeof window !== 'undefined'
    && typeof window.getComputedStyle === 'function'
    && element instanceof Element) {
    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
      return false;
    }
  }

  // jsdom/测试桩通常没有布局信息；只有在浏览器提供该 API 时才使用它。
  if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
    return false;
  }

  return true;
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

export function shouldWaitForTranscriptPanel(
  clickedTranscriptTrigger: boolean,
  hasTranscriptPanel: boolean
): boolean {
  return clickedTranscriptTrigger || hasTranscriptPanel;
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
    segment.querySelector?.('span[role="text"]') ||
    segment.querySelector?.('.segment-text') ||
    segment.querySelector?.('[class*="text"]') ||
    segment.querySelector?.('yt-formatted-string') ||
    segment.querySelector?.('#segment-text') ||
    null
  );
}

function readElementText(element: QueryElementLike | null | undefined): string {
  const visibleText = typeof element?.innerText === 'string' ? element.innerText : '';
  const text = visibleText || element?.textContent || '';
  return normalizeSubtitleText(text);
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

  const timestampText = readElementText(timestampElement);
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

  const timestampText = readElementText(timestampElement);
  const bodyText = readElementText(bodyElement);

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTranscriptPanelSubtitles(): SimpleSubtitleEntry[] {
  const segments = getTranscriptSegmentElements(document);
  const subtitles: SimpleSubtitleEntry[] = [];

  segments.forEach((segment, index) => {
    const segmentData = extractTranscriptSegmentData(segment);
    const fallbackDivs = segment.querySelectorAll('div');
    const timestampText =
      segmentData?.timestampText ||
      readElementText(fallbackDivs[0]);
    const text =
      segmentData?.bodyText ||
      readElementText(fallbackDivs[1]);

    if (!timestampText || !text) {
      return;
    }

    const startTime =
      extractTranscriptSegmentStartTime(segment) ??
      parseTranscriptTimestamp(timestampText);
    const nextSegment = segments[index + 1];
    const nextData = nextSegment ? extractTranscriptSegmentData(nextSegment) : null;
    const nextTimestampText =
      nextData?.timestampText ||
      readElementText(nextSegment?.querySelector('div'));
    const endTime = nextSegment && nextTimestampText
      ? extractTranscriptSegmentStartTime(nextSegment) ??
        parseTranscriptTimestamp(nextTimestampText)
      : startTime + 5;

    subtitles.push({ startTime, endTime, text });
  });

  return normalizeSubtitleTiming(subtitles);
}

async function acquireTranscriptPanelSubtitles(): Promise<SimpleSubtitleEntry[]> {
  if (!isTranscriptReady(getTranscriptPanelState(document))) {
    const moreButton = document.querySelector('#expand') as HTMLElement | null;
    if (moreButton) {
      moreButton.click();
      await delay(400);
    }

    let clickedTranscriptTrigger = false;
    const transcriptTrigger = findTranscriptTrigger(document);
    if (transcriptTrigger instanceof HTMLElement) {
      transcriptTrigger.click();
      clickedTranscriptTrigger = true;
      await delay(400);
    }

    const transcriptPanel = getTranscriptPanel(document);
    if (shouldForceLegacyTranscriptOpen(clickedTranscriptTrigger, !!transcriptPanel)) {
      window.dispatchEvent(new CustomEvent('YTSP_OpenTranscript'));
    }

    if (!shouldWaitForTranscriptPanel(clickedTranscriptTrigger, !!transcriptPanel)) {
      if (hasYouTubeLoginPrompt(document)) {
        throw new Error('YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。');
      }

      throw new Error('转写面板已打开，但字幕内容尚未加载完成，请稍后重试。');
    }

    for (let retry = 0; retry < 20; retry += 1) {
      if (isTranscriptReady(getTranscriptPanelState(document))) {
        break;
      }
      await delay(500);
    }
  }

  const subtitles = readTranscriptPanelSubtitles();
  if (subtitles.length > 0) {
    return subtitles;
  }

  if (hasYouTubeLoginPrompt(document)) {
    throw new Error('YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。');
  }

  throw new Error('转写面板已打开，但字幕内容尚未加载完成，请稍后重试。');
}

async function reportAcquisition(
  videoId: string,
  report: SubtitleAcquisitionReport
): Promise<void> {
  const runtime = (
    globalThis as typeof globalThis & {
      chrome?: {
        runtime?: {
          id?: string;
          sendMessage?: (message: unknown) => Promise<unknown>;
        };
      };
    }
  ).chrome?.runtime;

  if (!runtime?.id || typeof runtime.sendMessage !== 'function') {
    return;
  }

  const diagnostics = Object.fromEntries(
    Object.entries(report.diagnostics).map(([key, value]) => [
      key,
      typeof value === 'string' ? normalizeSubtitleFetchErrorMessage(value) : value,
    ])
  );

  await runtime.sendMessage({
    action: 'logSubtitleFetchSource',
    videoId,
    data: {
      source: report.source,
      subtitleCount: report.subtitleCount,
      ...diagnostics,
    },
  });
}

const defaultSubtitleAcquirer = createYouTubeSubtitleAcquirer({
  captionTrackStrategies: [
    () => resolvePageCaptionTrackText(),
    (videoId) => resolvePlayerCaptionTrackText(videoId),
  ],
  parseCaptionTrackDocument: (xml): TimedTextDocument =>
    new DOMParser().parseFromString(xml, 'text/xml'),
  acquireTranscriptPanelSubtitles,
  reportAcquisition,
});

export function acquireYouTubeSubtitles(
  videoId: string
): Promise<SubtitleAcquisitionResult> {
  return defaultSubtitleAcquirer.acquire(videoId);
}
