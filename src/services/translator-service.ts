/**
 * 翻译服务 - 整合所有模块
 * 提供完整的翻译流程：断句 → 翻译
 */

import { setupLogger } from '../utils/logger.js';
import { OpenAIClient } from './openai-client.js';
import { presplitByPunctuation, batchBySentenceCount, mergeSegmentsWithinBatch } from '../core/splitter.js';
import { SubtitleData } from '../core/subtitle-data.js';
import { Translator } from '../core/translator.js';
import type {
  TranslatorConfig,
  SubtitleEntry,
  TranslatedEntry,
  BilingualSubtitles,
  ProgressCallback,
  TranslateOptions,
} from '../types/index.js';

const logger = setupLogger('translator-service');

/**
 * 翻译服务类
 */
export class TranslatorService {
  private config: TranslatorConfig;
  private isTranslating = false;

  constructor(config: TranslatorConfig) {
    this.config = config;
  }

  /**
   * 执行完整翻译流程
   */
  async translateFull(
    subtitles: SubtitleEntry[],
    options: TranslateOptions = {}
  ): Promise<BilingualSubtitles> {
    // 强制重置状态（开始新翻译前）
    this.isTranslating = true;
    const { onProgress, onPartialResult } = options;

    try {
      const subtitleData = new SubtitleData(subtitles);
      logger.info(`字幕统计: 共 ${subtitleData.length()} 条字幕`);
      logger.info(`字幕内容预览: ${subtitleData.toText().slice(0, 100)}...`);

      if (subtitleData.length() === 0) {
        throw new Error('SRT文件为空，无法进行翻译');
      }

      logger.info('字幕断句处理开始');

      const processData = subtitleData.splitToWordSegments();
      logger.info(`转换为单词: ${processData.length()} 个单词`);
      logger.info(`使用模型: ${this.config.model}`);

      const client = new OpenAIClient(this.config);

      await this.translateWithPipeline(
        processData,
        client,
        options,
        onPartialResult ?? (() => {}),
        onProgress
      );

      if (onProgress) onProgress('complete', 2, 2);

      return { english: [], chinese: [] };

    } finally {
      this.isTranslating = false;
    }
  }

  /**
   * 检查取消信号，如果已取消则抛出 AbortError
   */
  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException('翻译已取消', 'AbortError');
    }
  }

  /**
   * 流水线模式：所有批次并行处理（带并发控制）
   */
  private async translateWithPipeline(
    processData: SubtitleData,
    client: OpenAIClient,
    options: TranslateOptions,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info('启动按句子数分批的流水线处理（所有批次并行）');

    const { signal } = options;
    this.checkAborted(signal);

    const wordSegments = processData.getSegments();
    logger.info(`单词级字幕: ${wordSegments.length} 个单词`);

    const preSplitSentences = presplitByPunctuation(wordSegments);
    logger.info(`预分句: ${preSplitSentences.length} 个句子`);

    const batches = batchBySentenceCount(preSplitSentences, 150, 500);
    logger.info(`预分句 ${preSplitSentences.length} 个句子，分为 ${batches.length} 批`);

    if (batches.length === 0) {
      logger.warn('没有可处理的批次');
      return;
    }

    this.checkAborted(signal);

    const translator = new Translator(client, this.config);

    const { threadNum } = this.config;
    logger.info(`并发控制: 最多同时处理 ${threadNum} 个批次`);
    logger.info(`开始处理 ${batches.length} 个批次...\n`);

    let completed = 0;
    const total = preSplitSentences.length;

    const batchTasks = batches.map((batch, index) => async () => {
      this.checkAborted(signal);

      const batchNumber = index + 1;
      logger.info(`[批次${batchNumber}] 开始处理 ${batch.length} 个预分句`);

      const batchResult = await mergeSegmentsWithinBatch(
        batch,
        wordSegments,
        client,
        this.config,
        batchNumber,
        signal
      );

      logger.info(`[批次${batchNumber}] 断句完成: ${batchResult.length()} 条`);
      this.checkAborted(signal);

      await this.translateBatch(
        batchResult.getSegments(),
        translator,
        options,
        batchNumber,
        onPartialResult,
        () => {
          completed += batch.length;
          if (onProgress) {
            onProgress('translate', completed, total);
          }
        }
      );

      logger.info(`[批次${batchNumber}] 完成`);
    });

    await this.executeBatchesWithConcurrency(batchTasks, threadNum, signal);

    logger.info(`\n全部完成: 流水线处理结束`);
    if (onProgress) onProgress('complete', total, total);
  }

  /**
   * 并发控制执行批次任务
   */
  private async executeBatchesWithConcurrency(
    tasks: Array<() => Promise<void>>,
    concurrency: number,
    signal?: AbortSignal
  ): Promise<void> {
    for (let i = 0; i < tasks.length; i += concurrency) {
      this.checkAborted(signal);
      const chunk = tasks.slice(i, i + concurrency);
      await Promise.all(chunk.map(task => task()));
    }
  }

  /**
   * 翻译单个批次
   */
  private async translateBatch(
    segments: SubtitleEntry[],
    translator: Translator,
    options: TranslateOptions,
    batchNumber: number,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onBatchComplete?: () => void
  ): Promise<void> {
    const batchLabel = `批次${batchNumber}`;
    const translationBatchSize = this.config.batchSize;

    logger.info(
      `[${batchLabel}] 翻译开始: ${segments.length}条字幕，翻译子批大小 ${translationBatchSize}`
    );

    const translated: TranslatedEntry[] = [];
    for (let start = 0; start < segments.length; start += translationBatchSize) {
      this.checkAborted(options.signal);

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
          videoTitle: options.videoTitle,
          videoDescription: options.videoDescription,
          aiSummary: options.aiSummary,
        },
        chunkLabel,
        options.signal, // 传递 signal
        this.config.threadNum // 传递 threadNum 用于单条并发翻译
      );

      translated.push(...translatedChunk.map(entry => ({
        ...entry,
        index: start + entry.index,
      })));
    }

    const result = this.buildBilingualResult(segments, translated);
    logger.info(`[${batchLabel}] 翻译完成: ${result.english.length}条`);
    onPartialResult(result, batchNumber === 1);

    if (onBatchComplete) {
      onBatchComplete();
    }
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

  /**
   * 取消翻译
   */
  cancel(): void {
    this.isTranslating = false;
  }

  /**
   * 检查是否正在翻译
   */
  get translating(): boolean {
    return this.isTranslating;
  }
}
