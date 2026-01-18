/**
 * 总结模块 - 移植自 Python summarizer.py
 * 分析字幕内容，提取翻译所需的上下文信息
 */

import { setupLogger } from '../utils/logger.js';
import { SUMMARIZER_PROMPT } from './prompts.js';
import { parseLlmResponse } from '../utils/json-repair.js';
import type { SummaryResult, TranslatorConfig } from '../types/index.js';

const logger = setupLogger('summarizer');

/**
 * 默认总结结果 - 用于错误回退和填充缺失字段
 */
const DEFAULT_SUMMARY: SummaryResult = {
  context: {
    type: 'unknown',
    topic: 'Unknown topic',
    formality: 'neutral',
  },
  corrections: {},
  style_guide: {
    audience: 'general',
    technical_level: 'intermediate',
    tone: 'neutral',
  },
};

/**
 * OpenAI API 客户端接口
 */
interface OpenAIClient {
  callChat(systemPrompt: string, userPrompt: string, options?: {
    temperature?: number;
    timeout?: number;
  }): Promise<string>;
}

/**
 * 从文件路径提取可读性信息
 * @param inputFile 输入文件路径
 */
export function extractFileContext(inputFile: string): {
  readableName: string;
  folderPath: string;
} {
  // 简化实现：提取文件名和路径
  const parts = inputFile.replace(/\\/g, '/').split('/');
  const fileName = parts.pop() || '';

  // 获取不带扩展名的文件名
  const readableName = fileName
    .replace(/\.[^/.]+$/, '') // 移除扩展名
    .replace(/[_-]/g, ' ');   // 替换下划线和连字符为空格

  // 获取文件夹路径（最多3级）
  const parentParts = parts.slice(-3).map(p => p.replace(/[_-]/g, ' '));
  const folderPath = parentParts.join(' / ');

  return { readableName, folderPath };
}

/**
 * 构建上下文信息字符串
 */
function buildContextInfo(
  inputFile?: string,
  videoTitle?: string,
  videoDescription?: string,
  aiSummary?: string | null
): string {
  const contextParts: string[] = [];

  if (inputFile) {
    const { readableName, folderPath } = extractFileContext(inputFile);
    if (folderPath) {
      contextParts.push(`Folder path: ${folderPath}`);
    }
    contextParts.push(`Filename: ${readableName}`);
  }

  if (videoTitle) {
    contextParts.push(`Video title: ${videoTitle}`);
  }

  // 新增：使用 YouTube 官方数据作为上下文
  if (videoDescription) {
    contextParts.push(`Video description: ${videoDescription}`);
  }

  if (aiSummary) {
    contextParts.push(`AI-generated summary: ${aiSummary}`);
  }

  return contextParts.join('\n');
}

/**
 * 总结器类
 */
export class Summarizer {
  private client: OpenAIClient;
  private config: TranslatorConfig;

  constructor(client: OpenAIClient, config: TranslatorConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * 总结字幕内容
   * @param subtitleContent 字幕内容文本
   * @param options 选项
   */
  async summarize(
    subtitleContent: string,
    options: {
      inputFile?: string;
      videoTitle?: string;
      videoDescription?: string;
      aiSummary?: string | null;
    } = {}
  ): Promise<SummaryResult> {
    const { inputFile, videoTitle, videoDescription, aiSummary } = options;

    // 提取文件上下文信息
    const contextInfo = buildContextInfo(inputFile, videoTitle, videoDescription, aiSummary);

    if (inputFile) {
      const { readableName, folderPath } = extractFileContext(inputFile);
      logger.info(`📋 可读性文件名: ${readableName}`);
      if (folderPath) {
        logger.info(`📂 文件夹路径: ${folderPath}`);
      }
    }

    // 获取当前日期
    const currentDate = new Date().toISOString().split('T')[0];

    // 替换 prompt 中的日期占位符
    const promptWithDate = SUMMARIZER_PROMPT.replace('{current_date}', currentDate);

    // 构建用户提示
    const userPrompt = contextInfo
      ? `${contextInfo}\n\nContent:\n${subtitleContent}`
      : `Content:\n${subtitleContent}`;

    try {
      const response = await this.client.callChat(promptWithDate, userPrompt, {
        temperature: 0.7,
        timeout: 80000,
      });

      if (!response) {
        throw new Error('API 返回为空');
      }

      // 移除 <think></think> 标签
      const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '');

      // 解析 JSON 响应
      const result = parseLlmResponse(cleanedResponse) as unknown as SummaryResult;

      // 验证并填充缺失字段
      const summary: SummaryResult = {
        context: result.context || DEFAULT_SUMMARY.context,
        corrections: result.corrections || {},
        style_guide: result.style_guide || DEFAULT_SUMMARY.style_guide,
      };

      // 输出完整的总结内容（与 Python 版本一致）
      logger.info(`总结字幕内容:\n${JSON.stringify(summary, null, 2)}\n`);

      return summary;

    } catch (error) {
      logger.error(`内容分析失败: ${error}`);
      return DEFAULT_SUMMARY;
    }
  }
}

/**
 * 创建总结器实例
 */
export function createSummarizer(client: OpenAIClient, config: TranslatorConfig): Summarizer {
  return new Summarizer(client, config);
}
