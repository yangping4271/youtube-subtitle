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
  ApiProviderType,
  TranslatorConfig,
} from '../types';
import { DEFAULT_CONCURRENCY, normalizeConcurrency } from '../utils/concurrency.js';
import { popupConfigBridge } from './config-bridge.js';
import type { PopupConfigBridge } from './config-bridge.js';

export { normalizeApiBaseUrl } from '../utils/api-url.js';
export { getApiHostPermissionPattern } from './config-bridge.js';

/** DeepSeek V4 Flash 文档给出的账号级最大并发请求数。 */
export const MAX_API_CONCURRENCY = 2500;

/** 已知模型的账号级并发上限；未知模型不强加本地上限，由用户自行配置。 */
export const MODEL_CONCURRENCY_LIMITS: Record<string, number> = {
  'deepseek-v4-flash': MAX_API_CONCURRENCY,
  'deepseek-v4-pro': 500,
};

// Chrome API 类型声明
declare const chrome: {
  storage?: {
    local: {
      get: (keys: string[], callback: (result: Record<string, unknown>) => void) => void;
    };
  };
};

export const DEFAULT_API_PROVIDERS: ApiProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    providerType: 'openai',
    openaiBaseUrl: 'https://api.openai.com',
    openaiApiKey: '',
    llmModel: 'gpt-4o-mini',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerType: 'openrouter',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiApiKey: '',
    llmModel: 'openai/gpt-4o-mini',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    providerType: 'deepseek',
    openaiBaseUrl: 'https://api.deepseek.com',
    openaiApiKey: '',
    llmModel: 'deepseek-v4-flash',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
];

/** 这三个供应商是内置配置，始终保留在供应商列表中。 */
export const DEFAULT_API_PROVIDER_IDS = DEFAULT_API_PROVIDERS.map(provider => provider.id);

export function isDefaultApiProviderId(providerId = ''): boolean {
  return DEFAULT_API_PROVIDER_IDS.includes(providerId);
}

/** 默认 API 配置 */
export const DEFAULT_API_CONFIG: ApiConfig = {
  activeProviderId: DEFAULT_API_PROVIDERS[0].id,
  providers: DEFAULT_API_PROVIDERS,
  openaiBaseUrl: 'https://api.openai.com',
  openaiApiKey: '',
  llmModel: 'gpt-4o-mini',
  targetLanguage: 'zh',
  threadNum: DEFAULT_CONCURRENCY,
  disableThinking: true,
};

/** 默认翻译器配置 */
const DEFAULT_TRANSLATOR_CONFIG: TranslatorConfig = {
  openaiBaseUrl: 'https://api.openai.com',
  openaiApiKey: '',
  model: 'gpt-4o',
  providerType: 'openai',
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

function getUrlParts(baseUrl = ''): { hostname: string; pathParts: Set<string> } {
  try {
    const parsed = new URL(baseUrl);
    return {
      hostname: parsed.hostname.toLowerCase(),
      pathParts: new Set(
        parsed.pathname
          .split('/')
          .map(part => part.trim().toLowerCase())
          .filter(Boolean)
      ),
    };
  } catch {
    return {
      hostname: '',
      pathParts: new Set(
        baseUrl
          .toLowerCase()
          .split(/[/?#]+/)
          .map(part => part.trim())
          .filter(Boolean)
      ),
    };
  }
}

function inferProviderType(baseUrl = ''): ApiProviderType {
  const normalizedBaseUrl = baseUrl.toLowerCase();
  const { hostname, pathParts } = getUrlParts(baseUrl);
  if (hostname.endsWith('openrouter.ai') || pathParts.has('openrouter') || normalizedBaseUrl.includes('openrouter.ai')) return 'openrouter';
  if (hostname.endsWith('deepseek.com') || normalizedBaseUrl.includes('deepseek.com')) return 'deepseek';
  if (hostname === 'api.openai.com' || normalizedBaseUrl.includes('api.openai.com')) return 'openai';
  return 'custom';
}

export function getModelConcurrencyLimit(model = ''): number | undefined {
  return MODEL_CONCURRENCY_LIMITS[model.trim().toLowerCase()];
}

function normalizeThreadNum(value: unknown, model = ''): number {
  const modelLimit = getModelConcurrencyLimit(model);
  return normalizeConcurrency(value, modelLimit);
}

function normalizeProvider(provider: ApiProviderConfig): ApiProviderConfig {
  return {
    id: provider.id,
    name: provider.name || '未命名供应商',
    providerType: provider.providerType || inferProviderType(provider.openaiBaseUrl),
    openaiBaseUrl: typeof provider.openaiBaseUrl === 'string' ? provider.openaiBaseUrl : '',
    openaiApiKey: provider.openaiApiKey || '',
    llmModel: provider.llmModel || '',
    threadNum: normalizeThreadNum(provider.threadNum, provider.llmModel),
    disableThinking: true,
  };
}

function cloneDefaultProviders(): ApiProviderConfig[] {
  return DEFAULT_API_PROVIDERS.map(provider => ({ ...provider }));
}

function mergeDefaultProviders(configuredProviders: ApiProviderConfig[]): ApiProviderConfig[] {
  const configuredById = new Map(configuredProviders.map(provider => [provider.id, provider]));
  const defaultProviders = DEFAULT_API_PROVIDERS.map(defaultProvider => ({
    ...defaultProvider,
    ...(configuredById.get(defaultProvider.id) || {}),
    id: defaultProvider.id,
  }));
  const customProviders = configuredProviders.filter(
    provider => !isDefaultApiProviderId(provider.id)
  );

  return [...defaultProviders, ...customProviders];
}

function ensureUniqueProviders(providers: ApiProviderConfig[]): ApiProviderConfig[] {
  const result: ApiProviderConfig[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const key = `id:${provider.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(provider);
  }

  return result;
}

export function normalizeApiConfig(apiConfig: Partial<ApiConfig> | null | undefined): ApiConfig {
  const configuredProviders: ApiProviderConfig[] = Array.isArray(apiConfig?.providers)
    ? apiConfig.providers
      .filter((provider): provider is ApiProviderConfig => Boolean(provider?.id))
      .map(normalizeProvider)
    : [];

  const providers = mergeDefaultProviders(
    ensureUniqueProviders(
      configuredProviders.length > 0 ? configuredProviders : cloneDefaultProviders()
    )
  );

  const activeProviderId = apiConfig?.activeProviderId && providers.some(p => p.id === apiConfig.activeProviderId)
    ? apiConfig.activeProviderId
    : providers[0].id;
  const activeProvider = providers.find(provider => provider.id === activeProviderId) || providers[0];

  return {
    activeProviderId,
    providers,
    openaiBaseUrl: activeProvider.openaiBaseUrl,
    openaiApiKey: activeProvider.openaiApiKey,
    llmModel: activeProvider.llmModel,
    providerType: activeProvider.providerType,
    targetLanguage: apiConfig?.targetLanguage || DEFAULT_TRANSLATOR_CONFIG.targetLanguage,
    threadNum: normalizeThreadNum(activeProvider.threadNum, activeProvider.llmModel),
    disableThinking: true,
  };
}

export function getActiveApiProvider(
  apiConfig: Partial<ApiConfig> | null | undefined
): ApiProviderConfig {
  const normalized = normalizeApiConfig(apiConfig);
  return normalized.providers!.find(provider => provider.id === normalized.activeProviderId)
    || normalized.providers![0];
}

export function buildTranslatorConfig(
  apiConfig: Partial<ApiConfig> | null | undefined
): TranslatorConfig {
  const normalized = normalizeApiConfig(apiConfig);

  return {
    ...DEFAULT_TRANSLATOR_CONFIG,
    openaiBaseUrl: normalized.openaiBaseUrl,
    openaiApiKey: normalized.openaiApiKey || '',
    model: normalized.llmModel,
    providerType: normalized.providerType || inferProviderType(normalized.openaiBaseUrl),
    targetLanguage: normalized.targetLanguage || DEFAULT_TRANSLATOR_CONFIG.targetLanguage,
    threadNum: normalizeThreadNum(normalized.threadNum, normalized.llmModel),
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
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['apiConfig'], (result: Record<string, unknown>) => {
        const apiConfig: ApiConfig = (result.apiConfig as ApiConfig) || {};
        resolve(buildTranslatorConfig(apiConfig));
      });
    } else {
      resolve(DEFAULT_TRANSLATOR_CONFIG);
    }
  });
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
      MODEL_CONCURRENCY_LIMITS: typeof MODEL_CONCURRENCY_LIMITS;
      normalizeConcurrency: PopupConfigBridge['normalizeConcurrency'];
      getModelConcurrencyLimit: typeof getModelConcurrencyLimit;
      normalizeApiBaseUrl: PopupConfigBridge['normalizeApiBaseUrl'];
      normalizeApiConfig: typeof normalizeApiConfig;
      getActiveApiProvider: typeof getActiveApiProvider;
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
    MODEL_CONCURRENCY_LIMITS,
    ...popupConfigBridge,
    getModelConcurrencyLimit,
    normalizeApiConfig,
    getActiveApiProvider,
    SUPPORTED_MODELS,
    SUPPORTED_LANGUAGES,
  };

  // 直接暴露便捷函数（popup.js 依赖）
  window.getDefaultEnglishSettings = getDefaultEnglishSettings;
  window.getDefaultChineseSettings = getDefaultChineseSettings;
  window.getDefaultConfig = getDefaultConfig;
}
