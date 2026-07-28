/**
 * 翻译会话 - 整合完整的断句、翻译和结果聚合流程
 */

import { extractErrorMessage } from '../utils/error-handler.js';
import { setupLogger } from '../utils/logger.js';
import {
  createCancellationError,
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
} from '../types/index.js';

const logger = setupLogger('translation-session');

export interface ChatCompletionPort {
  callChat(
    systemPrompt: string,
    userPrompt: string,
    options?: ChatOptions
  ): Promise<string>;
}

export interface TranslationSessionRequest {
  subtitles: SubtitleEntry[];
  videoTitle?: string;
  videoDescription?: string;
  aiSummary?: string | null;
  signal?: CancellationSignal;
}

export interface TranslationSessionObserver {
  onProgress?: (
    step: 'split' | 'translate' | 'complete',
    current: number,
    total: number
  ) => Promise<void> | void;
  onPartialResult?: (
    partial: BilingualSubtitles
  ) => Promise<void> | void;
}

interface TranslationBatchResult {
  sentenceCount: number;
  subtitles: BilingualSubtitles;
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
    const subtitleData = new SubtitleData(request.subtitles);
    logger.info(`字幕统计: 共 ${subtitleData.length()} 条字幕`);
    logger.info(`字幕内容预览: ${subtitleData.toText().slice(0, 100)}...`);

    if (subtitleData.length() === 0) {
      throw new Error('SRT文件为空，无法进行翻译');
    }

    logger.info('字幕断句处理开始');

    const wordSegmentData = subtitleData.splitToWordSegments();
    logger.info(`转换为单词: ${wordSegmentData.length()} 个单词`);
    logger.info(`使用模型: ${this.config.model}`);

    return this.translateWithPipeline(wordSegmentData, request, observer);
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

    const batches = batchBySentenceCount(preSplitSentences, 150, 500);
    logger.info(`预分句 ${preSplitSentences.length} 个句子，分为 ${batches.length} 批`);

    if (batches.length === 0) {
      logger.warn('没有可处理的批次');
      return { english: [], chinese: [] };
    }

    this.checkAborted(signal);

    const translator = new Translator(this.chatCompletion, this.config);

    const { threadNum } = this.config;
    logger.info(`并发控制: 最多同时处理 ${threadNum} 个批次`);
    logger.info(`开始处理 ${batches.length} 个批次...\n`);

    const total = preSplitSentences.length;

    const batchTasks = batches.map((batch, index) => async (): Promise<TranslationBatchResult> => {
      this.checkAborted(signal);

      const batchNumber = index + 1;
      logger.info(`[批次${batchNumber}] 开始处理 ${batch.length} 个预分句`);

      const batchResult = await mergeSegmentsWithinBatch(
        batch,
        wordSegments,
        this.chatCompletion,
        this.config,
        batchNumber,
        signal
      );

      logger.info(`[批次${batchNumber}] 断句完成: ${batchResult.length()} 条`);
      this.checkAborted(signal);

      const subtitles = await this.translateBatch(
        batchResult.getSegments(),
        translator,
        request,
        batchNumber
      );

      logger.info(`[批次${batchNumber}] 完成`);
      return {
        sentenceCount: batch.length,
        subtitles,
      };
    });

    const english: SubtitleEntry[] = [];
    const chinese: SubtitleEntry[] = [];
    let completed = 0;

    await this.executeBatchesWithConcurrency(
      batchTasks,
      threadNum,
      async (batchResult) => {
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
        await this.notifyObserver(
          '部分翻译结果',
          () => observer.onPartialResult?.(partial)
        );
      },
      signal
    );

    logger.info(`\n全部完成: 流水线处理结束`);
    await this.notifyObserver(
      '完成进度',
      () => observer.onProgress?.('complete', total, total)
    );
    return { english, chinese };
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
    tasks: Array<() => Promise<T>>,
    concurrency: number,
    onOrderedResult: (result: T) => Promise<void>,
    signal?: CancellationSignal
  ): Promise<T[]> {
    const normalizedConcurrency = Number.isFinite(concurrency) && concurrency > 0
      ? Math.floor(concurrency)
      : 1;
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

    const queueOrderedEmission = (): void => {
      emission = emission.then(async () => {
        while (slots[nextResultIndex]?.ready) {
          const result = slots[nextResultIndex].value as T;
          results.push(result);
          nextResultIndex++;
          await onOrderedResult(result);
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
          this.checkAborted(signal);
          const result = await tasks[taskIndex]();
          slots[taskIndex] = { ready: true, value: result };
          queueOrderedEmission();
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );
    await emission;

    if (failed) {
      throw failure;
    }

    return results;
  }

  /**
   * 翻译单个批次
   */
  private async translateBatch(
    segments: SubtitleEntry[],
    translator: Translator,
    request: TranslationSessionRequest,
    batchNumber: number
  ): Promise<BilingualSubtitles> {
    const batchLabel = `批次${batchNumber}`;
    const translationBatchSize = this.config.batchSize;

    logger.info(
      `[${batchLabel}] 翻译开始: ${segments.length}条字幕，翻译子批大小 ${translationBatchSize}`
    );

    const translated: TranslatedEntry[] = [];
    for (let start = 0; start < segments.length; start += translationBatchSize) {
      this.checkAborted(request.signal);

      const end = Math.min(start + translationBatchSize, segments.length);
      const chunk = segments.slice(start, end);
      const chunkIndex = Math.floor(start / translationBatchSize) + 1;
      const chunkTotal = Math.ceil(segments.length / translationBatchSize);
      const chunkLabel = chunkTotal > 1
        ? `${batchLabel}-${chunkIndex}/${chunkTotal}`
        : batchLabel;

      const subtitleMap: Record<string, string> = {};
      for (let i = 0; i < chunk.length; i++) {
        subtitleMap[String(i + 1)] = chunk[i].text;
      }

      const translatedChunk = await translator.translate(
        subtitleMap,
        {
          videoTitle: request.videoTitle,
          videoDescription: request.videoDescription,
          aiSummary: request.aiSummary,
        },
        chunkLabel,
        request.signal,
        this.config.threadNum // 传递 threadNum 用于单条并发翻译
      );

      translated.push(...translatedChunk.map(entry => ({
        ...entry,
        index: start + entry.index,
      })));
    }

    const result = this.buildBilingualResult(segments, translated);
    logger.info(`[${batchLabel}] 翻译完成: ${result.english.length}条`);
    return result;
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
