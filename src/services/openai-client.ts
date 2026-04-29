/**
 * OpenAI API 客户端
 */

import { classifyError, withRetry } from '../utils/retry.js';
import { setupLogger } from '../utils/logger.js';
import type { ChatOptions, TranslatorConfig } from '../types/index.js';

const logger = setupLogger('openai-client');

/**
 * OpenAI API 客户端
 */
export class OpenAIClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private providerType: string;
  private disableThinking: boolean;

  constructor(config: TranslatorConfig) {
    this.baseUrl = config.openaiBaseUrl;
    this.apiKey = config.openaiApiKey;
    this.model = config.model;
    this.providerType = config.providerType || 'custom';
    this.disableThinking = config.disableThinking !== false;
  }

  private getHostname(): string {
    try {
      return new URL(this.baseUrl).hostname;
    } catch {
      return this.baseUrl;
    }
  }

  private shouldSendDeepSeekThinkingDisabled(): boolean {
    if (!this.disableThinking) {
      return false;
    }

    const model = this.model.toLowerCase();
    if (!model.startsWith('deepseek-v4-')) {
      return false;
    }

    return this.providerType === 'deepseek' || this.getHostname().endsWith('deepseek.com');
  }

  private shouldSendOpenRouterReasoningNone(): boolean {
    if (!this.disableThinking) {
      return false;
    }

    return this.providerType === 'openrouter' || this.getHostname().endsWith('openrouter.ai');
  }

  private getOpenAIReasoningEffort(): 'none' | 'minimal' | null {
    if (!this.disableThinking) {
      return null;
    }

    const isOpenAI = this.providerType === 'openai' || this.getHostname().endsWith('api.openai.com');
    if (!isOpenAI) {
      return null;
    }

    const model = this.model.toLowerCase();
    if (model.startsWith('gpt-5.1') || model.startsWith('gpt-5.2')) {
      return 'none';
    }

    if (model.startsWith('gpt-5') && !model.includes('pro')) {
      return 'minimal';
    }

    return null;
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

    const thinkingDisabled = this.shouldSendDeepSeekThinkingDisabled();
    if (thinkingDisabled) {
      body.thinking = { type: 'disabled' };
    }

    const openRouterReasoningDisabled = this.shouldSendOpenRouterReasoningNone();
    if (openRouterReasoningDisabled) {
      body.reasoning = { effort: 'none' };
    }

    const openAIReasoningEffort = this.getOpenAIReasoningEffort();
    if (openAIReasoningEffort) {
      body.reasoning_effort = openAIReasoningEffort;
    }

    logger.info(
      `请求参数: provider=${this.providerType}, model=${this.model}, response_format=${responseFormat?.type || 'none'}, reasoning=${thinkingDisabled ? 'deepseek-disabled' : openRouterReasoningDisabled ? 'openrouter-none' : openAIReasoningEffort ? `openai-${openAIReasoningEffort}` : 'default'}`
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
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            // 区分是超时还是外部取消
            if (externalSignal?.aborted) {
              throw new DOMException('翻译已取消', 'AbortError');
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
