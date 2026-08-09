/**
 * Popup 可调用的纯配置桥接函数。
 *
 * 配置归一化仍由 config.ts 负责；这里集中处理 popup 需要的 URL、权限、
 * 并发和 API 错误格式化能力，避免配置模块继续承担浏览器桥接细节。
 */

import {
  assertRemoteApiBaseUrl,
  getApiEndpointValidationError,
  normalizeApiBaseUrl,
} from '../utils/api-url.js';
import { normalizeConcurrency } from '../utils/concurrency.js';
import { formatApiResponseError } from '../utils/error-handler.js';

export function getApiHostPermissionPattern(baseUrl: string): string {
  const parsed = assertRemoteApiBaseUrl(baseUrl);

  return `${parsed.protocol}//${parsed.host}/*`;
}

export interface PopupConfigBridge {
  normalizeConcurrency: typeof normalizeConcurrency;
  normalizeApiBaseUrl: typeof normalizeApiBaseUrl;
  getApiEndpointValidationError: typeof getApiEndpointValidationError;
  getApiHostPermissionPattern: typeof getApiHostPermissionPattern;
  formatApiResponseError: typeof formatApiResponseError;
}

export const popupConfigBridge: PopupConfigBridge = {
  normalizeConcurrency,
  normalizeApiBaseUrl,
  getApiEndpointValidationError,
  getApiHostPermissionPattern,
  formatApiResponseError,
};
