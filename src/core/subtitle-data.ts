/**
 * 字幕数据处理模块
 */

import type { SubtitleEntry } from '../types/index.js';

/**
 * 字幕数据容器类
 * 提供字幕类型检测和转换功能
 */
export class SubtitleData {
  private segments: SubtitleEntry[];

  constructor(segments: SubtitleEntry[]) {
    // 过滤空字幕并按时间排序
    this.segments = segments
      .filter(seg => seg.text && seg.text.trim())
      .sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * 获取所有字幕片段
   */
  getSegments(): SubtitleEntry[] {
    return this.segments;
  }

  /**
   * 获取字幕数量
   */
  length(): number {
    return this.segments.length;
  }

  /**
   * 判断是否是单词级时间戳
   */
  isWordTimestamp(): boolean {
    if (this.segments.length === 0) {
      return false;
    }

    let validSegments = 0;
    const totalSegments = this.segments.length;

    for (const seg of this.segments) {
      const text = seg.text.trim();

      // 检查是否只包含一个英文单词或一个汉字
      // 使用更严格的 ≤2 字符检测（参考 VideoCaptioner 标准）
      const isAsciiWord = text.split(/\s+/).length === 1 && /^[\x00-\x7F]+$/.test(text);
      const isShortSegment = text.length <= 2;

      if (isAsciiWord || isShortSegment) {
        validSegments++;
      }
    }

    return (validSegments / totalSegments) >= 0.8;
  }

  /**
   * 将片段转换为单词（按单词拆分）
   */
  splitToWordSegments(): SubtitleData {
    const CHARS_PER_PHONEME = 4;  // 每个音素包含的字符数（基于语音学理论）
    const newSegments: SubtitleEntry[] = [];

    for (const seg of this.segments) {
      const text = seg.text;
      const duration = seg.endTime - seg.startTime;

      // 多语言字符匹配模式 + 标点符号
      const pattern = new RegExp(
        // 以单词形式出现的语言(连续提取)
        "[a-zA-Z\\u00c0-\\u00ff\\u0100-\\u017f']+" +  // 拉丁字母及其变体(英语、德语、法语等)
        "|[\\u0400-\\u04ff]+" +  // 西里尔字母(俄语等)
        "|[\\u0370-\\u03ff]+" +  // 希腊语
        "|[\\u0600-\\u06ff]+" +  // 阿拉伯语
        "|[\\u0590-\\u05ff]+" +  // 希伯来语
        "|\\d+" +  // 数字
        // 以单字形式出现的语言(单字提取)
        "|[\\u4e00-\\u9fff]" +  // 中文
        "|[\\u3040-\\u309f]" +  // 日文平假名
        "|[\\u30a0-\\u30ff]" +  // 日文片假名
        "|[\\uac00-\\ud7af]" +  // 韩文
        "|[\\u0e00-\\u0e7f][\\u0e30-\\u0e3a\\u0e47-\\u0e4e]*" +  // 泰文基字符及其音标组合
        "|[\\u0900-\\u097f]" +  // 天城文(印地语等)
        "|[\\u0980-\\u09ff]" +  // 孟加拉语
        "|[\\u0e80-\\u0eff]" +  // 老挝文
        "|[\\u1000-\\u109f]" +  // 缅甸文
        // 标点符号（作为单独的token）
        "|[.,!?;:…。，！？；：、]",  // 常见标点符号
        'g'
      );

      const matches = Array.from(text.matchAll(pattern));

      if (matches.length === 0) {
        // 如果没有匹配到有效字符，跳过此段
        continue;
      }

      // 计算总音素数（标点符号算作0.5个音素）
      const totalPhonemes = matches.reduce((sum, match) => {
        const token = match[0];
        // 如果是标点符号，算作0.5个音素
        if (/[.,!?;:…。，！？；：、]/.test(token)) {
          return sum + 0.5;
        }
        return sum + Math.ceil(token.length / CHARS_PER_PHONEME);
      }, 0);

      const timePerPhoneme = duration / Math.max(totalPhonemes, 1);  // 防止除零错误

      // 为每个识别出的词/字符/标点创建独立的时间戳
      let currentTime = seg.startTime;
      const MIN_WORD_DURATION = 50; // 最小时长50毫秒
      const MIN_PUNCTUATION_DURATION = 30; // 标点最小时长30毫秒

      for (const match of matches) {
        const token = match[0];

        // 判断是否是标点符号
        const isPunctuation = /[.,!?;:…。，！？；：、]/.test(token);

        // 计算当前token的音素数量
        const tokenPhonemes = isPunctuation ? 0.5 : Math.ceil(token.length / CHARS_PER_PHONEME);
        const minDuration = isPunctuation ? MIN_PUNCTUATION_DURATION : MIN_WORD_DURATION;

        // 使用浮点数计算，确保每个token至少有最小时长
        const tokenDuration = Math.max(timePerPhoneme * tokenPhonemes, minDuration);

        // 创建新的字词级 segment，确保时间不超出原始范围
        const tokenEndTime = Math.min(currentTime + tokenDuration, seg.endTime);

        newSegments.push({
          index: newSegments.length + 1,
          startTime: currentTime,
          endTime: tokenEndTime,
          text: token,
        });

        currentTime = tokenEndTime;
      }
    }

    return new SubtitleData(newSegments);
  }

  /**
   * 转换为纯文本格式
   */
  toText(): string {
    const texts: string[] = [];

    for (const seg of this.segments) {
      const text = seg.text.trim();

      if (!text) continue;

      // 如果是标点符号，不需要前导空格
      if (texts.length > 0 && /^[^\w\s]/.test(text)) {
        // 直接附加到前一个文本，不加空格
        texts[texts.length - 1] += text;
      } else {
        texts.push(text);
      }
    }

    return texts.join(' ');
  }
}
