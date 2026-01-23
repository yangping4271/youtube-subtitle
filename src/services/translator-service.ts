/**
 * 翻译服务 - 整合所有模块
 * 提供完整的翻译流程：断句 → 翻译
 */

import { setupLogger } from '../utils/logger.js';
import { createOpenAIClient } from './openai-client.js';
import { mergeSegmentsBatch, countWords, calculateFirstBatchSegmentRange } from '../core/splitter.js';
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
      logger.info(`📏 句子长度限制: ${this.config.maxWordCountEnglish} 字`);
      logger.info(`📦 批次规划: 每组500字`);

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
    logger.info('🚀 启动分段处理模式');

    // 计算首批范围
    const firstBatchSegmentCount = calculateFirstBatchSegmentRange(
      originalData,
      processData,
      firstBatchSize
    );

    // 分割数据
    const segments = processData.getSegments();
    const firstBatchData = new SubtitleData(segments.slice(0, firstBatchSegmentCount));
    const remainingData = new SubtitleData(segments.slice(firstBatchSegmentCount));

    logger.info(`📏 首批范围: 前${firstBatchSize}条原始字幕 → ${firstBatchSegmentCount}个单词`);
    logger.info(`📏 剩余范围: ${remainingData.length()}个单词`);

    // 并行断句
    logger.info('🔄 并行断句处理...');

    // 启动首批和剩余的断句（不等待）
    const firstBatchPromise = mergeSegmentsBatch(firstBatchData, originalData, splitClient, this.config, 3, '首批');
    const remainingPromise = remainingData.length() > 0
      ? mergeSegmentsBatch(remainingData, originalData, splitClient, this.config, 3, '剩余')
      : Promise.resolve(new SubtitleData([]));

    // 创建翻译器
    const translationClient = createOpenAIClient(this.config, 'translation');
    const translator = createTranslator(translationClient, this.config);

    // 等待首批断句完成，立即开始首批翻译
    const firstBatchResult = await firstBatchPromise;
    logger.info(`✅ 首批断句完成: ${firstBatchResult.length()}条`);
    if (onProgress) onProgress('split', 0.5, 2);

    // 翻译首批（同时剩余部分继续断句）
    await this.translateBatch(
      firstBatchResult.getSegments(),
      translator,
      options,
      true,
      onPartialResult,
      onProgress
    );

    // 等待剩余断句完成
    const remainingResult = await remainingPromise;
    if (remainingResult.length() > 0) {
      logger.info(`✅ 剩余断句完成: ${remainingResult.length()}条`);

      // 翻译剩余部分
      await this.translateBatch(
        remainingResult.getSegments(),
        translator,
        options,
        false,
        onPartialResult,
        onProgress
      );
    }

    logger.info(`✅ 全部完成: 共翻译 ${firstBatchResult.length() + remainingResult.length()} 条双语字幕`);
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
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info(`${isFirst ? '🚀' : '🔄'} ${isFirst ? '首批' : '剩余'}翻译开始: ${segments.length}条字幕`);

    // 构建字幕索引
    const optimizedSubtitles: Record<string, string> = {};
    segments.forEach((seg, idx) => {
      optimizedSubtitles[String(idx + 1)] = seg.text;
    });

    // 翻译
    const translated = await translator.translate(
      optimizedSubtitles,
      {
        videoTitle: options.videoTitle,
        videoDescription: options.videoDescription,
        aiSummary: options.aiSummary,
      }
    );

    // 构建结果并回调
    const result = this.buildBilingualResult(segments, translated);
    logger.info(`✅ ${isFirst ? '首批' : '剩余'}翻译完成: ${result.english.length}条`);
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
