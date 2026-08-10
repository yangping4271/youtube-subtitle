import type {
  ApiConfig,
  ApiProviderConfig,
  ApiProviderType,
} from '../types/index.js';
import { DEFAULT_CONCURRENCY, normalizeConcurrency } from './concurrency.js';
import {
  getApiEndpointValidationError,
  isRemoteApiBaseUrl,
} from './api-url.js';

export const API_CONFIG_SCHEMA_VERSION = 4;
export const API_CONFIG_MIGRATION_NOTICE = '已移除不支持的本地 API 配置，请选择远程 HTTPS API。';
export const MAX_API_CONCURRENCY = 2500;

export const MODEL_CONCURRENCY_LIMITS: Record<string, number> = {
  'deepseek-v4-flash': MAX_API_CONCURRENCY,
  'deepseek-v4-pro': 500,
};

export const DEFAULT_API_PROVIDERS: ApiProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    providerType: 'openai',
    openaiBaseUrl: 'https://api.openai.com',
    openaiApiKey: '',
    llmModel: '',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerType: 'openrouter',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiApiKey: '',
    llmModel: '',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    providerType: 'deepseek',
    openaiBaseUrl: 'https://api.deepseek.com',
    openaiApiKey: '',
    llmModel: '',
    threadNum: DEFAULT_CONCURRENCY,
    disableThinking: true,
  },
];

export const DEFAULT_API_PROVIDER_IDS = DEFAULT_API_PROVIDERS.map(provider => provider.id);

export function isDefaultApiProviderId(providerId = ''): boolean {
  return DEFAULT_API_PROVIDER_IDS.includes(providerId);
}

export function getModelConcurrencyLimit(model = ''): number | undefined {
  return MODEL_CONCURRENCY_LIMITS[model.trim().toLowerCase()];
}

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

function normalizeThreadNum(value: unknown, model = ''): number {
  return normalizeConcurrency(value, getModelConcurrencyLimit(model));
}

function normalizeProvider(provider: ApiProviderConfig): ApiProviderConfig {
  const openaiBaseUrl = typeof provider.openaiBaseUrl === 'string' ? provider.openaiBaseUrl : '';
  return {
    id: provider.id,
    name: provider.name || '未命名供应商',
    providerType: provider.providerType || inferProviderType(openaiBaseUrl),
    openaiBaseUrl,
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
  // 内置供应商的身份、地址和模型是产品定义的一部分，持久化配置只能保存 API Key。
  const defaultProviders = DEFAULT_API_PROVIDERS.map(defaultProvider => ({
    ...defaultProvider,
    openaiApiKey: configuredById.get(defaultProvider.id)?.openaiApiKey || '',
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
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(provider);
  }

  return result;
}

export interface ApiConfigMigration {
  config: ApiConfig;
  removedProviderIds: string[];
  requiresProviderSelection: boolean;
  changed: boolean;
}

export function migrateApiConfig(
  apiConfig: Partial<ApiConfig> | null | undefined
): ApiConfigMigration {
  const configuredProviders: ApiProviderConfig[] = Array.isArray(apiConfig?.providers)
    ? apiConfig.providers
      .filter((provider): provider is ApiProviderConfig => Boolean(provider?.id))
      .map(normalizeProvider)
    : [];

  const supportedProviders = configuredProviders.filter(provider =>
    !provider.openaiBaseUrl || isRemoteApiBaseUrl(provider.openaiBaseUrl)
  );
  const removedProviderIds = configuredProviders
    .filter(provider => !supportedProviders.includes(provider))
    .map(provider => provider.id);

  const configuredActiveProvider = apiConfig?.activeProviderId
    ? configuredProviders.find(provider => provider.id === apiConfig.activeProviderId)
    : configuredProviders.length === 1
      ? configuredProviders[0]
      : undefined;
  const activeProviderWasRemoved = Boolean(
    configuredActiveProvider && !supportedProviders.some(
      provider => provider.id === configuredActiveProvider.id
    )
  );
  const legacyEndpointWasRemoved = configuredProviders.length === 0
    && typeof apiConfig?.openaiBaseUrl === 'string'
    && apiConfig.openaiBaseUrl.trim().length > 0
    && !isRemoteApiBaseUrl(apiConfig.openaiBaseUrl);
  const providers = mergeDefaultProviders(
    ensureUniqueProviders(
      supportedProviders.length > 0 ? supportedProviders : cloneDefaultProviders()
    )
  );

  const isLegacyImplicitDefaultSelection = apiConfig?.schemaVersion !== API_CONFIG_SCHEMA_VERSION
    && apiConfig?.activeProviderId === 'openai'
    && configuredProviders.length === DEFAULT_API_PROVIDERS.length
    && configuredProviders.every(provider => isDefaultApiProviderId(provider.id))
    && configuredProviders.every(provider => !provider.openaiApiKey);
  const hasActiveProvider = Boolean(
    apiConfig?.activeProviderId
    && providers.some(provider => provider.id === apiConfig.activeProviderId)
    && !isLegacyImplicitDefaultSelection
  );
  const requiresProviderSelection = Boolean(
    apiConfig?.requiresProviderSelection
    || activeProviderWasRemoved
    || legacyEndpointWasRemoved
    || !hasActiveProvider
  );
  const activeProviderId = hasActiveProvider ? apiConfig!.activeProviderId : undefined;
  const activeProvider = activeProviderId
    ? providers.find(provider => provider.id === activeProviderId)
    : undefined;

  const config: ApiConfig = {
    schemaVersion: API_CONFIG_SCHEMA_VERSION,
    activeProviderId,
    requiresProviderSelection,
    providers,
    openaiBaseUrl: activeProvider?.openaiBaseUrl || '',
    openaiApiKey: activeProvider?.openaiApiKey || '',
    llmModel: activeProvider?.llmModel || '',
    providerType: activeProvider?.providerType,
    targetLanguage: apiConfig?.targetLanguage || 'zh',
    threadNum: normalizeThreadNum(activeProvider?.threadNum, activeProvider?.llmModel),
    disableThinking: true,
  };

  return {
    config,
    removedProviderIds,
    requiresProviderSelection,
    changed: apiConfig?.schemaVersion !== API_CONFIG_SCHEMA_VERSION
      || removedProviderIds.length > 0
      || apiConfig?.requiresProviderSelection !== requiresProviderSelection,
  };
}

export function normalizeApiConfig(apiConfig: Partial<ApiConfig> | null | undefined): ApiConfig {
  return migrateApiConfig(apiConfig).config;
}

/** 只校验最终会使用的 provider，允许迁移时清理未激活的旧本地 provider。 */
export function assertApiConfigUsesRemoteEndpoints(
  apiConfig: Partial<ApiConfig> | null | undefined
): void {
  const rawActiveProvider = Array.isArray(apiConfig?.providers) && apiConfig?.activeProviderId
    ? apiConfig.providers.find(provider => provider.id === apiConfig.activeProviderId)
    : undefined;
  const rawModel = typeof rawActiveProvider?.llmModel === 'string'
    ? rawActiveProvider.llmModel.trim()
    : '';
  if (rawActiveProvider
    && !isDefaultApiProviderId(rawActiveProvider.id)
    && !rawModel) {
    throw new Error('翻译模型未配置');
  }

  const rawBaseUrl = typeof rawActiveProvider?.openaiBaseUrl === 'string'
    ? rawActiveProvider.openaiBaseUrl.trim()
    : '';
  if (rawActiveProvider
    && !isDefaultApiProviderId(rawActiveProvider.id)
    && rawBaseUrl) {
    const rawEndpointError = getApiEndpointValidationError(rawBaseUrl);
    if (rawEndpointError) throw new Error(rawEndpointError);
  }

  const normalized = normalizeApiConfig(apiConfig);
  if (normalized.requiresProviderSelection || !normalized.activeProviderId) {
    throw new Error(API_CONFIG_MIGRATION_NOTICE);
  }

  const activeProvider = normalized.providers?.find(
    provider => provider.id === normalized.activeProviderId
  );
  if (!activeProvider) throw new Error(API_CONFIG_MIGRATION_NOTICE);

  if (!activeProvider.llmModel.trim()) {
    throw new Error('翻译模型未配置');
  }

  if (!isDefaultApiProviderId(activeProvider.id)
    && !activeProvider.openaiBaseUrl.trim()) {
    throw new Error('自定义模型必须填写 API Base URL 和翻译模型');
  }

  const error = getApiEndpointValidationError(activeProvider.openaiBaseUrl);

  if (error) throw new Error(error);
}
