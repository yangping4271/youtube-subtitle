/**
 * 字幕相关类型定义
 *
 * 时间单位标准：所有时间戳使用毫秒（整数）
 */

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
export interface ApiConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  llmModel: string;
  targetLanguage: string;
  threadNum?: number;  // 并发数，默认 3
}

/** 翻译器配置 */
export interface TranslatorConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  splitModel: string;
  translationModel: string;
  targetLanguage: string;
  maxWordCountEnglish: number;
  threadNum: number;
  batchSize: number;
  // 阈值倍数
  toleranceMultiplier: number;
  warningMultiplier: number;
  maxMultiplier: number;
}

/** 翻译进度回调 */
export type ProgressCallback = (
  step: 'split' | 'translate' | 'complete',
  current: number,
  total: number
) => void;

/** 部分结果回调 */
export type PartialResultCallback = (
  partial: BilingualSubtitles,
  isFirst: boolean
) => void;

/** 翻译选项 */
export interface TranslateOptions {
  inputFile?: string;
  videoTitle?: string;
  videoDescription?: string;      // 视频说明（直接使用，不通过 Summarizer）
  aiSummary?: string | null;      // AI 生成的摘要（直接使用，不通过 Summarizer）
  debug?: boolean;
  signal?: AbortSignal;            // 取消信号
  onProgress?: ProgressCallback;
  onPartialResult?: PartialResultCallback;  // 渐进式结果回调
  firstBatchSize?: number;        // 首批字幕数量，默认 10
}

/** LLM API 响应 */
export interface LLMResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
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

/** 支持的模型选项 */
export interface ModelOption {
  value: string;
  text: string;
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
  step?: string;
  current?: number;
  total?: number;
  error?: string;
  timestamp?: number;
}

/** Chrome 消息类型 */
export type ChromeMessageAction =
  | 'getSubtitleData'
  | 'getBilingualSubtitleData'
  | 'saveSubtitleData'
  | 'saveBilingualSubtitles'
  | 'saveVideoSubtitles'
  | 'toggleSubtitle'
  | 'updateSettings'
  | 'clearSubtitleData'
  | 'forceReset'
  | 'setSubtitleEnabled'
  | 'startTranslation'
  | 'cancelTranslation'
  | 'getTranslationStatus'
  | 'loadSubtitle'
  | 'loadBilingualSubtitles'
  | 'clearData'
  | 'getVideoInfo'
  | 'getSubtitleStatus'
  | 'getYouTubeSubtitles'
  | 'printEnglishSubtitles'
  | 'toggleAutoLoad'
  | 'autoLoadSuccess'
  | 'autoLoadError';
