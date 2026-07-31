/**
 * OpenAI API 客户端
 */

import { classifyError, withRetry } from '../utils/retry.js';
import { setupLogger } from '../utils/logger.js';
import { createCancellationError } from '../utils/cancellation.js';
import type { ChatOptions, TranslatorConfig } from '../types/index.js';

const logger = setupLogger('openai-client');

type ThinkingDisableMode = 'deepseek' | 'openrouter' | 'openai-compatible';

/**
 * OpenAI API 客户端
 */
export class OpenAIClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private providerType: string;

  constructor(config: TranslatorConfig) {
    this.baseUrl = config.openaiBaseUrl;
    this.apiKey = config.openaiApiKey;
    this.model = config.model;
    this.providerType = config.providerType || 'custom';
  }

  private getHostname(): string {
    try {
      return new URL(this.baseUrl).hostname.toLowerCase();
    } catch {
      return this.baseUrl.toLowerCase();
    }
  }

  private getPathParts(): Set<string> {
    try {
      return new Set(
        new URL(this.baseUrl).pathname
          .split('/')
          .map(part => part.trim().toLowerCase())
          .filter(Boolean)
      );
    } catch {
      return new Set(
        this.baseUrl
          .toLowerCase()
          .split(/[/?#]+/)
          .map(part => part.trim())
          .filter(Boolean)
      );
    }
  }

  /**
   * 初次请求选择一种关闭思考模式的参数格式。
   * URL 识别优先于存储的 providerType，避免代理地址与旧配置不一致时发送错误格式。
   */
  private getThinkingDisableMode(): ThinkingDisableMode {
    const isOpenRouter = this.getHostname().endsWith('openrouter.ai')
      || this.getPathParts().has('openrouter');
    if (isOpenRouter || this.providerType === 'openrouter') {
      return 'openrouter';
    }

    if (this.getHostname().endsWith('deepseek.com') || this.providerType === 'deepseek') {
      return 'deepseek';
    }

    return 'openai-compatible';
  }

  private isThinkingCompatibilityError(
    error: Error,
    mode: ThinkingDisableMode
  ): boolean {
    const message = error.message.toLowerCase();
    const parameterName = mode === 'deepseek'
      ? 'thinking'
      : mode === 'openrouter'
        ? 'reasoning'
        : 'reasoning_effort';

    return message.includes(parameterName) && this.isRequestCompatibilityError(error);
  }

  private removeThinkingDisableParameter(
    body: Record<string, unknown>,
    mode: ThinkingDisableMode
  ): void {
    if (mode === 'deepseek') {
      delete body.thinking;
    } else if (mode === 'openrouter') {
      delete body.reasoning;
    } else {
      delete body.reasoning_effort;
    }
  }

  private isRequestCompatibilityError(error: Error): boolean {
    const message = error.message.toLowerCase();
    const mentionsOptionalRequestParam =
      message.includes('response_format') ||
      message.includes('json_schema') ||
      message.includes('json_object') ||
      message.includes('reasoning_effort') ||
      message.includes('thinking') ||
      message.includes('reasoning');

    if (!mentionsOptionalRequestParam) {
      return false;
    }

    return [
      'unsupported',
      'not supported',
      'unavailable',
      'invalid parameter',
      'unknown parameter',
      'extra inputs are not permitted',
      'invalid_request_error',
      'not available',
    ].some(pattern => message.includes(pattern));
  }

  /**
   * 调用 Chat API（带自动重试）
   */
  async callChat(
    systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): Promise<string> {
    const {
      temperature = 0.7,
      timeout = 80000,
      signal: externalSignal,
      responseFormat,
    } = options;

    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }

    const thinkingDisableMode = this.getThinkingDisableMode();
    if (thinkingDisableMode === 'deepseek') {
      body.thinking = { type: 'disabled' };
    }

    if (thinkingDisableMode === 'openrouter') {
      body.reasoning = { effort: 'none' };
    }

    if (thinkingDisableMode === 'openai-compatible') {
      body.reasoning_effort = 'none';
    }

    logger.info(
      `请求参数: provider=${this.providerType}, model=${this.model}, response_format=${responseFormat?.type || 'none'}, reasoning=${thinkingDisableMode}-disabled`
    );

    // 使用 withRetry 包装 API 调用，自动重试 2 次
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // 监听外部 signal，如果外部取消则 abort
        const externalAbortHandler = (): void => controller.abort();
        externalSignal?.addEventListener('abort', externalAbortHandler);

        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
          }

          const sendRequest = async (): Promise<string> => {
            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              const errorMessage = (errorData as { error?: { message?: string } })?.error?.message ||
                `API 请求失败: ${response.status}`;
              throw new Error(errorMessage);
            }

            const data = await response.json() as {
              choices?: Array<{ message?: { content?: string } }>;
            };

            const content = data.choices?.[0]?.message?.content;
            if (!content) {
              throw new Error('API 返回内容为空');
            }

            return content;
          };

          try {
            return await sendRequest();
          } catch (error) {
            if (
              error instanceof Error &&
              this.isThinkingCompatibilityError(error, thinkingDisableMode)
            ) {
              this.removeThinkingDisableParameter(body, thinkingDisableMode);
              logger.warn(
                `模型或服务不支持关闭思考参数，改用默认思考模式: provider=${this.providerType}, model=${this.model}`
              );
              return sendRequest();
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            // 区分是超时还是外部取消
            if (externalSignal?.aborted) {
              throw createCancellationError('翻译已取消');
            }
            throw new Error('请求超时');
          }
          throw error instanceof Error ? error : new Error(`API 调用失败: ${error}`);
        } finally {
          clearTimeout(timeoutId);
          externalSignal?.removeEventListener('abort', externalAbortHandler);
        }
      },
      {
        maxRetries: 1,
        delays: [1000, 2000],
        operationName: `OpenAI API (${this.model})`,
        shouldRetry: (error) => !this.isRequestCompatibilityError(error) && classifyError(error) === 'retryable',
        signal: externalSignal,
      }
    );
  }
}
