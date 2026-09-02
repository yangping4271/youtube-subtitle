/**
 * 标点符号规范化工具
 */

/**
 * Normalize Chinese punctuation for subtitles
 * Keeps sentence-internal punctuation, removes weak trailing punctuation,
 * and adds spacing between Chinese characters and ASCII words/numbers.
 */
export function normalizeChinesePunctuation(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
    .replace(/[，,、。．.；;：:]+$/g, '');
}

/**
 * Check if the language is Chinese
 */
export function isChinese(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'zh' || l.includes('chinese') || l === '中文';
}
