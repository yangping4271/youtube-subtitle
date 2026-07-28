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
} from '../types/index.js';
import { buildTranslatorConfig, loadConfig } from './config.js';

declare const chrome: {
  storage?: {
    local: {
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
};

export interface ExtensionTranslationRequest {
  subtitles: SimpleSubtitleEntry[];
  targetLanguage?: string;
  videoDescription?: string;
  aiSummary?: string | null;
  videoTitle?: string;
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
    partial: BilingualSubtitles
  ) => Promise<void> | void;
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

function toExtensionSubtitles(result: BilingualSubtitles): BilingualSubtitles {
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

export class TranslationSessionAdapter {
  async translate(
    request: ExtensionTranslationRequest,
    observer: ExtensionTranslationObserver = {}
  ): Promise<BilingualSubtitles> {
    const config = request.apiConfig
      ? buildTranslatorConfig(request.apiConfig)
      : await loadConfig();
    config.targetLanguage = request.targetLanguage || 'zh';

    const session = new TranslationSession(config, new OpenAIClient(config));
    const coreObserver: TranslationSessionObserver = {
      onProgress: async (step, current, total) => {
        try {
          await this.saveProgress(step, current, total);
        } catch (error) {
          console.warn(`保存翻译进度失败，继续翻译: ${extractErrorMessage(error)}`);
        }
        await observer.onProgress?.(step, current, total);
      },
      onPartialResult: async (partial) => {
        await observer.onPartialResult?.(toExtensionSubtitles(partial));
      },
    };

    try {
      const result = await session.translate(
        {
          subtitles: toCoreSubtitles(request.subtitles),
          videoTitle: request.videoTitle,
          videoDescription: request.videoDescription,
          aiSummary: request.aiSummary,
          signal: request.signal,
        },
        coreObserver
      );
      return toExtensionSubtitles(result);
    } finally {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        try {
          await chrome.storage.local.remove('translationProgress');
        } catch (error) {
          console.warn(`清理翻译进度失败: ${extractErrorMessage(error)}`);
        }
      }
    }
  }

  private async saveProgress(
    step: string,
    current: number,
    total: number
  ): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      return;
    }

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
}

export const translationSession = new TranslationSessionAdapter();
