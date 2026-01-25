/**
 * Chrome Extension 适配层
 * 保持与现有 translator.js 相同的全局接口
 */

import { TranslatorService, createTranslatorService } from '../services/translator-service.js';
import { loadConfig } from './config.js';
import { getLanguageName, LANGUAGE_MAPPING } from '../utils/language.js';
import type { TranslatorConfig, SubtitleEntry, BilingualSubtitles } from '../types/index.js';

// Chrome API 类型声明
declare const chrome: {
  storage?: {
    local: {
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => void;
    };
  };
};

/** 秒转毫秒 */
function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** 毫秒转秒 */
function msToSeconds(ms: number): number {
  return ms / 1000;
}

/**
 * 翻译服务包装器 - 保持与现有接口兼容
 */
class TranslatorServiceWrapper {
  private service: TranslatorService | null = null;
  private config: TranslatorConfig | null = null;
  public isTranslating = false;

  /**
   * 加载 API 配置
   */
  async loadConfig(): Promise<TranslatorConfig> {
    this.config = await loadConfig();
    this.service = createTranslatorService(this.config);
    return this.config;
  }

  /**
   * 获取目标语言名称
   */
  getTargetLanguageName(langCode: string): string {
    return getLanguageName(langCode);
  }

  /**
   * 执行完整翻译流程
   * @param subtitles 原始字幕数组（时间戳单位：秒）
   * @param targetLang 目标语言代码
   * @param onProgress 进度回调
   * @param videoDescription 视频说明
   * @param aiSummary AI 生成的摘要
   * @param videoTitle 视频标题
   * @param onPartialResult 部分结果回调
   * @param signal AbortSignal 用于取消翻译
   */
  async translateFull(
    subtitles: Array<{ startTime: number; endTime: number; text: string }>,
    targetLang = 'zh',
    onProgress: ((step: string, current: number, total: number) => void) | null = null,
    videoDescription?: string,
    aiSummary?: string | null,
    videoTitle?: string,
    onPartialResult?: (partial: BilingualSubtitles, isFirst: boolean) => void,
    signal?: AbortSignal
  ): Promise<BilingualSubtitles> {
    // 强制重置状态（开始新翻译前）
    this.isTranslating = true;

    // 保存翻译状态到 storage
    const saveProgress = async (step: string, current: number, total: number): Promise<void> => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        await chrome.storage.local.set({
          translationProgress: {
            isTranslating: true,
            step,
            current,
            total,
            timestamp: Date.now(),
          },
        });
      }
      if (onProgress) onProgress(step, current, total);
    };

    try {
      // 加载配置
      if (!this.config) {
        await this.loadConfig();
      }

      // 更新目标语言
      this.config!.targetLanguage = targetLang;
      this.service = createTranslatorService(this.config!);

      // 转换字幕格式，同时将秒转换为毫秒
      const entries: SubtitleEntry[] = subtitles.map((sub, idx) => ({
        index: idx + 1,
        startTime: secondsToMs(sub.startTime),
        endTime: secondsToMs(sub.endTime),
        text: sub.text,
      }));

      // 执行翻译
      const result = await this.service!.translateFull(entries, {
        videoTitle,
        videoDescription,
        aiSummary,
        signal,
        onProgress: async (step, current, total) => {
          await saveProgress(step, current, total);
        },
        onPartialResult: onPartialResult ? (partial, isFirst) => {
          // 将部分结果的时间戳从毫秒转换回秒
          const convertedPartial: BilingualSubtitles = {
            english: partial.english.map(entry => ({
              ...entry,
              startTime: msToSeconds(entry.startTime),
              endTime: msToSeconds(entry.endTime),
            })),
            chinese: partial.chinese.map(entry => ({
              ...entry,
              startTime: msToSeconds(entry.startTime),
              endTime: msToSeconds(entry.endTime),
            })),
          };
          onPartialResult(convertedPartial, isFirst);
        } : undefined,
      });

      await saveProgress('complete', 2, 2);

      // 将翻译结果的时间戳从毫秒转换回秒（用于与视频 currentTime 比较）
      const convertedResult: BilingualSubtitles = {
        english: result.english.map(entry => ({
          ...entry,
          startTime: msToSeconds(entry.startTime),
          endTime: msToSeconds(entry.endTime),
        })),
        chinese: result.chinese.map(entry => ({
          ...entry,
          startTime: msToSeconds(entry.startTime),
          endTime: msToSeconds(entry.endTime),
        })),
      };

      return convertedResult;

    } finally {
      this.isTranslating = false;
      // 清除翻译进度状态
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.remove('translationProgress');
      }
    }
  }

  /**
   * 取消翻译
   */
  cancelTranslation(): void {
    this.isTranslating = false;
    if (this.service) {
      this.service.cancel();
    }
  }
}

// 创建全局实例
const translatorService = new TranslatorServiceWrapper();

// 导出到全局（支持浏览器和 Service Worker）
interface GlobalExports {
  TranslatorService: typeof TranslatorServiceWrapper;
  translatorService: TranslatorServiceWrapper;
  LANGUAGE_MAPPING: typeof LANGUAGE_MAPPING;
}

const globalExports = globalThis as unknown as GlobalExports;
globalExports.TranslatorService = TranslatorServiceWrapper;
globalExports.translatorService = translatorService;
globalExports.LANGUAGE_MAPPING = LANGUAGE_MAPPING;

// 导出模块
export { TranslatorServiceWrapper as TranslatorService, translatorService, LANGUAGE_MAPPING };
