/**
 * YouTube Subtitle Translator - 统一配置中心
 * 所有默认值的单一数据源
 */

import type {
  SubtitleStyleSettings,
  SubtitleConfig,
  ModelOption,
  LanguageOption,
  ApiConfig,
  ApiProviderConfig,
  TranslatorConfig,
} from '../types';
import { DEFAULT_CONCURRENCY } from '../utils/concurrency.js';
import { getApiEndpointValidationError } from '../utils/api-url.js';
import {
  API_CONFIG_MIGRATION_NOTICE,
  API_CONFIG_SCHEMA_VERSION,
  DEFAULT_API_PROVIDERS,
  MAX_API_CONCURRENCY,
  MODEL_CONCURRENCY_LIMITS,
  assertApiConfigUsesRemoteEndpoints,
  getModelConcurrencyLimit,
  isDefaultApiProviderId,
  migrateApiConfig,
  normalizeApiConfig,
} from '../utils/api-config.js';
import { popupConfigBridge } from './config-bridge.js';
import type { PopupConfigBridge } from './config-bridge.js';

export { normalizeApiBaseUrl } from '../utils/api-url.js';
export { getApiHostPermissionPattern } from './config-bridge.js';
export {
  assertRemoteApiBaseUrl,
  getApiEndpointValidationError,
  isRemoteApiBaseUrl,
} from '../utils/api-url.js';
export {
  API_CONFIG_MIGRATION_NOTICE,
  API_CONFIG_SCHEMA_VERSION,
  DEFAULT_API_PROVIDERS,
  DEFAULT_API_PROVIDER_IDS,
  MAX_API_CONCURRENCY,
  MODEL_CONCURRENCY_LIMITS,
  assertApiConfigUsesRemoteEndpoints,
  getModelConcurrencyLimit,
  isDefaultApiProviderId,
  migrateApiConfig,
  normalizeApiConfig,
} from '../utils/api-config.js';

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

export function getActiveApiProvider(
  apiConfig: Partial<ApiConfig> | null | undefined
): ApiProviderConfig | undefined {
  const normalized = normalizeApiConfig(apiConfig);
  return normalized.providers!.find(provider => provider.id === normalized.activeProviderId);
}

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

/** 支持的 LLM 模型列表 */
export const SUPPORTED_MODELS: ModelOption[] = [
  { value: 'gpt-4o-mini', text: 'GPT-4o Mini (推荐)' },
  { value: 'gpt-4o', text: 'GPT-4o' },
  { value: 'gpt-4-turbo', text: 'GPT-4 Turbo' },
  { value: 'gpt-3.5-turbo', text: 'GPT-3.5 Turbo' },
  { value: 'claude-3-haiku-20240307', text: 'Claude 3 Haiku' },
  { value: 'claude-3-sonnet-20240229', text: 'Claude 3 Sonnet' },
  { value: 'google/gemini-3-flash-preview', text: 'Gemini 3 Flash (Preview)' },
  { value: 'google/gemini-flash-1.5', text: 'Gemini 1.5 Flash' },
  { value: 'google/gemini-pro-1.5', text: 'Gemini 1.5 Pro' },
  { value: 'custom', text: '自定义模型...' },
];

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

/** 获取默认 API 配置的深拷贝 */
export function getDefaultApiConfig(): ApiConfig {
  return JSON.parse(JSON.stringify(DEFAULT_API_CONFIG));
}

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
 * 获取默认翻译器配置
 */
export function getDefaultTranslatorConfig(): TranslatorConfig {
  return { ...DEFAULT_TRANSLATOR_CONFIG };
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
      getDefaultConfig: typeof getDefaultConfig;
      validateSettings: typeof validateSettings;
      isEmptySettings: typeof isEmptySettings;
      DEFAULT_API_CONFIG: typeof DEFAULT_API_CONFIG;
      DEFAULT_API_PROVIDERS: typeof DEFAULT_API_PROVIDERS;
      isDefaultApiProviderId: typeof isDefaultApiProviderId;
      MAX_API_CONCURRENCY: typeof MAX_API_CONCURRENCY;
      API_CONFIG_MIGRATION_NOTICE: typeof API_CONFIG_MIGRATION_NOTICE;
      API_CONFIG_SCHEMA_VERSION: typeof API_CONFIG_SCHEMA_VERSION;
      MODEL_CONCURRENCY_LIMITS: typeof MODEL_CONCURRENCY_LIMITS;
      normalizeConcurrency: PopupConfigBridge['normalizeConcurrency'];
      getModelConcurrencyLimit: typeof getModelConcurrencyLimit;
      normalizeApiBaseUrl: PopupConfigBridge['normalizeApiBaseUrl'];
      normalizeApiConfig: typeof normalizeApiConfig;
      migrateApiConfig: typeof migrateApiConfig;
      assertApiConfigUsesRemoteEndpoints: typeof assertApiConfigUsesRemoteEndpoints;
      getActiveApiProvider: typeof getActiveApiProvider;
      getApiEndpointValidationError: PopupConfigBridge['getApiEndpointValidationError'];
      getApiHostPermissionPattern: PopupConfigBridge['getApiHostPermissionPattern'];
      formatApiResponseError: PopupConfigBridge['formatApiResponseError'];
      SUPPORTED_MODELS: typeof SUPPORTED_MODELS;
      SUPPORTED_LANGUAGES: typeof SUPPORTED_LANGUAGES;
    };
    // 直接暴露的便捷函数（popup.js 需要）
    getDefaultEnglishSettings: typeof getDefaultEnglishSettings;
    getDefaultChineseSettings: typeof getDefaultChineseSettings;
    getDefaultConfig: typeof getDefaultConfig;
  }
}

if (typeof window !== 'undefined') {
  window.SubtitleConfig = {
    getDefaultEnglishSettings,
    getDefaultChineseSettings,
    getDefaultConfig,
    validateSettings,
    isEmptySettings,
    DEFAULT_API_CONFIG,
    DEFAULT_API_PROVIDERS,
    isDefaultApiProviderId,
    MAX_API_CONCURRENCY,
    API_CONFIG_MIGRATION_NOTICE,
    API_CONFIG_SCHEMA_VERSION,
    MODEL_CONCURRENCY_LIMITS,
    ...popupConfigBridge,
    getModelConcurrencyLimit,
    normalizeApiConfig,
    migrateApiConfig,
    assertApiConfigUsesRemoteEndpoints,
    getActiveApiProvider,
    SUPPORTED_MODELS,
    SUPPORTED_LANGUAGES,
  };

  // 直接暴露便捷函数（popup.js 依赖）
  window.getDefaultEnglishSettings = getDefaultEnglishSettings;
  window.getDefaultChineseSettings = getDefaultChineseSettings;
  window.getDefaultConfig = getDefaultConfig;
}
