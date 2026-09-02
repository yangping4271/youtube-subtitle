import type { ApiProviderType } from '../types/index.js';

/** 返回 API 地址不可用的原因；返回 null 表示该地址受支持。 */
export function getApiEndpointValidationError(baseUrl = ''): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return 'API 地址未配置';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'API 地址无效，请填写完整的 HTTP(S) 地址';
  }

  if (parsed.username || parsed.password) {
    return 'API 地址不能包含用户名或密码';
  }

  const isLocalHttp = parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    return '第三方 API 必须使用 HTTPS；本地 HTTP API 仅支持 localhost 或 127.0.0.1';
  }

  return null;
}

export function assertRemoteApiBaseUrl(baseUrl: string): URL {
  const error = getApiEndpointValidationError(baseUrl);
  if (error) throw new Error(error);

  return new URL(baseUrl.trim());
}

export function isRemoteApiBaseUrl(baseUrl = ''): boolean {
  return getApiEndpointValidationError(baseUrl) === null;
}

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
