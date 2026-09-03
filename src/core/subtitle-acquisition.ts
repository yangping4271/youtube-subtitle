import { decodeHtmlEntities } from './transcript-text.js';
import { isNonSpeechCue } from './subtitle-data.js';
import { extractErrorMessage } from '../utils/error-handler.js';
import type { SimpleSubtitleEntry } from '../types/index.js';

export const ENGLISH_SUBTITLE_REQUIRED_MESSAGE =
  '当前视频没有英文字幕，仅支持翻译英文字幕。';

export class EnglishSubtitleRequiredError extends Error {
  constructor() {
    super(ENGLISH_SUBTITLE_REQUIRED_MESSAGE);
    this.name = 'EnglishSubtitleRequiredError';
  }
}

export interface SubtitleAcquisitionDiagnostics {
  transcriptApiError?: string;
  panelError?: string;
  fallbackReason?: string;
}

export interface SubtitleAcquisitionResult {
  subtitles: SimpleSubtitleEntry[];
  source: 'transcript-api' | 'transcript-panel';
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

export interface SubtitleAcquisitionDependencies {
  acquireTranscriptApiSubtitles: (videoId: string) => Promise<SimpleSubtitleEntry[]>;
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
    // YouTube transcript panel 用行首的 >> 表示说话人切换。只清理行首，
    // 保留代码和技术文本中的位移运算符等真实内容。
    .replace(/^\s*>{2,}\s*/, '')
    // 只删除明确识别出的非语音提示；[React]、foo(bar) 等内容必须保留。
    .replace(/\[[^\]]*\]|\([^)]*\)/g, (cue) => isNonSpeechCue(cue) ? ' ' : cue)
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
  // 相同开始时间和文本代表同一条字幕；合并时保留较晚的结束时间。
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
    const sourceEndTime = Number.isFinite(subtitle.endTime) && subtitle.endTime > subtitle.startTime
      ? subtitle.endTime
      : next && next.startTime > subtitle.startTime
        ? next.startTime
        : subtitle.startTime + 5;
    const endTime = next && next.startTime > subtitle.startTime
      ? Math.min(sourceEndTime, next.startTime)
      : sourceEndTime;

    return {
      ...subtitle,
      endTime,
    };
  });
}

export function createYouTubeSubtitleAcquirer(
  dependencies: SubtitleAcquisitionDependencies
): YouTubeSubtitleAcquirer {
  const reportBestEffort = (
    videoId: string,
    report: SubtitleAcquisitionReport
  ): void => {
    try {
      void Promise.resolve(dependencies.reportAcquisition(videoId, report)).catch(() => {});
    } catch {
      // Diagnostics must never turn successful subtitle acquisition into a failure.
    }
  };

  const buildResult = (
    subtitles: SimpleSubtitleEntry[],
    source: SubtitleAcquisitionResult['source'],
    diagnostics: SubtitleAcquisitionDiagnostics
  ): SubtitleAcquisitionResult => ({
    subtitles: normalizeSubtitleTiming(subtitles),
    source,
    diagnostics,
  });

  return {
    async acquire(videoId: string): Promise<SubtitleAcquisitionResult> {
      let transcriptApiError: string;

      try {
        const result = buildResult(
          await dependencies.acquireTranscriptApiSubtitles(videoId),
          'transcript-api',
          {}
        );
        if (result.subtitles.length === 0) {
          throw new Error('转写接口未返回可用字幕');
        }

        reportBestEffort(videoId, {
          source: result.source,
          subtitleCount: result.subtitles.length,
          diagnostics: result.diagnostics,
        });
        return result;
      } catch (error) {
        transcriptApiError = extractErrorMessage(error);
        if (error instanceof EnglishSubtitleRequiredError) {
          const diagnostics = { transcriptApiError };
          reportBestEffort(videoId, {
            source: 'unavailable',
            subtitleCount: 0,
            diagnostics,
          });
          throw new SubtitleAcquisitionError(
            ENGLISH_SUBTITLE_REQUIRED_MESSAGE,
            diagnostics
          );
        }
      }

      try {
        const result = buildResult(
          await dependencies.acquireTranscriptPanelSubtitles(),
          'transcript-panel',
          {
            transcriptApiError,
            fallbackReason: transcriptApiError,
          }
        );
        if (result.subtitles.length === 0) {
          throw new Error('转写面板未返回可用字幕');
        }

        reportBestEffort(videoId, {
          source: result.source,
          subtitleCount: result.subtitles.length,
          diagnostics: result.diagnostics,
        });
        return result;
      } catch (panelError) {
        const panelErrorMessage = extractErrorMessage(panelError);
        const diagnostics = {
          transcriptApiError,
          panelError: panelErrorMessage,
        };
        reportBestEffort(videoId, {
          source: 'unavailable',
          subtitleCount: 0,
          diagnostics,
        });
        throw new SubtitleAcquisitionError(panelErrorMessage, diagnostics);
      }
    },
  };
}
