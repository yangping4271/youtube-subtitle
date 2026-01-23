/**
 * 标点符号规范化工具
 */

/**
 * Normalize English punctuation for subtitles
 * Removes: . , ; :
 * Keeps: ? ! ... ' "
 */
export function normalizeEnglishPunctuation(text: string): string {
  return text.replace(/[.,;:]/g, '');
}

/**
 * Normalize Chinese punctuation for subtitles
 * Removes: ，。、；：
 * Keeps: ？！……·'"
 */
export function normalizeChinesePunctuation(text: string): string {
  return text.replace(/[，。、；：]/g, '');
}

/**
 * Check if the language is Chinese
 */
export function isChinese(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'zh' || l.includes('chinese') || l === '中文';
}
