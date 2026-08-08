import type { ApiProviderType } from '../types/index.js';

/**
 * 将用户填写的 API Base URL 转换为实际请求使用的 Base URL。
 * OpenAI 官方地址只需填写 https://api.openai.com，实际请求自动补全 /v1；
 * 已填写路径的第三方地址保持原样，兼容 /codex/v1 等自定义端点。
 */
export function normalizeApiBaseUrl(
  baseUrl = '',
  providerType?: ApiProviderType
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    const isOpenAi = providerType === 'openai'
      || parsed.hostname.toLowerCase() === 'api.openai.com';

    if (!path && isOpenAi) {
      parsed.pathname = '/v1';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // 地址合法性由 getApiHostPermissionPattern 统一校验；这里保留原值，
    // 让调用方继续返回更具体的地址错误。
  }

  return trimmed;
}
