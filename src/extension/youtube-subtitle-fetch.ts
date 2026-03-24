interface CaptionTrackResponseLike {
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

interface CaptionTrackLike {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
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

export function createYouTubeRequestInit(init: RequestInit = {}): RequestInit {
  return {
    credentials: 'include',
    ...init,
  };
}

export function extractCaptionTracks(response: CaptionTrackResponseLike | null | undefined): CaptionTrackLike[] {
  return (response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []) as CaptionTrackLike[];
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

export function extractTranscriptSegmentData(segment: QueryElementLike): {
  timestampText: string;
  bodyText: string;
} | null {
  const timestampElement =
    segment.querySelector?.('.segment-timestamp') ||
    segment.querySelector?.('[class*="timestamp"]') ||
    segment.querySelector?.('div[class*="time"]') ||
    segment.querySelector?.('#start-offset') ||
    segment.querySelector?.('.ytwTranscriptSegmentViewModelTimestamp');

  const bodyElement =
    segment.querySelector?.('.segment-text') ||
    segment.querySelector?.('[class*="text"]') ||
    segment.querySelector?.('yt-formatted-string') ||
    segment.querySelector?.('#segment-text') ||
    segment.querySelector?.('span[role="text"]');

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
