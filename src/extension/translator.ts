/**
 * Chrome Extension translation session adapter.
 * 负责配置加载、秒/毫秒转换和进度持久化。
 */

import {
  TranslationSession,
  type TranslationSessionObserver,
} from '../core/translation-session.js';
import { OpenAIClient } from '../services/openai-client.js';
import { extractErrorMessage } from '../utils/error-handler.js';
import type {
  ApiConfig,
  BilingualSubtitles,
  SimpleSubtitleEntry,
  SubtitleEntry,
  TranslationProgress,
  TranslationContext,
  TranslationVideoInfo,
  VideoSubtitleData,
} from '../types/index.js';
import { buildTranslatorConfig, loadConfig } from './config.js';
import type { CancellationSignal } from '../utils/cancellation.js';
import type {
  TranslationRunEvent,
  TranslationRunPublication,
} from './translation-run-gate.js';

export interface ExtensionTranslationRequest {
  subtitles: SimpleSubtitleEntry[];
  targetLanguage?: string;
  context?: TranslationContext;
  signal?: AbortSignal;
  apiConfig?: Partial<ApiConfig>;
}

export interface ExtensionTranslationObserver {
  onProgress?: (
    step: string,
    current: number,
    total: number
  ) => Promise<void> | void;
  onPartialResult?: (
    partial: ExtensionBilingualSubtitles,
    signal?: CancellationSignal
  ) => Promise<void> | void;
}

/** Browser-facing subtitle entries use seconds, unlike core entries which use milliseconds. */
export interface ExtensionBilingualSubtitles {
  english: SimpleSubtitleEntry[];
  chinese: SimpleSubtitleEntry[];
}

export interface ExtensionTranslationExecutor {
  translate(
    request: ExtensionTranslationRequest,
    observer?: ExtensionTranslationObserver
  ): Promise<ExtensionBilingualSubtitles>;
}

export interface BrowserTranslationCoordinatorStore {
  getProgress(): Promise<TranslationProgress | null>;
  saveProgress(progress: TranslationProgress): Promise<void>;
  clearProgress(): Promise<void>;
  getPendingJob(): Promise<BrowserTranslationJob | null>;
  savePendingJob(job: BrowserTranslationJob): Promise<void>;
  clearPendingJob(jobId?: string): Promise<void>;
  getVideoResult(videoId: string): Promise<VideoSubtitleData | null>;
  saveVideoResult(videoId: string, result: VideoSubtitleData): Promise<void>;
  clearVideoResult(videoId: string): Promise<void>;
}

export interface BrowserTranslationCoordinatorPublisher {
  clear(tabId?: number, event?: TranslationRunEvent): Promise<void>;
  publishPartial(
    tabId: number | undefined,
    partial: ExtensionBilingualSubtitles,
    publication: TranslationRunPublication
  ): Promise<void>;
  publishFinal(
    tabId: number | undefined,
    result: ExtensionBilingualSubtitles,
    publication: TranslationRunPublication
  ): Promise<void>;
}

export interface BrowserTranslationStartRequest {
  videoId?: string;
  tabId?: number;
  subtitles: SimpleSubtitleEntry[];
  targetLanguage?: string;
  apiConfig?: Partial<ApiConfig>;
  videoInfo?: TranslationVideoInfo;
}

/** Service worker 被回收后用于恢复翻译会话的持久化任务。 */
export interface BrowserTranslationJob {
  id: string;
  request: BrowserTranslationStartRequest;
  /** 内容层用于拒绝乱序 run 事件的单调代际；旧存储数据可能没有该字段。 */
  generation?: number;
  updatedAt: number;
}

export interface BrowserTranslationCancelRequest {
  videoId?: string;
  tabId?: number;
}

export interface BrowserTranslationStatus {
  isTranslating: boolean;
  progress: TranslationProgress | null;
  cachedResult: VideoSubtitleData | null;
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

function msToSeconds(ms: number): number {
  return ms / 1000;
}

function toCoreSubtitles(subtitles: SimpleSubtitleEntry[]): SubtitleEntry[] {
  return subtitles.map((subtitle, index) => ({
    index: index + 1,
    startTime: secondsToMs(subtitle.startTime),
    endTime: secondsToMs(subtitle.endTime),
    text: subtitle.text,
  }));
}

function toExtensionSubtitles(result: BilingualSubtitles): ExtensionBilingualSubtitles {
  return {
    english: result.english.map((entry) => ({
      ...entry,
      startTime: msToSeconds(entry.startTime),
      endTime: msToSeconds(entry.endTime),
    })),
    chinese: result.chinese.map((entry) => ({
      ...entry,
      startTime: msToSeconds(entry.startTime),
      endTime: msToSeconds(entry.endTime),
    })),
  };
}

export class TranslationSessionAdapter implements ExtensionTranslationExecutor {
  async translate(
    request: ExtensionTranslationRequest,
    observer: ExtensionTranslationObserver = {}
  ): Promise<ExtensionBilingualSubtitles> {
    const config = request.apiConfig
      ? buildTranslatorConfig(request.apiConfig)
      : await loadConfig();
    config.targetLanguage = request.targetLanguage || 'zh';

    const session = new TranslationSession(config, new OpenAIClient(config));
    const coreObserver: TranslationSessionObserver = {
      onProgress: observer.onProgress,
      onPartialResult: async (partial, signal) => {
        await observer.onPartialResult?.(toExtensionSubtitles(partial), signal);
      },
    };

    const result = await session.translate(
      {
        subtitles: toCoreSubtitles(request.subtitles),
        context: request.context,
        signal: request.signal,
      },
      coreObserver
    );
    return toExtensionSubtitles(result);
  }
}

export const translationSessionAdapter = new TranslationSessionAdapter();

/**
 * Owns one browser-side translation run from request normalization through publication.
 * Popup, content and background callers all cross this interface.
 */
/**
 * 浏览器层的 run coordinator：负责启动、恢复、取消并管理多次 core TranslationSession。
 */
export class BrowserTranslationCoordinator {
  private activeRun: {
    controller: AbortController;
    videoId?: string;
    jobId: string;
    generation: number;
  } | null = null;
  private runVersion = 0;
  private lastRunGeneration = 0;
  private resumeInFlight = false;

  constructor(
    private readonly executor: ExtensionTranslationExecutor,
    private readonly store: BrowserTranslationCoordinatorStore,
    private readonly publisher: BrowserTranslationCoordinatorPublisher,
    private readonly now: () => number = Date.now
  ) {}

  async start(
    request: BrowserTranslationStartRequest,
    existingJobId?: string,
    onPrepared?: () => void,
    existingGeneration?: number
  ): Promise<void> {
    if (this.activeRun && request.videoId && this.activeRun.videoId === request.videoId) {
      onPrepared?.();
      return;
    }

    this.activeRun?.controller.abort();

    const controller = new AbortController();
    this.runVersion += 1;
    const generation = existingGeneration ?? this.nextRunGeneration();
    this.lastRunGeneration = Math.max(this.lastRunGeneration, generation);
    const jobId = existingJobId || `translation-${this.now()}-${this.runVersion}`;
    const run = { controller, videoId: request.videoId, jobId, generation };
    this.activeRun = run;
    const heartbeat = setInterval(() => {
      if (this.activeRun === run && !controller.signal.aborted) {
        void this.touchPendingJobBestEffort(run, request);
      }
    }, 15_000);
    let prepared = false;

    try {
      // 首次持久化是 MV3 恢复机制的前置条件，失败时不能向调用方报告“已启动”。
      await this.store.savePendingJob({
        id: jobId,
        request,
        generation,
        updatedAt: this.now(),
      });
      if (this.activeRun !== run) return;
      onPrepared?.();
      prepared = true;

      if (request.videoId) {
        await this.store.clearVideoResult(request.videoId);
      }
      if (this.activeRun !== run) return;

      await this.publisher.clear(request.tabId, {
        type: 'activate',
        runId: jobId,
        generation,
      });
      if (this.activeRun !== run) return;

      await this.saveProgressBestEffort({
        isTranslating: true,
        videoId: request.videoId,
        step: 'start',
        current: 0,
        total: request.subtitles.length,
        timestamp: this.now(),
      });
      if (this.activeRun !== run) return;

      const result = await this.executor.translate(
        {
          subtitles: request.subtitles,
          targetLanguage: request.targetLanguage,
          apiConfig: request.apiConfig,
          context: request.videoInfo
            ? {
              videoTitle: request.videoInfo.ytTitle || request.videoInfo.title,
              videoDescription: request.videoInfo.description,
              aiSummary: request.videoInfo.aiSummary,
            }
            : undefined,
          signal: controller.signal,
        },
        {
          onProgress: async (step, current, total) => {
            if (this.activeRun !== run || controller.signal.aborted) return;
            await this.saveProgressBestEffort({
              isTranslating: true,
              videoId: request.videoId,
              step,
              current,
              total,
              timestamp: this.now(),
            });
            await this.touchPendingJobBestEffort(run, request);
          },
          onPartialResult: async (partial, signal) => {
            const publishSignal = signal || controller.signal;
            if (this.activeRun !== run || publishSignal.aborted) return;
            try {
              await this.publisher.publishPartial(request.tabId, partial, {
                runId: jobId,
                videoId: request.videoId,
                signal: publishSignal,
              });
            } catch {}
          },
        }
      );

      if (this.activeRun !== run || controller.signal.aborted) return;

      if (request.videoId) {
        await this.store.saveVideoResult(request.videoId, {
          videoId: request.videoId,
          timestamp: new Date(this.now()).toISOString(),
          englishSubtitles: result.english,
          chineseSubtitles: result.chinese,
        });
      }
      if (this.activeRun !== run || controller.signal.aborted) return;

      await this.publisher.publishFinal(request.tabId, result, {
        runId: jobId,
        videoId: request.videoId,
        signal: controller.signal,
      });
      if (this.activeRun !== run || controller.signal.aborted) return;
      await this.store.saveProgress({
        isTranslating: false,
        completed: true,
        videoId: request.videoId,
        timestamp: this.now(),
      });
      await this.clearPendingJobBestEffort(jobId);
    } catch (error) {
      if (!prepared) {
        throw error;
      }

      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        if (this.activeRun === run) {
          controller.abort();
          await this.publisher.clear(request.tabId, {
            type: 'invalidate',
            runId: jobId,
          });
          await this.store.clearProgress();
          await this.clearPendingJobBestEffort(jobId);
        }
        return;
      }

      if (this.activeRun === run) {
        controller.abort();
        await this.publisher.clear(request.tabId, {
          type: 'invalidate',
          runId: jobId,
        });
        await this.saveProgressBestEffort({
          isTranslating: false,
          videoId: request.videoId,
          error: extractErrorMessage(error),
          timestamp: this.now(),
        });
        await this.clearPendingJobBestEffort(jobId);
      }
    } finally {
      clearInterval(heartbeat);
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  /**
   * 从 storage 中恢复上一次尚未结束的任务。调用方负责决定任务是否已足够陈旧，
   * 以避免两个尚未退出的 service worker 同时接管同一任务。
   */
  async resumePendingJob(): Promise<boolean> {
    if (this.activeRun || this.resumeInFlight) return false;

    this.resumeInFlight = true;

    try {
      const pendingJob = await this.store.getPendingJob();
      if (!pendingJob) return false;

      await this.start(
        pendingJob.request,
        pendingJob.id,
        undefined,
        pendingJob.generation
      );
      return true;
    } finally {
      this.resumeInFlight = false;
    }
  }

  async cancel(request: BrowserTranslationCancelRequest = {}): Promise<void> {
    try {
      const run = this.activeRun;
      const runVersion = this.runVersion;
      const progress = await this.store.getProgress();
      const pendingJob = await this.store.getPendingJob();
      const hasNewerRun = this.runVersion !== runVersion;
      const runningVideoId = run?.videoId || progress?.videoId || pendingJob?.request.videoId;
      const matchesActiveRun = !request.videoId
        || !runningVideoId
        || request.videoId === runningVideoId;

      if (!hasNewerRun && matchesActiveRun) {
        this.activeRun = null;
        run?.controller.abort();
      }

      // MV3 唤醒后可能只有持久化任务而没有内存 run。若等待 storage 期间新 run
      // 已启动，就没有可安全失效的旧 runId；此时绝不能发送无作用域的全局 reset。
      if (hasNewerRun && !run) {
        if (request.videoId) {
          await this.store.clearVideoResult(request.videoId);
        }
        return;
      }

      const videoIdToClear = request.videoId || runningVideoId;
      if (videoIdToClear) {
        await this.store.clearVideoResult(videoIdToClear);
      }
      await this.publisher.clear(
        request.tabId,
        run ? { type: 'invalidate', runId: run.jobId } : undefined
      );
      if (!hasNewerRun && matchesActiveRun && this.runVersion === runVersion) {
        await this.store.clearProgress();
        await this.clearPendingJobBestEffort(pendingJob?.id);
      }
    } catch (error) {
      throw new Error(`取消 Translation session 失败: ${extractErrorMessage(error)}`);
    }
  }

  async status(request: { videoId?: string } = {}): Promise<BrowserTranslationStatus> {
    try {
      let progress = await this.store.getProgress();
      const pendingJob = await this.store.getPendingJob();
      const isStale = progress?.isTranslating
        && typeof progress.timestamp === 'number'
        && this.now() - progress.timestamp > 10 * 60 * 1000;

      if (isStale && !pendingJob) {
        await this.store.clearProgress();
        progress = null;
      }

      if (!progress && pendingJob) {
        progress = {
          isTranslating: true,
          videoId: pendingJob.request.videoId,
          step: 'resume',
          current: 0,
          total: pendingJob.request.subtitles.length,
          timestamp: pendingJob.updatedAt,
        };
      }

      const belongsToRequestedVideo = !request.videoId
        || progress?.videoId === request.videoId;
      const visibleProgress = belongsToRequestedVideo ? progress : null;

      return {
        isTranslating: Boolean(visibleProgress?.isTranslating),
        progress: visibleProgress,
        cachedResult: request.videoId
          ? await this.store.getVideoResult(request.videoId)
          : null,
      };
    } catch (error) {
      throw new Error(`读取 Translation session 状态失败: ${extractErrorMessage(error)}`);
    }
  }

  private async saveProgressBestEffort(progress: TranslationProgress): Promise<void> {
    try {
      await this.store.saveProgress(progress);
    } catch {}
  }

  private nextRunGeneration(): number {
    const timestamp = Math.floor(this.now());
    return Math.max(timestamp, this.lastRunGeneration + 1);
  }

  private async savePendingJobBestEffort(job: BrowserTranslationJob): Promise<void> {
    try {
      await this.store.savePendingJob(job);
    } catch {}
  }

  private async touchPendingJobBestEffort(
    run: { jobId: string; generation: number },
    request: BrowserTranslationStartRequest
  ): Promise<void> {
    await this.savePendingJobBestEffort({
      id: run.jobId,
      request,
      generation: run.generation,
      updatedAt: this.now(),
    });
  }

  private async clearPendingJobBestEffort(jobId?: string): Promise<void> {
    try {
      await this.store.clearPendingJob(jobId);
    } catch {}
  }
}
