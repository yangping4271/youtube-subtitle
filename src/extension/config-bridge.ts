/**
 * Popup 可调用的纯配置桥接函数。
 *
 * 配置归一化仍由 config.ts 负责；这里集中处理 popup 需要的 URL、权限、
 * 并发和 API 错误格式化能力，避免配置模块继续承担浏览器桥接细节。
 */

import { normalizeApiBaseUrl } from '../utils/api-url.js';
import { normalizeConcurrency } from '../utils/concurrency.js';
import { formatApiResponseError } from '../utils/error-handler.js';

export function getApiHostPermissionPattern(baseUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error('API 地址无效，请填写完整的 HTTPS 地址');
  }

  if (parsed.username || parsed.password) {
    throw new Error('API 地址不能包含用户名或密码');
  }

  const isLocalHttp = parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('第三方 API 必须使用 HTTPS；本地 API 仅支持 localhost 或 127.0.0.1');
  }

  return `${parsed.protocol}//${parsed.host}/*`;
}

export interface PopupConfigBridge {
  normalizeConcurrency: typeof normalizeConcurrency;
  normalizeApiBaseUrl: typeof normalizeApiBaseUrl;
  getApiHostPermissionPattern: typeof getApiHostPermissionPattern;
  formatApiResponseError: typeof formatApiResponseError;
}

export const popupConfigBridge: PopupConfigBridge = {
  normalizeConcurrency,
  normalizeApiBaseUrl,
  getApiHostPermissionPattern,
  formatApiResponseError,
};
