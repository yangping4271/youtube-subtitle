import { decodeHtmlEntities } from './transcript-text.js';
import { extractErrorMessage } from '../utils/error-handler.js';
import type { SimpleSubtitleEntry } from '../types/index.js';

export interface ResolvedCaptionTrackText {
  trackText: string;
  source: 'page-player-response' | 'youtubei-player';
  fallbackReason?: string;
  trackLanguageCode?: string;
  trackKind?: string;
}

export interface SubtitleAcquisitionDiagnostics {
  strategy?: ResolvedCaptionTrackText['source'];
  trackLanguageCode?: string;
  trackKind?: string;
  fallbackReason?: string;
  captionTrackError?: string;
  panelError?: string;
}

export interface SubtitleAcquisitionResult {
  subtitles: SimpleSubtitleEntry[];
  source: 'caption-tracks' | 'transcript-panel';
  diagnostics: SubtitleAcquisitionDiagnostics;
}

export interface SubtitleAcquisitionReport {
  source: SubtitleAcquisitionResult['source'] | 'unavailable';
  subtitleCount: number;
  diagnostics: SubtitleAcquisitionDiagnostics;
}

export class SubtitleAcquisitionError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: SubtitleAcquisitionDiagnostics
  ) {
    super(message);
    this.name = 'SubtitleAcquisitionError';
  }
}

interface TimedTextElement {
  textContent?: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<TimedTextElement>;
}

export interface TimedTextDocument {
  querySelector(selector: string): TimedTextElement | null;
  querySelectorAll(selector: string): ArrayLike<TimedTextElement>;
}

export interface SubtitleAcquisitionDependencies {
  captionTrackStrategies: Array<
    (videoId: string) => Promise<ResolvedCaptionTrackText>
  >;
  parseCaptionTrackDocument: (xml: string) => TimedTextDocument;
  acquireTranscriptPanelSubtitles: () => Promise<SimpleSubtitleEntry[]>;
  reportAcquisition: (
    videoId: string,
    report: SubtitleAcquisitionReport
  ) => Promise<void> | void;
}

export interface YouTubeSubtitleAcquirer {
  acquire(videoId: string): Promise<SubtitleAcquisitionResult>;
}

/**
 * 只规范化字幕文本中的空白，不改写重复词语。
 * 同时解码 HTML 实体（&#39; 等）、去除 [music] 类非语音标注和 >> 说话人标记，
 * 保证下载、复制和翻译链路拿到的都是干净文本。
 */
export function normalizeSubtitleText(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/>{2,}/g, '')
    .replace(/\s*(?:\[[^\]]*\]|\([^)]*\))/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSubtitleTiming(
  subtitles: SimpleSubtitleEntry[]
): SimpleSubtitleEntry[] {
  const sorted = subtitles
    .map((subtitle) => ({
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      text: normalizeSubtitleText(subtitle.text),
    }))
    .filter((subtitle) => subtitle.text.length > 0)
    .sort((a, b) => a.startTime - b.startTime);

  // YouTube 有时会在同一 panel 中同时保留可见节点和隐藏副本。
  // 相同开始时间和文本代表同一条字幕；合并时保留较晚的结束时间，
  // 避免重复节点把下一条字幕的开始时间误当成当前字幕的结束时间。
  const deduplicated: SimpleSubtitleEntry[] = [];
  const indexByKey = new Map<string, number>();
  sorted.forEach((subtitle) => {
    const key = `${subtitle.startTime}\u0000${subtitle.text}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, deduplicated.length);
      deduplicated.push(subtitle);
      return;
    }

    const existing = deduplicated[existingIndex];
    if (
      (!Number.isFinite(existing.endTime) || existing.endTime < subtitle.endTime) &&
      Number.isFinite(subtitle.endTime)
    ) {
      existing.endTime = subtitle.endTime;
    }
  });

  return deduplicated.map((subtitle, index) => {
    const next = deduplicated[index + 1];
    const endTime = Number.isFinite(subtitle.endTime) && subtitle.endTime > subtitle.startTime
      ? subtitle.endTime
      : next && next.startTime > subtitle.startTime
        ? next.startTime
        : subtitle.startTime + 5;

    return {
      ...subtitle,
      endTime,
    };
  });
}

function parseSrv3SpanSubtitles(doc: TimedTextDocument): SimpleSubtitleEntry[] {
  const subtitles: SimpleSubtitleEntry[] = [];
  Array.from(doc.querySelectorAll('p')).forEach((paragraph) => {
    const paragraphStartMs = Number(paragraph.getAttribute('t'));
    if (Number.isNaN(paragraphStartMs)) {
      return;
    }

    const paragraphDurationMs = Number(paragraph.getAttribute('d'));
    const paragraphEndMs = Number.isNaN(paragraphDurationMs)
      ? null
      : paragraphStartMs + paragraphDurationMs;
    const spans = Array.from(paragraph.querySelectorAll('s'));
    if (spans.length === 0) {
      return;
    }

    const offsets = spans.map((span) => {
      const offset = Number(span.getAttribute('t'));
      return Number.isNaN(offset) ? null : offset;
    });
    if (!offsets.some((offset) => offset !== null)) {
      return;
    }

    spans.forEach((span, index) => {
      const text = span.textContent || '';
      if (!text.trim()) {
        return;
      }

      const relativeStartMs = offsets[index] ?? (index === 0 ? 0 : offsets[index - 1] ?? 0);
      const nextOffset = offsets.slice(index + 1).find((offset) => offset !== null) ?? null;
      const startMs = paragraphStartMs + relativeStartMs;
      const endMs = nextOffset !== null
        ? paragraphStartMs + nextOffset
        : paragraphEndMs ?? startMs;

      subtitles.push({
        startTime: startMs / 1000,
        endTime: endMs / 1000,
        text,
      });
    });
  });

  return subtitles;
}

function parseLegacyTimedTextSubtitles(doc: TimedTextDocument): SimpleSubtitleEntry[] {
  const subtitles: SimpleSubtitleEntry[] = [];
  Array.from(doc.querySelectorAll('text')).forEach((segment) => {
    const start = Number(segment.getAttribute('start'));
    if (Number.isNaN(start)) {
      return;
    }

    const duration = Number(segment.getAttribute('dur'));
    const text = segment.textContent || '';
    if (!text.trim()) {
      return;
    }

    subtitles.push({
      startTime: start,
      endTime: Number.isNaN(duration) ? start : start + duration,
      text,
    });
  });

  return subtitles;
}

function parseSrv3ParagraphSubtitles(doc: TimedTextDocument): SimpleSubtitleEntry[] {
  const subtitles: SimpleSubtitleEntry[] = [];
  Array.from(doc.querySelectorAll('p')).forEach((paragraph) => {
    const startMs = Number(paragraph.getAttribute('t'));
    if (Number.isNaN(startMs)) {
      return;
    }

    const durationMs = Number(paragraph.getAttribute('d'));
    const spanText = Array.from(paragraph.querySelectorAll('s'))
      .map((span) => span.textContent || '')
      .join('');
    const text = spanText || paragraph.textContent || '';
    if (!text.trim()) {
      return;
    }

    subtitles.push({
      startTime: startMs / 1000,
      endTime: Number.isNaN(durationMs)
        ? startMs / 1000
        : (startMs + durationMs) / 1000,
      text,
    });
  });

  return subtitles;
}

function parseTimedTextDocument(doc: TimedTextDocument): SimpleSubtitleEntry[] {
  if (doc.querySelector('parsererror')) {
    throw new Error('字幕 XML 解析失败');
  }

  const srv3Subtitles = parseSrv3SpanSubtitles(doc);
  const paragraphSubtitles = srv3Subtitles.length > 0
    ? []
    : parseSrv3ParagraphSubtitles(doc);
  return normalizeSubtitleTiming(
    srv3Subtitles.length > 0
      ? srv3Subtitles
      : paragraphSubtitles.length > 0
        ? paragraphSubtitles
        : parseLegacyTimedTextSubtitles(doc)
  );
}

export function createYouTubeSubtitleAcquirer(
  dependencies: SubtitleAcquisitionDependencies
): YouTubeSubtitleAcquirer {
  const reportBestEffort = async (
    videoId: string,
    report: SubtitleAcquisitionReport
  ): Promise<void> => {
    try {
      await dependencies.reportAcquisition(videoId, report);
    } catch {
      // Diagnostics must never turn successful subtitle acquisition into a failure.
    }
  };

  return {
    async acquire(videoId: string): Promise<SubtitleAcquisitionResult> {
      const captionTrackErrors: string[] = [];

      for (const acquireCaptionTrack of dependencies.captionTrackStrategies) {
        try {
          const resolution = await acquireCaptionTrack(videoId);
          const document = dependencies.parseCaptionTrackDocument(resolution.trackText);
          const subtitles = parseTimedTextDocument(document);
          if (subtitles.length === 0) {
            throw new Error('字幕轨未返回可用字幕');
          }

          const fallbackReason = [
            ...captionTrackErrors,
            resolution.fallbackReason,
          ].filter((reason): reason is string => Boolean(reason)).join('; ');
          const result: SubtitleAcquisitionResult = {
            subtitles,
            source: 'caption-tracks',
            diagnostics: {
              strategy: resolution.source,
              ...(resolution.trackLanguageCode
                ? { trackLanguageCode: resolution.trackLanguageCode }
                : {}),
              ...(resolution.trackKind ? { trackKind: resolution.trackKind } : {}),
              ...(fallbackReason ? { fallbackReason } : {}),
            },
          };
          void reportBestEffort(videoId, {
            source: result.source,
            subtitleCount: result.subtitles.length,
            diagnostics: result.diagnostics,
          });
          return result;
        } catch (error) {
          captionTrackErrors.push(extractErrorMessage(error));
        }
      }

      const captionTrackError = captionTrackErrors.join('; ') || '字幕轨不可用';
      try {
        const subtitles = normalizeSubtitleTiming(
          await dependencies.acquireTranscriptPanelSubtitles()
        );
        if (subtitles.length === 0) {
          throw new Error('转写面板未返回可用字幕');
        }

        const result: SubtitleAcquisitionResult = {
          subtitles,
          source: 'transcript-panel',
          diagnostics: {
            captionTrackError,
            fallbackReason: captionTrackError,
          },
        };
        void reportBestEffort(videoId, {
          source: result.source,
          subtitleCount: result.subtitles.length,
          diagnostics: result.diagnostics,
        });
        return result;
      } catch (panelError) {
        const panelErrorMessage = extractErrorMessage(panelError);
        const loginError = captionTrackErrors.find((error) =>
          /登录|sign in/i.test(error)
        );
        const message = loginError || panelErrorMessage;
        const diagnostics = {
          captionTrackError,
          panelError: panelErrorMessage,
        };

        void reportBestEffort(videoId, {
          source: 'unavailable',
          subtitleCount: 0,
          diagnostics,
        });

        throw new SubtitleAcquisitionError(message, diagnostics);
      }
    },
  };
}
