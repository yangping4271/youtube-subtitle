/**
 * 翻译服务 - 整合所有模块
 * 提供完整的翻译流程：断句 → 翻译
 */

import { setupLogger } from '../utils/logger.js';
import { createOpenAIClient, OpenAIClient } from './openai-client.js';
import { presplitByPunctuation, batchBySentenceCount, mergeSegmentsWithinBatch, countWords } from '../core/splitter.js';
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
    const { inputFile, videoTitle, onProgress, onPartialResult, firstBatchSize = 10 } = options;

    try {
      // 创建字幕数据对象
      const subtitleData = new SubtitleData(subtitles);
      logger.info(`📊 字幕统计: 共 ${subtitleData.length()} 条字幕`);
      logger.info(`字幕内容预览: ${subtitleData.toText().slice(0, 100)}...`);

      // 检查字幕是否为空
      if (subtitleData.length() === 0) {
        throw new Error('SRT文件为空，无法进行翻译');
      }

      // 断句处理阶段
      logger.info('✂️ 字幕断句处理 开始');

      // 转换为单词
      const processData = subtitleData.splitToWordSegments();
      logger.info(`📝 转换为单词: ${processData.length()} 个单词`);

      // 执行断句处理
      logger.info(`🤖 使用模型: ${this.config.splitModel}`);

      const splitClient = createOpenAIClient(this.config, 'split');

      // 使用流水线模式
      await this.translateWithPipeline(
        processData,
        subtitleData,
        splitClient,
        options,
        firstBatchSize,
        onPartialResult ?? (() => {}),  // 使用空合并运算符
        onProgress
      );

      if (onProgress) onProgress('complete', 2, 2);

      // 返回空结果（实际结果已通过回调返回）
      return { english: [], chinese: [] };

    } finally {
      this.isTranslating = false;
    }
  }

  /**
   * 流水线模式：分段处理首批和剩余部分
   */
  private async translateWithPipeline(
    processData: SubtitleData,
    originalData: SubtitleData,
    splitClient: OpenAIClient,
    options: TranslateOptions,
    firstBatchSize: number,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info('🚀 启动按句子数分批的流水线处理');

    // 1. 转单词级别
    const wordSegments = processData.getSegments();
    logger.info(`📝 单词级字幕: ${wordSegments.length} 个单词`);

    // 2. 预分句
    const preSplitSentences = presplitByPunctuation(wordSegments);

    // 3. 按句子数分批（首批5句，后续5-10句）
    const batches = batchBySentenceCount(preSplitSentences, 5, 5, 10);
    logger.info(`📦 预分句 ${preSplitSentences.length} 个句子，分为 ${batches.length} 批`);

    if (batches.length === 0) {
      logger.warn('⚠️ 没有可处理的批次');
      return;
    }

    // 创建翻译器
    const translationClient = createOpenAIClient(this.config, 'translation');
    const translator = createTranslator(translationClient, this.config);

    // 4. 处理首批
    const firstBatch = batches[0];
    logger.info(`🔄 开始首批断句 (${firstBatch.length} 个预分句)...`);
    const firstBatchResult = await mergeSegmentsWithinBatch(
      firstBatch,
      wordSegments,
      splitClient,
      this.config
      // 首批不传 batchIndex，日志中不显示批次编号
    );
    logger.info(`✅ 首批断句完成: ${firstBatchResult.length()} 条`);
    if (onProgress) onProgress('split', 0.5, 2);

    // 翻译首批
    await this.translateBatch(
      firstBatchResult.getSegments(),
      translator,
      options,
      true,
      onPartialResult,
      onProgress
    );

    // 5. 处理剩余批次
    const remainingBatches = batches.slice(1);
    if (remainingBatches.length > 0) {
      logger.info(`🔄 开始剩余 ${remainingBatches.length} 批次的流式处理...\n`);

      const pendingTranslations: Promise<void>[] = [];

      for (let i = 0; i < remainingBatches.length; i++) {
        const batch = remainingBatches[i];
        const batchIndex = i + 1;

        logger.info(`🎯 [批次${batchIndex}] 开始处理 ${batch.length} 个预分句`);

        // 立即启动断句和翻译（不等待）
        const promise = mergeSegmentsWithinBatch(
          batch,
          wordSegments,
          splitClient,
          this.config,
          batchIndex
        ).then(batchResult => {
          logger.info(`🎯 [批次${batchIndex}] 断句完成: ${batchResult.length()} 条`);
          return this.translateBatch(
            batchResult.getSegments(),
            translator,
            options,
            false,
            onPartialResult,
            onProgress,
            batchIndex
          );
        });

        pendingTranslations.push(promise);
      }

      // 等待所有翻译完成
      logger.info(`\n⏳ 等待 ${pendingTranslations.length} 个批次完成...`);
      await Promise.all(pendingTranslations);
      logger.info(`✅ 所有剩余批次完成\n`);
    }

    logger.info(`✅ 全部完成: 流水线处理结束`);
  }

  /**
   * 翻译单个批次
   */
  private async translateBatch(
    segments: SubtitleEntry[],
    translator: ReturnType<typeof createTranslator>,
    options: TranslateOptions,
    isFirst: boolean,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback,
    batchNumber?: number  // 新增：批次编号
  ): Promise<void> {
    let batchLabel: string;
    if (isFirst) {
      batchLabel = '首批';
    } else if (batchNumber) {
      batchLabel = `批次${batchNumber}`;
    } else {
      batchLabel = '剩余';
    }

    logger.info(`${isFirst ? '🚀' : '🔄'} [${batchLabel}] 翻译开始: ${segments.length}条字幕`);

    // 构建字幕索引
    const optimizedSubtitles: Record<string, string> = {};
    segments.forEach((seg, idx) => {
      optimizedSubtitles[String(idx + 1)] = seg.text;
    });

    // 翻译（传递批次标签）
    const translated = await translator.translate(
      optimizedSubtitles,
      {
        videoTitle: options.videoTitle,
        videoDescription: options.videoDescription,
        aiSummary: options.aiSummary,
      },
      batchLabel  // 传递批次标签用于日志
    );

    // 构建结果并回调
    const result = this.buildBilingualResult(segments, translated);
    logger.info(`✅ [${batchLabel}] 翻译完成: ${result.english.length}条`);
    onPartialResult(result, isFirst);

    if (onProgress) {
      const progress = isFirst ? 1.5 : 2;
      onProgress('translate', progress, 2);
    }
  }

  /**
   * 构建双语字幕结果
   * 使用断句后的时间戳信息
   */
  private buildBilingualResult(
    splitSegments: SubtitleEntry[],
    translatedEntries: TranslatedEntry[]
  ): BilingualSubtitles {
    const english: SubtitleEntry[] = [];
    const chinese: SubtitleEntry[] = [];

    for (let i = 0; i < translatedEntries.length && i < splitSegments.length; i++) {
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
