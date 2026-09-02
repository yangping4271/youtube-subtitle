/**
 * YouTube Subtitle Translator - 统一配置中心
 * 所有默认值的单一数据源
 */

import type {
  SubtitleStyleSettings,
  SubtitleConfig,
  LanguageOption,
  ApiConfig,
  TranslatorConfig,
} from '../types';
import { DEFAULT_CONCURRENCY } from '../utils/concurrency.js';
import { getApiEndpointValidationError } from '../utils/api-url.js';
import {
  API_CONFIG_MIGRATION_NOTICE,
  API_CONFIG_SCHEMA_VERSION,
  DEFAULT_API_PROVIDERS,
  assertApiConfigUsesRemoteEndpoints,
  getModelConcurrencyLimit,
  isDefaultApiProviderId,
  migrateApiConfig,
  normalizeApiConfig,
} from '../utils/api-config.js';
import { popupConfigBridge } from './config-bridge.js';
import type { PopupConfigBridge } from './config-bridge.js';

// Chrome API 类型声明
declare const chrome: {
  storage?: {
    local: {
      get: (keys: string[], callback: (result: Record<string, unknown>) => void) => void;
      set?: (items: Record<string, unknown>) => Promise<void> | void;
    };
  };
};

/** 默认 API 配置 */
export const DEFAULT_API_CONFIG: ApiConfig = {
  schemaVersion: API_CONFIG_SCHEMA_VERSION,
  requiresProviderSelection: true,
  providers: DEFAULT_API_PROVIDERS,
  openaiBaseUrl: '',
  openaiApiKey: '',
  llmModel: '',
  targetLanguage: 'zh',
  threadNum: DEFAULT_CONCURRENCY,
  disableThinking: true,
};

/** 默认翻译器配置 */
const DEFAULT_TRANSLATOR_CONFIG: TranslatorConfig = {
  openaiBaseUrl: '',
  openaiApiKey: '',
  model: '',
  providerType: 'custom',
  targetLanguage: 'zh',
  maxWordCountEnglish: 19,
  threadNum: DEFAULT_CONCURRENCY,
  // 速度优先：缩小单次翻译请求，交给全局并发控制并行执行。
  batchSize: 10,
  disableThinking: true,
  toleranceMultiplier: 1.2,
  warningMultiplier: 1.5,
  maxMultiplier: 2.0,
};

export function buildTranslatorConfig(
  apiConfig: Partial<ApiConfig> | null | undefined
): TranslatorConfig {
  assertApiConfigUsesRemoteEndpoints(apiConfig);
  const normalized = normalizeApiConfig(apiConfig);

  return {
    ...DEFAULT_TRANSLATOR_CONFIG,
    openaiBaseUrl: normalized.openaiBaseUrl,
    openaiApiKey: normalized.openaiApiKey || '',
    model: normalized.llmModel,
    providerType: normalized.providerType || 'custom',
    targetLanguage: normalized.targetLanguage || DEFAULT_TRANSLATOR_CONFIG.targetLanguage,
    threadNum: normalized.threadNum || DEFAULT_CONCURRENCY,
    disableThinking: true,
  };
}

/** 支持的目标语言列表 */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { value: 'zh', text: '简体中文' },
  { value: 'zh-tw', text: '繁体中文' },
  { value: 'ja', text: '日文' },
  { value: 'ko', text: '韩文' },
  { value: 'en', text: 'English' },
  { value: 'fr', text: '法文' },
  { value: 'de', text: '德文' },
  { value: 'es', text: '西班牙文' },
];

/** 默认字幕配置 */
export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  english: {
    fontSize: 30,
    fontColor: '#FFFF00',
    fontFamily: '"Noto Serif", Georgia, serif',
    fontWeight: '700',
    textStroke: '2px #000000',
    textShadow: 'none',
    lineHeight: 1.3,
  },
  chinese: {
    fontSize: 28,
    fontColor: '#00FF00',
    fontFamily: '"Songti SC", serif',
    fontWeight: '900',
    textStroke: '2px #000000',
    textShadow: 'none',
    lineHeight: 1.4,
  },
  dpr: {
    enabled: true,
    compensationFactor: 0.4,
  },
  ui: {
    fontSizeMin: 16,
    fontSizeMax: 48,
  },
};

/** 获取英文字幕默认配置的深拷贝 */
export function getDefaultEnglishSettings(): SubtitleStyleSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_CONFIG.english));
}

/** 获取中文字幕默认配置的深拷贝 */
export function getDefaultChineseSettings(): SubtitleStyleSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_CONFIG.chinese));
}

/** 获取完整的默认配置（只读） */
export function getDefaultConfig(): SubtitleConfig {
  return DEFAULT_SUBTITLE_CONFIG;
}

/** 验证和补全设置对象 */
export function validateSettings(
  settings: Partial<SubtitleStyleSettings> | null | undefined,
  type: 'english' | 'chinese'
): SubtitleStyleSettings {
  const defaults =
    type === 'english' ? getDefaultEnglishSettings() : getDefaultChineseSettings();

  const validated: SubtitleStyleSettings = { ...defaults };

  if (settings) {
    for (const key of Object.keys(defaults) as Array<keyof SubtitleStyleSettings>) {
      if (settings[key] !== undefined) {
        // 使用类型安全的赋值
        validated[key] = settings[key] as never;
      }
    }
  }

  return validated;
}

/** 检查设置对象是否为空 */
export function isEmptySettings(obj: unknown): boolean {
  return !obj || (typeof obj === 'object' && Object.keys(obj).length === 0);
}

/**
 * 从 Chrome Storage 加载翻译器配置
 */
export async function loadConfig(): Promise<TranslatorConfig> {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return DEFAULT_TRANSLATOR_CONFIG;
  }

  const storage = chrome.storage.local;
  const result = await new Promise<Record<string, unknown>>(resolve => {
    storage.get(['apiConfig'], resolve);
  });
  const migration = migrateApiConfig((result.apiConfig as ApiConfig) || {});
  if (migration.changed && storage.set) {
    try {
      await storage.set({ apiConfig: migration.config });
    } catch {
      // 配置迁移写回失败时仍使用本轮内存中的安全配置。
    }
  }

  if (migration.requiresProviderSelection) {
    throw new Error(API_CONFIG_MIGRATION_NOTICE);
  }

  return buildTranslatorConfig(migration.config);
}

/**
 * 验证翻译器配置
 */
export function validateConfig(config: TranslatorConfig): string[] {
  const errors: string[] = [];

  if (!config.openaiBaseUrl) {
    errors.push('API 地址未配置');
  } else {
    const endpointError = getApiEndpointValidationError(config.openaiBaseUrl);
    if (endpointError) errors.push(endpointError);
  }

  if (config.maxWordCountEnglish < 5 || config.maxWordCountEnglish > 50) {
    errors.push('最大单词数应在 5-50 之间');
  }

  if (config.batchSize < 10 || config.batchSize > 100) {
    errors.push('批次大小应在 10-100 之间（推荐: 10）');
  }

  const modelLimit = getModelConcurrencyLimit(config.model);
  if (!Number.isInteger(config.threadNum) || config.threadNum < 1) {
    errors.push(`模型 ${config.model} 的并发数必须是大于等于 1 的整数`);
  } else if (modelLimit !== undefined && config.threadNum > modelLimit) {
    errors.push(`模型 ${config.model} 的并发数应在 1-${modelLimit} 之间`);
  }

  return errors;
}

// 浏览器环境：挂载到全局
declare global {
  interface Window {
    SubtitleConfig: {
      getDefaultEnglishSettings: typeof getDefaultEnglishSettings;
      getDefaultChineseSettings: typeof getDefaultChineseSettings;
      isEmptySettings: typeof isEmptySettings;
      DEFAULT_API_CONFIG: typeof DEFAULT_API_CONFIG;
      isDefaultApiProviderId: typeof isDefaultApiProviderId;
      normalizeConcurrency: PopupConfigBridge['normalizeConcurrency'];
      getModelConcurrencyLimit: typeof getModelConcurrencyLimit;
      normalizeApiBaseUrl: PopupConfigBridge['normalizeApiBaseUrl'];
      normalizeApiConfig: typeof normalizeApiConfig;
      migrateApiConfig: typeof migrateApiConfig;
      getApiHostPermissionPattern: PopupConfigBridge['getApiHostPermissionPattern'];
      formatApiResponseError: PopupConfigBridge['formatApiResponseError'];
      SUPPORTED_LANGUAGES: typeof SUPPORTED_LANGUAGES;
    };
  }
}

if (typeof window !== 'undefined') {
  window.SubtitleConfig = {
    getDefaultEnglishSettings,
    getDefaultChineseSettings,
    isEmptySettings,
    DEFAULT_API_CONFIG,
    isDefaultApiProviderId,
    ...popupConfigBridge,
    getModelConcurrencyLimit,
    normalizeApiConfig,
    migrateApiConfig,
    SUPPORTED_LANGUAGES,
  };
}
