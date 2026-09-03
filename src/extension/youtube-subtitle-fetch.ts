import {
  createYouTubeSubtitleAcquirer,
  EnglishSubtitleRequiredError,
  normalizeSubtitleText,
  normalizeSubtitleTiming,
} from '../core/subtitle-acquisition.js';
import type {
  SubtitleAcquisitionReport,
  SubtitleAcquisitionResult,
} from '../core/subtitle-acquisition.js';
import type { SimpleSubtitleEntry } from '../types/index.js';
import { normalizeSubtitleFetchErrorMessage } from './subtitle-fetch-log.js';

interface WindowTranscriptPanelMessage {
  type: 'YTSP_TranscriptPanelResponse';
  payload: unknown;
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
  closest?(selector: string): QueryElementLike | null;
  getClientRects?(): { length: number };
}

interface TranscriptQueryRoot {
  querySelector(selector: string): QueryElementLike | null;
  querySelectorAll(selector: string): QueryElementLike[] | NodeListOf<Element>;
}

export interface TranscriptPanelState {
  segmentCount: number;
  hasSpinner: boolean;
  hasContinuation?: boolean;
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

export function requestTranscriptPanelResponse(
  videoId?: string,
  timeoutMs = 5000
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent<WindowTranscriptPanelMessage>): void => {
      if (
        event.source !== window ||
        event.data?.type !== 'YTSP_TranscriptPanelResponse'
      ) {
        return;
      }
      const payload = event.data.payload;
      if (
        videoId &&
        (!payload || typeof payload !== 'object' ||
          (payload as { videoId?: unknown }).videoId !== videoId)
      ) {
        return;
      }

      window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      resolve(payload || null);
    };

    window.addEventListener('message', onMessage);
    window.dispatchEvent(new CustomEvent('YTSP_RequestTranscriptPanel', {
      detail: { videoId },
    }));
  });
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
  const knownPanels = Array.from(root.querySelectorAll(TRANSCRIPT_PANEL_SELECTOR));
  const segmentPanels = Array.from(
    root.querySelectorAll('transcript-segment-view-model')
  ).flatMap((segment) => {
    const panel = (segment as QueryElementLike).closest?.(
      'ytd-engagement-panel-section-list-renderer'
    );
    return panel ? [panel] : [];
  });
  const candidates = [...knownPanels, ...segmentPanels];
  const visiblePanel = candidates.find((candidate) => isVisibleElement(candidate));
  if (visiblePanel) {
    return visiblePanel as Element;
  }

  // 保持对测试桩和旧 DOM 实现的兼容，但仍然拒绝明确隐藏的 panel。
  const candidate = root.querySelector(TRANSCRIPT_PANEL_SELECTOR);
  return isVisibleElement(candidate) ? candidate as Element : null;
}

function getAnyTranscriptPanel(root: ParentNode = document): Element | null {
  const knownPanels = Array.from(root.querySelectorAll(TRANSCRIPT_PANEL_SELECTOR));
  const segmentPanels = [
    ...Array.from(root.querySelectorAll('transcript-segment-view-model')),
    ...Array.from(root.querySelectorAll('ytd-transcript-segment-renderer')),
  ].flatMap((segment) => {
    const panel = segment.closest('ytd-engagement-panel-section-list-renderer');
    return panel ? [panel] : [];
  });
  const candidates = [...new Set([...knownPanels, ...segmentPanels])];

  return candidates.find((panel) =>
    panel.querySelector(
      'transcript-segment-view-model, ytd-transcript-segment-renderer'
    )
  ) || candidates[0] || null;
}

export function getTranscriptPanelState(root: ParentNode = document): TranscriptPanelState {
  const panel = getTranscriptPanel(root);

  return {
    segmentCount: getTranscriptSegmentElements(root).length,
    hasSpinner: !!panel?.querySelector('tp-yt-paper-spinner'),
    hasContinuation: !!panel?.querySelector('ytd-continuation-item-renderer'),
  };
}

export function getTranscriptSegmentElements(
  root: ParentNode = document,
  includeHiddenPanel = false
): Element[] {
  const transcriptPanel = includeHiddenPanel
    ? getAnyTranscriptPanel(root)
    : getTranscriptPanel(root);
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

export function extractTranscriptPanelResponseSubtitles(
  response: unknown
): SimpleSubtitleEntry[] {
  const segments: Array<{ timestamp: string; text: string }> = [];
  const legacySegments = (
    response as {
      legacyDomSegments?: Array<{ timestamp?: unknown; text?: unknown }>;
    } | null
  )?.legacyDomSegments;
  if (Array.isArray(legacySegments)) {
    legacySegments.forEach((segment) => {
      if (
        typeof segment.timestamp === 'string' &&
        typeof segment.text === 'string'
      ) {
        segments.push({
          timestamp: segment.timestamp,
          text: segment.text,
        });
      }
    });
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    const model = record.transcriptSegmentViewModel;
    if (model && typeof model === 'object') {
      const segment = model as Record<string, unknown>;
      if (
        typeof segment.timestamp === 'string' &&
        typeof segment.simpleText === 'string'
      ) {
        segments.push({
          timestamp: segment.timestamp,
          text: segment.simpleText,
        });
      }
    }

    Object.values(record).forEach(visit);
  };

  visit(response);

  return normalizeSubtitleTiming(segments.map((segment, index) => {
    const startTime = parseTranscriptTimestamp(segment.timestamp);
    const next = segments[index + 1];
    const endTime = next
      ? parseTranscriptTimestamp(next.timestamp)
      : startTime + 5;

    return {
      startTime,
      endTime,
      text: segment.text,
    };
  }));
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

function readTranscriptPanelSubtitles(
  includeHiddenPanel = false
): SimpleSubtitleEntry[] {
  const segments = getTranscriptSegmentElements(document, includeHiddenPanel);
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
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (videoId) {
      window.dispatchEvent(new CustomEvent('YTSP_MarkTranscriptPanel', {
        detail: { videoId },
      }));
    }
    return subtitles;
  }

  if (hasYouTubeLoginPrompt(document)) {
    throw new Error('YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。');
  }

  throw new Error('转写面板已打开，但字幕内容尚未加载完成，请稍后重试。');
}

async function acquireTranscriptPanelApiSubtitles(
  videoId: string
): Promise<SimpleSubtitleEntry[]> {
  const payload = await requestTranscriptPanelResponse(videoId, 7000) as {
    status?: string;
    response?: unknown;
  } | null;
  if (payload?.status === 'english-unavailable') {
    throw new EnglishSubtitleRequiredError();
  }

  const subtitles = extractTranscriptPanelResponseSubtitles(
    payload?.status === 'ok' ? payload.response : null
  );
  if (subtitles.length === 0) {
    throw new Error('转写接口未返回可用字幕');
  }

  return subtitles;
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
  acquireTranscriptApiSubtitles: acquireTranscriptPanelApiSubtitles,
  acquireTranscriptPanelSubtitles,
  reportAcquisition,
});

export function acquireYouTubeSubtitles(
  videoId: string
): Promise<SubtitleAcquisitionResult> {
  return defaultSubtitleAcquirer.acquire(videoId);
}
