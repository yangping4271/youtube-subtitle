/**
 * 字幕相关类型定义
 *
 * 时间单位标准：所有时间戳使用毫秒（整数）
 */

import type { CancellationSignal } from '../utils/cancellation.js';

/** 原始字幕条目 */
export interface SubtitleEntry {
  index: number;
  startTime: number;  // 毫秒（整数）
  endTime: number;    // 毫秒（整数）
  text: string;
}

/** 翻译后的字幕条目 */
export interface TranslatedEntry {
  index: number;
  startTime: number;  // 毫秒（整数）
  endTime: number;    // 毫秒（整数）
  original: string;
  translation: string;
}

/** 双语字幕结果 */
export interface BilingualSubtitles {
  english: SubtitleEntry[];
  chinese: SubtitleEntry[];
}

/** 断句统计 */
export interface SplitStats {
  normal: number;      // ≤ target
  tolerated: number;   // target < x ≤ tolerance
  optimized: number;   // tolerance < x ≤ warning
  forced: number;      // warning < x ≤ max
  rejected: number;    // > max
}

/** 预分句结果 */
export interface PreSplitSentence {
  text: string;              // 句子文本
  wordStartIndex: number;    // 起始单词索引
  wordEndIndex: number;      // 结束单词索引（不含）
  startTime: number;         // 起始时间（毫秒）
  endTime: number;           // 结束时间（毫秒）
}

/** API 配置 */
export type ApiProviderType = 'openai' | 'openrouter' | 'deepseek' | 'custom';

export interface ApiProviderConfig {
  id: string;
  name: string;
  providerType?: ApiProviderType;
  openaiBaseUrl: string;
  openaiApiKey: string;
  llmModel: string;
  threadNum?: number;  // 并发数，默认 6
  /** @deprecated 保留用于读取旧配置；翻译请求会优先尝试关闭思考模式。 */
  disableThinking?: boolean;
}

export interface ApiConfig extends Partial<ApiProviderConfig> {
  schemaVersion?: number;
  activeProviderId?: string;
  /** 没有可用的激活 provider 时，必须由用户明确选择。 */
  requiresProviderSelection?: boolean;
  providers?: ApiProviderConfig[];
  openaiBaseUrl: string;
  openaiApiKey: string;
  llmModel: string;
  targetLanguage: string;
  threadNum?: number;  // 并发数，默认 6
}

/** 翻译器配置 */
export interface TranslatorConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  model: string;
  providerType?: ApiProviderType;
  targetLanguage: string;
  maxWordCountEnglish: number;
  threadNum: number;
  batchSize: number;
  /** 固定为 true；表示请求会优先尝试关闭思考模式。 */
  disableThinking?: boolean;
  // 阈值倍数
  toleranceMultiplier: number;
  warningMultiplier: number;
  maxMultiplier: number;
}

/** Chat API 的 JSON Schema 输出格式 */
export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

/** Chat API 的 JSON Object 输出格式 */
export interface JsonObjectResponseFormat {
  type: 'json_object';
}

/** Chat API 调用选项 */
export interface ChatOptions {
  temperature?: number;
  timeout?: number;
  signal?: CancellationSignal;
  responseFormat?: JsonSchemaResponseFormat | JsonObjectResponseFormat;
}

// ========================================
// Chrome Extension 相关类型
// ========================================

/** 字幕样式设置 */
export interface SubtitleStyleSettings {
  fontSize: number;
  fontColor: string;
  fontFamily: string;
  fontWeight: string;
  textStroke: string;
  textShadow: string;
  lineHeight: number;
}

/** DPR 补偿配置 */
export interface DPRConfig {
  enabled: boolean;
  compensationFactor: number;
}

/** UI 配置 */
export interface UIConfig {
  fontSizeMin: number;
  fontSizeMax: number;
}

/** 完整字幕配置 */
export interface SubtitleConfig {
  english: SubtitleStyleSettings;
  chinese: SubtitleStyleSettings;
  dpr: DPRConfig;
  ui: UIConfig;
}

/** 支持的语言选项 */
export interface LanguageOption {
  value: string;
  text: string;
}

/** 简单字幕条目（不含 index） */
export interface SimpleSubtitleEntry {
  startTime: number;
  endTime: number;
  text: string;
}

/** ASS 解析结果 */
export interface ASSParseResult {
  english: SimpleSubtitleEntry[];
  chinese: SimpleSubtitleEntry[];
}

/** 视频信息 */
export interface VideoInfo {
  ytTitle: string;
  channelName: string;
  uploadDate: string;
  videoURL: string;
  videoId: string;
  description?: string;      // YouTube 视频说明
  aiSummary?: string | null; // YouTube AI 生成的摘要（可能不存在）
}

/** 翻译会话需要携带的视频上下文。 */
export interface TranslationVideoInfo {
  title?: string;
  ytTitle?: string;
  description?: string;
  aiSummary?: string | null;
}

/** 发送给翻译模型的上下文信息。 */
export interface TranslationContext {
  videoTitle?: string;
  videoDescription?: string;
  aiSummary?: string | null;
}

/** 视频字幕缓存数据 */
export interface VideoSubtitleData {
  videoId: string;
  timestamp: string;
  englishSubtitles?: SimpleSubtitleEntry[];
  chineseSubtitles?: SimpleSubtitleEntry[];
  subtitleData?: SimpleSubtitleEntry[];
}

/** 翻译进度状态 */
export interface TranslationProgress {
  isTranslating: boolean;
  completed?: boolean;
  videoId?: string;
  step?: string;
  current?: number;
  total?: number;
  error?: string;
  timestamp?: number;
}
