/**
 * 翻译会话 - 整合完整的断句、翻译和结果聚合流程
 */

import { extractErrorMessage } from '../utils/error-handler.js';
import { normalizeConcurrency } from '../utils/concurrency.js';
import { setupLogger } from '../utils/logger.js';
import {
  createCancellationError,
  createLinkedCancellationScope,
  type CancellationSignal,
} from '../utils/cancellation.js';
import { presplitByPunctuation, batchBySentenceCount, mergeSegmentsWithinBatch } from './splitter.js';
import { SubtitleData } from './subtitle-data.js';
import { Translator } from './translator.js';
import type {
  ChatOptions,
  TranslatorConfig,
  SubtitleEntry,
  TranslatedEntry,
  BilingualSubtitles,
  TranslationContext,
} from '../types/index.js';

const logger = setupLogger('translation-session');

// 首批优先保证尽快出现字幕，后续批次优先保证吞吐量。
const FIRST_BATCH_MAX_WORDS = 80;
const LATER_BATCH_MAX_WORDS = 300;

function formatElapsedTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

interface PendingChatRequest {
  cancelled: boolean;
  resolve: () => void;
  cleanup: () => void;
}

/**
 * 把并发配置收敛为所有 Chat 请求共享的全局上限。
 * 外层断句、批量翻译和单条兜底翻译都必须经过这里，避免并发层叠加。
 */
class ChatRequestGate {
  private active = 0;
  private peak = 0;
  private readonly waiters: PendingChatRequest[] = [];
  private readonly registrations = new Map<number, number>();
  private nextRegistrationId = 0;

  register(limit: number): () => void {
    const registrationId = this.nextRegistrationId++;
    this.registrations.set(registrationId, normalizeConcurrency(limit));
    this.drainWaiters();

    return () => {
      this.registrations.delete(registrationId);
      this.drainWaiters();
    };
  }

  private getLimit(): number {
    if (this.registrations.size === 0) return 1;
    return Math.min(...this.registrations.values());
  }

  private acquire(signal?: CancellationSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createCancellationError('翻译已取消'));
    }

    if (this.active < this.getLimit()) {
      this.occupySlot();
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingChatRequest = {
        cancelled: false,
        resolve,
        cleanup: () => {},
      };

      const onAbort = (): void => {
        if (pending.cancelled) return;
        pending.cancelled = true;
        pending.cleanup();
        reject(createCancellationError('翻译已取消'));
      };

      pending.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort);
      this.waiters.push(pending);
    });
  }

  private drainWaiters(): void {
    while (this.active < this.getLimit() && this.waiters.length > 0) {
      const pending = this.waiters.shift();
      if (!pending || pending.cancelled) continue;

      pending.cleanup();
      pending.resolve();
      this.occupySlot();
    }
  }

  private release(): void {
    this.active--;
    this.drainWaiters();
  }

  private occupySlot(): void {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
  }

  getPeak(): number {
    return this.peak;
  }

  async run<T>(task: () => Promise<T>, signal?: CancellationSignal): Promise<T> {
    await this.acquire(signal);

    try {
      if (signal?.aborted) {
        throw createCancellationError('翻译已取消');
      }
      return await task();
    } finally {
      this.release();
    }
  }
}

// 所有 provider、host 和 model 共用一个 gate。
// 切换视频或配置时，旧 session 尚未退出的请求仍计入同一总并发预算。
const sharedChatRequestGate = new ChatRequestGate();

function registerSharedChatRequestGate(
  limit: number
): { gate: ChatRequestGate; release: () => void } {
  return {
    gate: sharedChatRequestGate,
    release: sharedChatRequestGate.register(limit),
  };
}

export interface ChatCompletionPort {
  callChat(
    systemPrompt: string,
    userPrompt: string,
    options?: ChatOptions
  ): Promise<string>;
}

export interface TranslationSessionRequest {
  subtitles: SubtitleEntry[];
  context?: TranslationContext;
  signal?: CancellationSignal;
}

export interface TranslationSessionObserver {
  onProgress?: (
    step: 'split' | 'translate' | 'complete',
    current: number,
    total: number
  ) => Promise<void> | void;
  onPartialResult?: (
    // 可能是首批中的一个翻译子批，不保证一次回调对应完整大批次。
    partial: BilingualSubtitles,
    signal?: CancellationSignal
  ) => Promise<void> | void;
}

interface TranslationBatchResult {
  sentenceCount: number;
  subtitles: BilingualSubtitles;
  /** 首批已经按翻译子批流式发送过，最终聚合时不要再次通知观察器。 */
  streamed: boolean;
}

/**
 * 完整翻译 session：断句、翻译、进度观察与最终结果聚合
 */
export class TranslationSession {
  constructor(
    private readonly config: TranslatorConfig,
    private readonly chatCompletion: ChatCompletionPort
  ) {}

  /**
   * 执行完整翻译流程
   */
  async translate(
    request: TranslationSessionRequest,
    observer: TranslationSessionObserver = {}
  ): Promise<BilingualSubtitles> {
    const startedAt = Date.now();

    try {
      const subtitleData = new SubtitleData(request.subtitles);
      logger.info(`字幕统计: 共 ${subtitleData.length()} 条字幕`);
      logger.info(`字幕内容预览: ${subtitleData.toText().slice(0, 100)}...`);

      if (subtitleData.length() === 0) {
        throw new Error('SRT文件为空，无法进行翻译');
      }

      logger.info('字幕断句处理开始');

      // YouTube SRV3 已经提供词级时间戳。再次拆词会把段落留屏时间分给
      // 标点，导致标点越过后续单词并破坏句子边界。
      const hasWordTimestamps = subtitleData.isWordTimestamp();
      const wordSegmentData = hasWordTimestamps
        ? subtitleData
        : subtitleData.splitToWordSegments();
      logger.info(
        hasWordTimestamps
          ? `保留源词级时间戳: ${wordSegmentData.length()} 个片段`
          : `转换为单词: ${wordSegmentData.length()} 个单词`
      );
      logger.info(`使用模型: ${this.config.model}`);

      return await this.translateWithPipeline(wordSegmentData, request, observer);
    } finally {
      logger.info(`翻译会话总耗时: ${formatElapsedTime(Date.now() - startedAt)}`);
    }
  }

  /**
   * 检查取消信号，如果已取消则抛出 AbortError
   */
  private checkAborted(signal?: CancellationSignal): void {
    if (signal?.aborted) {
      throw createCancellationError('翻译已取消');
    }
  }

  /**
   * 流水线模式：所有批次并行处理（带并发控制）
   */
  private async translateWithPipeline(
    wordSegmentData: SubtitleData,
    request: TranslationSessionRequest,
    observer: TranslationSessionObserver
  ): Promise<BilingualSubtitles> {
    logger.info('启动按句子数分批的流水线处理（所有批次并行）');

    const { signal } = request;
    this.checkAborted(signal);

    const wordSegments = wordSegmentData.getSegments();
    logger.info(`单词级字幕: ${wordSegments.length} 个单词`);

    const preSplitSentences = presplitByPunctuation(wordSegments);
    logger.info(`预分句: ${preSplitSentences.length} 个句子`);

    // 首批只承担“尽快点亮字幕”的职责，控制请求体大小；后续批次保持较大的吞吐量。
    // 这里的上限按单词数计算，不会切开一个已经预分好的句子。
    const batches = batchBySentenceCount(
      preSplitSentences,
      FIRST_BATCH_MAX_WORDS,
      LATER_BATCH_MAX_WORDS
    );
    logger.info(`预分句 ${preSplitSentences.length} 个句子，分为 ${batches.length} 批`);

    if (batches.length === 0) {
      logger.warn('没有可处理的批次');
      return { english: [], chinese: [] };
    }

    this.checkAborted(signal);

    const { threadNum } = this.config;
    const normalizedConcurrency = normalizeConcurrency(threadNum);
    const { gate: requestGate, release: releaseGate } = registerSharedChatRequestGate(normalizedConcurrency);
    const gatedChatCompletion: ChatCompletionPort = {
      callChat: (systemPrompt, userPrompt, options = {}) => requestGate.run(
        () => this.chatCompletion.callChat(systemPrompt, userPrompt, options),
        options.signal
      ),
    };

    logger.info(`全局 Chat 请求并发上限: ${normalizedConcurrency}`);
    logger.info(`开始处理 ${batches.length} 个批次...\n`);

    const translator = new Translator(gatedChatCompletion, this.config);

    const total = preSplitSentences.length;

    const batchTasks = batches.map((batch, index) => async (
      pipelineSignal: CancellationSignal
    ): Promise<TranslationBatchResult> => {
      this.checkAborted(pipelineSignal);

      const batchNumber = index + 1;
      logger.info(`[批次${batchNumber}] 开始处理 ${batch.length} 个预分句`);

      const batchResult = await mergeSegmentsWithinBatch(
        batch,
        wordSegments,
        gatedChatCompletion,
        this.config,
        batchNumber,
        pipelineSignal
      );

      logger.info(`[批次${batchNumber}] 断句完成: ${batchResult.length()} 条`);
      this.checkAborted(pipelineSignal);

      const subtitles = await this.translateBatch(
        batchResult.getSegments(),
        translator,
        { ...request, signal: pipelineSignal },
        batchNumber,
        batchNumber === 1 && Boolean(observer.onPartialResult)
          ? async (partial, partialSignal) => {
            const effectiveSignal = partialSignal || pipelineSignal;
            if (effectiveSignal.aborted) return;
            await this.notifyObserver(
              '首批部分翻译结果',
              () => observer.onPartialResult?.(partial, effectiveSignal)
            );
          }
          : undefined
      );

      logger.info(`[批次${batchNumber}] 完成`);
      return {
        sentenceCount: batch.length,
        subtitles,
        streamed: batchNumber === 1 && Boolean(observer.onPartialResult),
      };
    });

    const english: SubtitleEntry[] = [];
    const chinese: SubtitleEntry[] = [];
    let completed = 0;

    try {
      await this.executeBatchesWithConcurrency(
        batchTasks,
        normalizedConcurrency,
        async (batchResult, pipelineSignal) => {
          const partial = this.reindexResult(
            batchResult.subtitles,
            english.length
          );
          english.push(...partial.english);
          chinese.push(...partial.chinese);
          completed += batchResult.sentenceCount;

          await this.notifyObserver(
            '翻译进度',
            () => observer.onProgress?.('translate', completed, total)
          );
          // 首批已经在每个翻译子批完成后流式发送；这里仍然把完整结果加入
          // 聚合数组，但跳过重复的观察器通知。
          if (!batchResult.streamed) {
            this.checkAborted(pipelineSignal);
            await this.notifyObserver(
              '部分翻译结果',
              () => observer.onPartialResult?.(partial, pipelineSignal)
            );
          }
        },
        signal
      );

      logger.info(`实际 Chat 请求并发峰值: ${requestGate.getPeak()}`);

      logger.info(`\n全部完成: 流水线处理结束`);
      await this.notifyObserver(
        '完成进度',
        () => observer.onProgress?.('complete', total, total)
      );
      return { english, chinese };
    } finally {
      releaseGate();
    }
  }

  /**
   * 观察器只接收会话状态，不参与决定翻译是否成功。
   */
  private async notifyObserver(
    label: string,
    notify: () => Promise<void> | void | undefined
  ): Promise<void> {
    try {
      await notify();
    } catch (error) {
      logger.warn(`${label}观察器执行失败，继续返回翻译结果: ${extractErrorMessage(error)}`);
    }
  }

  /**
   * 并发控制执行批次任务
   */
  private async executeBatchesWithConcurrency<T>(
    tasks: Array<(signal: CancellationSignal) => Promise<T>>,
    concurrency: number,
    onOrderedResult: (result: T, signal: CancellationSignal) => Promise<void>,
    signal?: CancellationSignal
  ): Promise<T[]> {
    const normalizedConcurrency = normalizeConcurrency(concurrency);
    const workerCount = Math.min(tasks.length, normalizedConcurrency);
    const slots: Array<{ ready: boolean; value?: T }> = tasks.map(() => ({
      ready: false,
    }));
    const results: T[] = [];
    let nextTaskIndex = 0;
    let nextResultIndex = 0;
    let failed = false;
    let failure: unknown;
    let emission = Promise.resolve();
    const pipelineScope = createLinkedCancellationScope(signal);
    const pipelineSignal = pipelineScope.signal;

    const queueOrderedEmission = (): void => {
      if (failed || pipelineSignal.aborted) return;
      emission = emission.then(async () => {
        if (failed || pipelineSignal.aborted) return;
        while (slots[nextResultIndex]?.ready) {
          if (failed || pipelineSignal.aborted) return;
          const result = slots[nextResultIndex].value as T;
          results.push(result);
          nextResultIndex++;
          await onOrderedResult(result, pipelineSignal);
        }
      });
    };

    const worker = async (): Promise<void> => {
      while (!failed) {
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= tasks.length) {
          return;
        }

        try {
          this.checkAborted(pipelineSignal);
          const result = await tasks[taskIndex](pipelineSignal);
          slots[taskIndex] = { ready: true, value: result };
          queueOrderedEmission();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
            pipelineScope.abort();
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: workerCount }, () => worker())
      );
      await emission;

      if (failed) {
        throw failure;
      }

      return results;
    } finally {
      pipelineScope.dispose();
      pipelineScope.abort();
    }
  }

  /**
   * 翻译单个批次
   */
  private async translateBatch(
    segments: SubtitleEntry[],
    translator: Translator,
    request: TranslationSessionRequest,
    batchNumber: number,
    onPartialResult?: (
      partial: BilingualSubtitles,
      signal?: CancellationSignal
    ) => Promise<void> | void
  ): Promise<BilingualSubtitles> {
    const batchLabel = `批次${batchNumber}`;
    const translationBatchSize = Math.max(1, Math.floor(this.config.batchSize));

    logger.info(
      `[${batchLabel}] 翻译开始: ${segments.length}条字幕，翻译子批大小 ${translationBatchSize}`
    );

    const chunks: Array<{
      start: number;
      chunk: SubtitleEntry[];
      chunkLabel: string;
    }> = [];
    const chunkTotal = Math.ceil(segments.length / translationBatchSize);

    for (let start = 0; start < segments.length; start += translationBatchSize) {
      const end = Math.min(start + translationBatchSize, segments.length);
      const chunkIndex = Math.floor(start / translationBatchSize) + 1;
      const chunkLabel = chunkTotal > 1
        ? `${batchLabel}-${chunkIndex}/${chunkTotal}`
        : batchLabel;

      chunks.push({
        start,
        chunk: segments.slice(start, end),
        chunkLabel,
      });
    }

    // 同一外层批次内的小翻译请求并行执行；ChatRequestGate 负责全局限流。
    // partial 按完成顺序发送，确保任何先完成的子批都能尽快显示。
    // 一个子批失败时，立即取消 sibling，并禁止它们继续发布 partial。
    const siblingScope = createLinkedCancellationScope(request.signal);
    const siblingSignal = siblingScope.signal;

    let siblingFailed = false;
    try {
      const translatedChunks = await Promise.all(chunks.map(async ({ start, chunk, chunkLabel }) => {
        try {
          this.checkAborted(siblingSignal);

          const subtitleMap: Record<string, string> = {};
          for (let i = 0; i < chunk.length; i++) {
            subtitleMap[String(i + 1)] = chunk[i].text;
          }

          const translatedChunk = await translator.translate(
            subtitleMap,
            request.context,
            chunkLabel,
            siblingSignal,
            this.config.threadNum // 传递 threadNum 用于单条并发翻译
          );

          if (onPartialResult && !siblingFailed && !siblingSignal.aborted) {
            await onPartialResult(this.buildBilingualResult(chunk, translatedChunk), siblingSignal);
          }

          return { start, translatedChunk };
        } catch (error) {
          if (!siblingFailed) {
            siblingFailed = true;
            siblingScope.abort();
          }
          throw error;
        }
      }));

      const translated: TranslatedEntry[] = [];
      for (const { start, translatedChunk } of translatedChunks) {
        translated.push(...translatedChunk.map(entry => ({
          ...entry,
          index: start + entry.index,
        })));
      }

      const result = this.buildBilingualResult(segments, translated);
      logger.info(`[${batchLabel}] 翻译完成: ${result.english.length}条`);
      return result;
    } finally {
      siblingScope.dispose();
      siblingScope.abort();
    }
  }

  private reindexResult(
    result: BilingualSubtitles,
    indexOffset: number
  ): BilingualSubtitles {
    const pairs = result.english.map((english, index) => ({
      english,
      chinese: result.chinese[index],
    })).sort((a, b) => a.english.startTime - b.english.startTime);

    return {
      english: pairs.map(({ english }, index) => ({
        ...english,
        index: indexOffset + index + 1,
      })),
      chinese: pairs.map(({ chinese }, index) => ({
        ...chinese,
        index: indexOffset + index + 1,
      })),
    };
  }

  /**
   * 构建双语字幕结果
   */
  private buildBilingualResult(
    splitSegments: SubtitleEntry[],
    translatedEntries: TranslatedEntry[]
  ): BilingualSubtitles {
    const english: SubtitleEntry[] = [];
    const chinese: SubtitleEntry[] = [];
    let emptyTranslationCount = 0;

    // 以 splitSegments 为准全量遍历，避免 translatedEntries 不完整时截断字幕
    for (let i = 0; i < splitSegments.length; i++) {
      const segment = splitSegments[i];
      const entry = translatedEntries[i];

      english.push({
        index: i + 1,
        startTime: segment.startTime,
        endTime: segment.endTime,
        text: entry?.original || segment.text,
      });

      const translationText = entry?.translation?.trim() || '';
      if (!translationText) {
        emptyTranslationCount++;
      }

      chinese.push({
        index: i + 1,
        startTime: segment.startTime,
        endTime: segment.endTime,
        text: translationText,
      });
    }

    if (emptyTranslationCount > 0) {
      logger.info(`空翻译字幕数: ${emptyTranslationCount}`);
    }

    return { english, chinese };
  }
}
