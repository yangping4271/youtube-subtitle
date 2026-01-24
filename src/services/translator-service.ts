/**
 * 翻译服务 - 整合所有模块
 * 提供完整的翻译流程：断句 → 翻译
 */

import { setupLogger } from '../utils/logger.js';
import { createOpenAIClient, OpenAIClient } from './openai-client.js';
import { presplitByPunctuation, batchBySentenceCount, mergeSegmentsWithinBatch } from '../core/splitter.js';
import { SubtitleData } from '../core/subtitle-data.js';
import { createTranslator } from '../core/translator.js';
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
    if (this.isTranslating) {
      throw new Error('翻译正在进行中');
    }

    this.isTranslating = true;
    const { onProgress, onPartialResult, firstBatchSize = 10 } = options;

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
      logger.info(`使用模型: ${this.config.splitModel}`);

      const splitClient = createOpenAIClient(this.config, 'split');

      await this.translateWithPipeline(
        processData,
        splitClient,
        options,
        firstBatchSize,
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
   * 流水线模式：所有批次并行处理（带并发控制）
   */
  private async translateWithPipeline(
    processData: SubtitleData,
    splitClient: OpenAIClient,
    options: TranslateOptions,
    firstBatchSize: number,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info('启动按句子数分批的流水线处理（所有批次并行）');

    const wordSegments = processData.getSegments();
    logger.info(`单词级字幕: ${wordSegments.length} 个单词`);

    const preSplitSentences = presplitByPunctuation(wordSegments);
    logger.info(`预分句: ${preSplitSentences.length} 个句子`);

    const batches = batchBySentenceCount(preSplitSentences, 5, 5, 10);
    logger.info(`预分句 ${preSplitSentences.length} 个句子，分为 ${batches.length} 批`);

    if (batches.length === 0) {
      logger.warn('没有可处理的批次');
      return;
    }

    const translationClient = createOpenAIClient(this.config, 'translation');
    const translator = createTranslator(translationClient, this.config);

    const { threadNum } = this.config;
    logger.info(`并发控制: 最多同时处理 ${threadNum} 个批次`);
    logger.info(`开始处理 ${batches.length} 个批次...\n`);

    let completedSentences = 0;
    const totalSentences = preSplitSentences.length;

    const batchTasks = batches.map((batch, index) => async () => {
      const batchNumber = index + 1;
      logger.info(`[批次${batchNumber}] 开始处理 ${batch.length} 个预分句`);

      const batchResult = await mergeSegmentsWithinBatch(
        batch,
        wordSegments,
        splitClient,
        this.config,
        batchNumber
      );

      logger.info(`[批次${batchNumber}] 断句完成: ${batchResult.length()} 条`);

      await this.translateBatch(
        batchResult.getSegments(),
        translator,
        options,
        batchNumber,
        onPartialResult,
        onProgress,
        () => {
          completedSentences += batchResult.length();
          if (onProgress) {
            onProgress('translate', completedSentences, totalSentences);
          }
        }
      );

      logger.info(`[批次${batchNumber}] 完成`);
    });

    await this.executeBatchesWithConcurrency(batchTasks, threadNum);

    logger.info(`\n全部完成: 流水线处理结束`);
    if (onProgress) onProgress('complete', totalSentences, totalSentences);
  }

  /**
   * 并发控制执行批次任务
   */
  private async executeBatchesWithConcurrency(
    tasks: Array<() => Promise<void>>,
    concurrency: number
  ): Promise<void> {
    for (let i = 0; i < tasks.length; i += concurrency) {
      const chunk = tasks.slice(i, i + concurrency);
      await Promise.all(chunk.map(task => task()));
    }
  }

  /**
   * 翻译单个批次
   */
  private async translateBatch(
    segments: SubtitleEntry[],
    translator: ReturnType<typeof createTranslator>,
    options: TranslateOptions,
    batchNumber: number,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback,
    onBatchComplete?: () => void
  ): Promise<void> {
    const batchLabel = `批次${batchNumber}`;

    logger.info(`[${batchLabel}] 翻译开始: ${segments.length}条字幕`);

    const optimizedSubtitles: Record<string, string> = {};
    for (let i = 0; i < segments.length; i++) {
      optimizedSubtitles[String(i + 1)] = segments[i].text;
    }

    const translated = await translator.translate(
      optimizedSubtitles,
      {
        videoTitle: options.videoTitle,
        videoDescription: options.videoDescription,
        aiSummary: options.aiSummary,
      },
      batchLabel
    );

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
    const length = Math.min(translatedEntries.length, splitSegments.length);
    const english: SubtitleEntry[] = [];
    const chinese: SubtitleEntry[] = [];

    for (let i = 0; i < length; i++) {
      const entry = translatedEntries[i];
      const segment = splitSegments[i];

      english.push({
        index: i + 1,
        startTime: segment.startTime,
        endTime: segment.endTime,
        text: entry.optimized,
      });

      chinese.push({
        index: i + 1,
        startTime: segment.startTime,
        endTime: segment.endTime,
        text: entry.translation,
      });
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

/**
 * 创建翻译服务实例
 */
export function createTranslatorService(config: TranslatorConfig): TranslatorService {
  return new TranslatorService(config);
}
