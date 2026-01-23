/**
 * 翻译服务 - 整合所有模块
 * 提供完整的翻译流程：断句 → 翻译
 */

import { setupLogger } from '../utils/logger.js';
import { createOpenAIClient } from './openai-client.js';
import { mergeSegmentsBatch, countWords } from '../core/splitter.js';
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
      logger.info('\n✂️ 字幕断句处理 开始');

      // 打印原始数据信息
      const originalSegments = subtitleData.getSegments();

      // 检查字幕类型并统一转换为单词级别
      let processData = subtitleData;
      if (subtitleData.isWordTimestamp()) {
        logger.info('检测到单词级别时间戳，执行合并断句');
      } else {
        logger.info('检测到片段级别时间戳，先转换为单词级别');
        processData = subtitleData.splitToWordSegments();
        logger.info(`转换完成，生成 ${processData.length()} 个单词级别片段`);
      }

      // 执行断句处理
      logger.info(`🤖 使用模型: ${this.config.splitModel}`);
      logger.info(`📏 句子长度限制: ${this.config.maxWordCountEnglish} 字`);

      const splitClient = createOpenAIClient(this.config, 'split');
      const splitResult = await mergeSegmentsBatch(processData, subtitleData, splitClient, this.config, 3);

      logger.info(`✅ 断句完成 (优化为 ${splitResult.length()} 句)\n`);

      if (onProgress) onProgress('split', 1, 2);

      // 构建优化后的字幕索引
      const optimizedSubtitles: Record<string, string> = {};
      const splitSegments = splitResult.getSegments();

      splitSegments.forEach((seg, idx) => {
        optimizedSubtitles[String(idx + 1)] = seg.text;
      });

      // 步骤2：分批翻译
      logger.info('🌐 步骤2: 翻译字幕...');
      if (onProgress) onProgress('translate', 1, 2);

      const translationClient = createOpenAIClient(this.config, 'translation');
      const translator = createTranslator(translationClient, this.config);

      // 如果有 onPartialResult 回调，则进行分批处理
      if (onPartialResult) {
        await this.translateInBatches(
          splitSegments,
          optimizedSubtitles,
          translator,
          options,
          firstBatchSize,
          onPartialResult,
          onProgress
        );
      } else {
        // 原有的一次性翻译逻辑
        const translatedEntries = await translator.translate(
          optimizedSubtitles,
          {
            videoTitle: options.videoTitle,
            videoDescription: options.videoDescription,
            aiSummary: options.aiSummary,
          },
          (current, total) => {
            if (onProgress) {
              const progress = 1 + (current / total);
              onProgress('translate', progress, 2);
            }
          }
        );

        if (onProgress) onProgress('complete', 2, 2);

        // 构建双语字幕结果
        const result = this.buildBilingualResult(splitSegments, translatedEntries);
        logger.info(`✅ 翻译完成: ${result.english.length} 条双语字幕`);
        return result;
      }

      if (onProgress) onProgress('complete', 2, 2);

      // 返回空结果（实际结果已通过回调返回）
      return { english: [], chinese: [] };

    } finally {
      this.isTranslating = false;
    }
  }

  /**
   * 分批翻译并逐步回调
   */
  private async translateInBatches(
    splitSegments: SubtitleEntry[],
    optimizedSubtitles: Record<string, string>,
    translator: ReturnType<typeof createTranslator>,
    options: TranslateOptions,
    firstBatchSize: number,
    onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => void,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const totalCount = splitSegments.length;

    // 首批处理
    const firstBatchEnd = Math.min(firstBatchSize, totalCount);
    logger.info(`🚀 首批翻译: 前 ${firstBatchEnd} 条字幕`);

    const firstBatchSubtitles: Record<string, string> = {};
    for (let i = 0; i < firstBatchEnd; i++) {
      firstBatchSubtitles[String(i + 1)] = optimizedSubtitles[String(i + 1)];
    }

    const firstBatchTranslated = await translator.translate(
      firstBatchSubtitles,
      {
        videoTitle: options.videoTitle,
        videoDescription: options.videoDescription,
        aiSummary: options.aiSummary,
      }
    );

    const firstBatchResult = this.buildBilingualResult(
      splitSegments.slice(0, firstBatchEnd),
      firstBatchTranslated
    );

    logger.info(`✅ 首批翻译完成: ${firstBatchResult.english.length} 条`);
    onPartialResult(firstBatchResult, true);

    if (onProgress) {
      onProgress('translate', 1 + (firstBatchEnd / totalCount), 2);
    }

    // 后续批次处理
    if (firstBatchEnd < totalCount) {
      const batchSize = 20; // 后续批次大小
      for (let i = firstBatchEnd; i < totalCount; i += batchSize) {
        const batchEnd = Math.min(i + batchSize, totalCount);
        logger.info(`🔄 翻译批次: ${i + 1}-${batchEnd} 条`);

        const batchSubtitles: Record<string, string> = {};
        for (let j = i; j < batchEnd; j++) {
          batchSubtitles[String(j + 1)] = optimizedSubtitles[String(j + 1)];
        }

        const batchTranslated = await translator.translate(
          batchSubtitles,
          {
            videoTitle: options.videoTitle,
            videoDescription: options.videoDescription,
            aiSummary: options.aiSummary,
          }
        );

        const batchResult = this.buildBilingualResult(
          splitSegments.slice(i, batchEnd),
          batchTranslated
        );

        logger.info(`✅ 批次翻译完成: ${batchResult.english.length} 条`);
        onPartialResult(batchResult, false);

        if (onProgress) {
          onProgress('translate', 1 + (batchEnd / totalCount), 2);
        }
      }
    }

    logger.info(`✅ 全部翻译完成: ${totalCount} 条双语字幕`);
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
