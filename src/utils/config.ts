/**
 * 配置管理 - Chrome 扩展
 */

import type { TranslatorConfig, ApiConfig } from '../types/index.js';

// Chrome API 类型声明
declare const chrome: {
  storage?: {
    local: {
      get: (keys: string[], callback: (result: Record<string, unknown>) => void) => void;
    };
  };
};

// 默认配置
const DEFAULT_CONFIG: TranslatorConfig = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  splitModel: 'gpt-4o-mini',
  translationModel: 'gpt-4o',
  targetLanguage: 'zh',
  maxWordCountEnglish: 19,
  threadNum: 18,
  batchSize: 20,
  toleranceMultiplier: 1.2,
  warningMultiplier: 1.5,
  maxMultiplier: 2.0,
};

/**
 * 从 Chrome Storage 加载配置
 */
export async function loadConfig(): Promise<TranslatorConfig> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['apiConfig'], (result: Record<string, unknown>) => {
        const apiConfig: ApiConfig = (result.apiConfig as ApiConfig) || {};
        resolve({
          ...DEFAULT_CONFIG,
          openaiBaseUrl: apiConfig.openaiBaseUrl || DEFAULT_CONFIG.openaiBaseUrl,
          openaiApiKey: apiConfig.openaiApiKey || '',
          splitModel: apiConfig.llmModel || DEFAULT_CONFIG.splitModel,
          translationModel: apiConfig.llmModel || DEFAULT_CONFIG.translationModel,
          targetLanguage: apiConfig.targetLanguage || DEFAULT_CONFIG.targetLanguage,
        });
      });
    } else {
      resolve(DEFAULT_CONFIG);
    }
  });
}

/**
 * 获取默认配置
 */
export function getDefaultConfig(): TranslatorConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * 验证配置
 */
export function validateConfig(config: TranslatorConfig): string[] {
  const errors: string[] = [];

  if (!config.openaiApiKey) {
    errors.push('API 密钥未配置');
  }

  if (!config.openaiBaseUrl) {
    errors.push('API 地址未配置');
  }

  if (config.maxWordCountEnglish < 5 || config.maxWordCountEnglish > 50) {
    errors.push('最大单词数应在 5-50 之间');
  }

  if (config.batchSize < 10 || config.batchSize > 100) {
    errors.push('批次大小应在 10-100 之间（推荐: 20）');
  }

  return errors;
}
