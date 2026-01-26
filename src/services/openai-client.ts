/**
 * OpenAI API 客户端
 */

import { withRetry } from '../utils/retry.js';
import { TranslationError } from '../utils/error-handler.js';
import type { TranslatorConfig } from '../types/index.js';

/**
 * OpenAI API 客户端
 */
export class OpenAIClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: TranslatorConfig, modelType: 'split' | 'translation' = 'translation') {
    this.baseUrl = config.openaiBaseUrl;
    this.apiKey = config.openaiApiKey;

    // 根据类型选择模型
    switch (modelType) {
      case 'split':
        this.model = config.splitModel;
        break;
      case 'translation':
      default:
        this.model = config.translationModel;
        break;
    }
  }

  /**
   * 调用 Chat API（带自动重试）
   */
  async callChat(
    systemPrompt: string,
    userPrompt: string,
    options: { temperature?: number; timeout?: number; signal?: AbortSignal } = {}
  ): Promise<string> {
    const { temperature = 0.7, timeout = 80000, signal: externalSignal } = options;

    if (!this.apiKey) {
      throw TranslationError.fromError(
        new Error('API 密钥未配置'),
        'OpenAI Client'
      );
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
    };

    // 使用 withRetry 包装 API 调用，自动重试 2 次
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // 监听外部 signal，如果外部取消则 abort
        const externalAbortHandler = (): void => controller.abort();
        externalSignal?.addEventListener('abort', externalAbortHandler);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = (errorData as { error?: { message?: string } })?.error?.message ||
              `API 请求失败: ${response.status}`;
            throw TranslationError.fromError(new Error(errorMessage), 'API Request');
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
        signal: externalSignal,
      }
    );
  }
}

/**
 * 创建 OpenAI 客户端
 */
export function createOpenAIClient(
  config: TranslatorConfig,
  modelType: 'split' | 'translation' = 'translation'
): OpenAIClient {
  return new OpenAIClient(config, modelType);
}
