/**
 * 错误处理工具
 */
export enum ErrorCategory {
  MODEL_NOT_FOUND = 'model_not_found',
  INVALID_API_KEY = 'invalid_api_key',
  RATE_LIMIT = 'rate_limit',
  TIMEOUT = 'timeout',
  NETWORK = 'network',
  SERVER_ERROR = 'server_error',
  UNKNOWN = 'unknown',
}

/**
 * 错误信息接口
 */
export interface ErrorInfo {
  category: ErrorCategory;
  message: string;
  suggestion: string;
  isRetryable: boolean;
}

export interface ApiResponseError extends Error {
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  /** 服务端返回的完整正文，不用提取后的 message 替代。 */
  rawBody?: string;
  parsedBody?: unknown;
}

/** HTTP 层唯一的重试/终止分类来源。 */
export interface HttpStatusPolicy {
  category: ErrorCategory;
  suggestion: string;
  isRetryable: boolean;
}

export function getHttpStatusPolicy(status: number): HttpStatusPolicy {
  if (status === 401 || status === 403) {
    return {
      category: ErrorCategory.INVALID_API_KEY,
      suggestion: '请检查 API 密钥和账号权限是否正确配置',
      isRetryable: false,
    };
  }

  if (status === 404) {
    return {
      category: ErrorCategory.MODEL_NOT_FOUND,
      suggestion: '请检查 API 地址和模型名称是否正确',
      isRetryable: false,
    };
  }

  if (status === 408) {
    return {
      category: ErrorCategory.TIMEOUT,
      suggestion: '请求超时，请稍后重试或减小批次大小',
      isRetryable: true,
    };
  }

  if (status === 409 || status === 425 || status === 429) {
    return {
      category: ErrorCategory.RATE_LIMIT,
      suggestion: '请稍后重试，或降低并发数',
      isRetryable: true,
    };
  }

  if (status >= 500) {
    return {
      category: ErrorCategory.SERVER_ERROR,
      suggestion: '服务器暂时不可用，请稍后重试',
      isRetryable: true,
    };
  }

  return {
    category: ErrorCategory.UNKNOWN,
    suggestion: '请检查 API 请求参数和服务端返回内容',
    isRetryable: !(status >= 400 && status < 500),
  };
}

function getStructuredApiErrorField(error: Error, field: 'param' | 'code'): string | undefined {
  const parsedBody = (error as ApiResponseError).parsedBody;
  if (!parsedBody || typeof parsedBody !== 'object') {
    return undefined;
  }

  const body = parsedBody as Record<string, unknown>;
  const nestedError = body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown>
    : undefined;
  const value = nestedError?.[field] ?? body[field];
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function mentionsResponseFormat(value: string): boolean {
  return /response[\s_-]?format|json[\s_-]?schema|json[\s_-]?object/.test(value);
}

const FORMAT_MARKER_SOURCE = '(?:response[\\s_-]?format|json[\\s_-]?schema|json[\\s_-]?object|structured outputs?)';
const FORMAT_UNSUPPORTED_SOURCE = [
  'unsupported',
  'not\\s+supported',
  'does\\s+not\\s+support',
  'unavailable',
  'not\\s+available',
  'unknown\\s+parameter',
  'unrecognized\\s+parameter',
  'extra\\s+inputs\\s+are\\s+not\\s+permitted',
].join('|');

function hasExplicitUnsupportedFormatSemantics(message: string): boolean {
  const markerThenUnsupported = new RegExp(
    `${FORMAT_MARKER_SOURCE}(?:\\s*=\\s*[\\w-]+)?\\s*[,:(-]?\\s*` +
      `(?:is\\s+|are\\s+)?(?:${FORMAT_UNSUPPORTED_SOURCE})`
  );
  const unsupportedThenMarker = new RegExp(
    `(?:${FORMAT_UNSUPPORTED_SOURCE})(?:\\s+(?:parameter|field|option|value))?` +
      `(?:(?:\\s+for|\\s*:|:))?\\s*${FORMAT_MARKER_SOURCE}`
  );

  return message.split(/[;.!?\n]+/).some((clause) =>
    markerThenUnsupported.test(clause) || unsupportedThenMarker.test(clause)
  );
}

function hasUnsupportedRequestParameterSemantics(message: string): boolean {
  return [
    'unsupported',
    'not supported',
    'does not support',
    'unavailable',
    'invalid parameter',
    'unknown parameter',
    'unrecognized parameter',
    'extra inputs are not permitted',
    'not available',
  ].some(pattern => message.includes(pattern));
}

function isTrustedFormatCompatibilityCode(code?: string): boolean {
  return Boolean(
    code
      && mentionsResponseFormat(code)
      && /unsupported|not[\s_-]?supported|unavailable|not[\s_-]?available/.test(code)
  );
}

function canAttemptRequestCompatibilityFallback(error: Error): boolean {
  const status = (error as ApiResponseError).status;
  if (status === undefined) return true;
  if (typeof status !== 'number') return false;

  const policy = getHttpStatusPolicy(status);
  // 只允许明确的、不可重试的客户端参数错误（例如 400/422）触发格式降级。
  // 鉴权、模型不存在、限流、超时和服务端错误即使正文提到 response_format，
  // 也必须原样向上传播。
  return status >= 400
    && status < 500
    && policy.category === ErrorCategory.UNKNOWN
    && !policy.isRetryable;
}

/** 判断 API 是否明确表示不支持当前 response_format。 */
export function isResponseFormatUnsupportedError(error: Error): boolean {
  if (!canAttemptRequestCompatibilityFallback(error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const structuredParam = getStructuredApiErrorField(error, 'param');
  const structuredCode = getStructuredApiErrorField(error, 'code');

  // param 只能限定错误位置，不能单独证明接口不支持该格式。
  if (structuredParam !== undefined) {
    if (!mentionsResponseFormat(structuredParam)) {
      return false;
    }

    return hasUnsupportedRequestParameterSemantics(message)
      || isTrustedFormatCompatibilityCode(structuredCode);
  }

  if (isTrustedFormatCompatibilityCode(structuredCode)) {
    return true;
  }

  return hasExplicitUnsupportedFormatSemantics(message);
}

/** 判断 API 是否明确拒绝某个可选请求参数。 */
export function isOptionalRequestParameterUnsupportedError(
  error: Error,
  parameterName: string
): boolean {
  if (!canAttemptRequestCompatibilityFallback(error)) {
    return false;
  }

  const normalizedParameter = parameterName.toLowerCase();
  const message = error.message.toLowerCase();
  const structuredParam = getStructuredApiErrorField(error, 'param');
  const structuredCode = getStructuredApiErrorField(error, 'code');

  if (structuredParam !== undefined) {
    return structuredParam.includes(normalizedParameter)
      && (hasUnsupportedRequestParameterSemantics(message)
        || hasUnsupportedRequestParameterSemantics(structuredCode || ''));
  }

  const escapedParameter = normalizedParameter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parameterPattern = new RegExp(
    `(?:${escapedParameter}.{0,32}(?:unsupported|not\\s+supported|unavailable|invalid|unknown|unrecognized)` +
      `|(?:unsupported|not\\s+supported|unavailable|invalid|unknown|unrecognized)` +
      `.{0,32}${escapedParameter})`
  );
  return parameterPattern.test(message)
    || Boolean(structuredCode
      && structuredCode.includes(normalizedParameter)
      && hasUnsupportedRequestParameterSemantics(structuredCode));
}

function getResponseRequestId(response: Response): string | undefined {
  for (const headerName of ['x-request-id', 'request-id', 'x-amzn-requestid']) {
    const value = response.headers?.get(headerName)?.trim();
    if (value) return value;
  }
  return undefined;
}

function getResponseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers?.get('retry-after')?.trim();
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 120_000);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? undefined
    : Math.min(Math.max(retryAt - Date.now(), 0), 120_000);
}

/** 将 OpenAI-compatible HTTP 响应转换成统一的可诊断错误。 */
export async function createApiResponseError(response: Response): Promise<ApiResponseError> {
  let rawBody = '';

  if (typeof response.text === 'function') {
    rawBody = await response.text();
  } else if (typeof response.json === 'function') {
    const parsedBody = await response.json().catch(() => null);
    rawBody = parsedBody ? JSON.stringify(parsedBody) : '';
  }

  let parsedBody: unknown;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    parsedBody = undefined;
  }

  const bodyRecord = parsedBody && typeof parsedBody === 'object'
    ? parsedBody as {
      error?: { message?: unknown } | string;
      message?: unknown;
      request_id?: unknown;
    }
    : undefined;
  const nestedError = bodyRecord?.error;
  const nestedMessage = typeof nestedError === 'string'
    ? nestedError
    : nestedError?.message;
  const responseMessage = typeof nestedMessage === 'string'
    ? nestedMessage
    : typeof bodyRecord?.message === 'string'
      ? bodyRecord.message
      : rawBody.trim();
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const headerRequestId = getResponseRequestId(response);
  const bodyRequestId = typeof bodyRecord?.request_id === 'string'
    ? bodyRecord.request_id.trim()
    : undefined;
  const requestId = headerRequestId || bodyRequestId;
  const retryAfterMs = getResponseRetryAfterMs(response);
  // rawBody 是诊断的事实来源：结构化响应中的 code、diagnostic 和 request_id
  // 不能在提取 error.message 时丢失。错误对象另存完整正文，message 也保留完整正文。
  const detail = rawBody.trim() || responseMessage;
  const error = new Error(
    `HTTP ${response.status}${statusText}${detail ? `: ${detail}` : ''}${requestId ? ` (request_id=${requestId})` : ''}${retryAfterMs !== undefined ? ` (retry_after=${Math.ceil(retryAfterMs / 1000)}s)` : ''}`
  ) as ApiResponseError;

  error.name = 'ApiRequestError';
  error.status = response.status;
  error.requestId = requestId;
  error.retryAfterMs = retryAfterMs;
  error.rawBody = rawBody;
  error.parsedBody = parsedBody;
  return error;
}

export async function formatApiResponseError(response: Response): Promise<string> {
  return (await createApiResponseError(response)).message;
}

/**
 * 错误分类规则
 */
const ERROR_RULES: Array<{
  category: ErrorCategory;
  patterns: string[];
  suggestion: string;
  isRetryable: boolean;
}> = [
  {
    category: ErrorCategory.MODEL_NOT_FOUND,
    patterns: ['model_not_found', 'model does not exist'],
    suggestion: '请检查模型名称是否正确，或更换其他可用模型（如 gpt-4o-mini, gpt-4o）',
    isRetryable: false,
  },
  {
    category: ErrorCategory.INVALID_API_KEY,
    patterns: ['invalid api key', 'incorrect api key', 'api key not found', 'authentication failed', 'invalid_api_key'],
    suggestion: '请检查 API 密钥是否正确配置，确认密钥有效且未过期',
    isRetryable: false,
  },
  {
    category: ErrorCategory.RATE_LIMIT,
    patterns: ['rate_limit_exceeded', 'rate limit', 'too many requests', '429'],
    suggestion: '请稍后重试，或考虑升级 API 套餐以获得更高的速率限制',
    isRetryable: true,
  },
  {
    category: ErrorCategory.TIMEOUT,
    patterns: ['timeout', 'timed out', 'aborterror'],
    suggestion: '请检查网络连接，或稍后重试。如果问题持续，请考虑减小批次大小',
    isRetryable: true,
  },
  {
    category: ErrorCategory.NETWORK,
    patterns: ['network', 'fetch failed', 'econnreset', 'econnrefused'],
    suggestion: '请检查网络连接，确认能够访问 OpenAI API 服务器',
    isRetryable: true,
  },
  {
    category: ErrorCategory.SERVER_ERROR,
    patterns: ['500', '502', '503', 'internal server error', 'bad gateway', 'service unavailable'],
    suggestion: '服务器暂时不可用，请稍后重试',
    isRetryable: true,
  },
];

/**
 * 提取错误消息
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (typeof error === 'object' && error !== null) {
    const apiError = error as { error?: { message?: string } };
    if (apiError.error?.message) return apiError.error.message;

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

/**
 * 分类错误并提供建议
 */
export function classifyErrorWithSuggestion(error: unknown): ErrorInfo {
  const status = typeof error === 'object' && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  if (typeof status === 'number') {
    const httpInfo = getHttpStatusPolicy(status);
    return {
      category: httpInfo.category,
      message: extractErrorMessage(error),
      suggestion: `💡 建议：${httpInfo.suggestion}`,
      isRetryable: httpInfo.isRetryable,
    };
  }

  const message = extractErrorMessage(error).toLowerCase();

  for (const rule of ERROR_RULES) {
    if (rule.patterns.some(pattern => message.includes(pattern))) {
      return {
        category: rule.category,
        message: extractErrorMessage(error),
        suggestion: `💡 建议：${rule.suggestion}`,
        isRetryable: rule.isRetryable,
      };
    }
  }

  return {
    category: ErrorCategory.UNKNOWN,
    message: extractErrorMessage(error),
    suggestion: '💡 建议：请查看错误详情，或联系技术支持',
    isRetryable: true,
  };
}

/**
 * 格式化错误信息
 */
export function formatErrorWithSuggestion(error: unknown): string {
  const errorInfo = classifyErrorWithSuggestion(error);
  return `${errorInfo.message}\n${errorInfo.suggestion}`;
}

/**
 * 自定义翻译错误类
 */
export class TranslationError extends Error {
  public readonly suggestion: string;
  public readonly category: ErrorCategory;
  public readonly isRetryable: boolean;

  constructor(message: string, errorInfo?: Partial<ErrorInfo>) {
    super(message);
    this.name = 'TranslationError';
    this.suggestion = errorInfo?.suggestion || '请检查配置或稍后重试';
    this.category = errorInfo?.category || ErrorCategory.UNKNOWN;
    this.isRetryable = errorInfo?.isRetryable ?? true;
  }

  static fromError(error: unknown, context?: string): TranslationError {
    const errorInfo = classifyErrorWithSuggestion(error);
    const message = context ? `${context}: ${errorInfo.message}` : errorInfo.message;
    return new TranslationError(message, errorInfo);
  }

  getFullMessage(): string {
    return `${this.message}\n${this.suggestion}`;
  }
}
