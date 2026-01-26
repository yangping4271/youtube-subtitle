/**
 * 字符串相似度计算工具
 */

/**
 * 计算两个文本的相似度（0-1）
 * 使用简化的最长公共子序列算法
 */
export function calculateSimilarity(text1: string, text2: string): number {
  if (!text1 && !text2) return 1.0;
  if (!text1 || !text2) return 0.0;

  const len1 = text1.length;
  const len2 = text2.length;
  const dp: number[][] = Array(len1 + 1).fill(0).map(() => Array(len2 + 1).fill(0));

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (text1[i - 1] === text2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[len1][len2];
  return (2.0 * lcs) / (len1 + len2);
}

/**
 * 预处理文本：移除标点符号、规范化空格
 */
export function preprocessText(text: string): string {
  return text.split(/\s+/).filter(w => w.length > 0).join(' ');
}

/**
 * 滑动窗口相似度匹配
 * 查找目标句子在源片段列表中的最佳匹配位置
 */
export function findBestMatch(
  sentence: string,
  segments: { text: string }[],
  startIndex: number,
  maxShift: number = 30,
  threshold: number = 0.5
): { position: number; windowSize: number; similarity: number } | null {
  const sentenceProc = preprocessText(sentence);
  const sentenceWordCount = sentenceProc.split(/\s+/).length;

  let bestRatio = 0.0;
  let bestPos: number | null = null;
  let bestWindowSize = 0;

  // 计算窗口大小范围
  const maxWindowSize = Math.min(sentenceWordCount * 2, segments.length - startIndex);
  const minWindowSize = Math.max(1, Math.floor(sentenceWordCount / 2));

  // 按接近目标词数的顺序尝试窗口大小
  const windowSizes = Array.from(
    { length: maxWindowSize - minWindowSize + 1 },
    (_, i) => minWindowSize + i
  ).sort((a, b) => Math.abs(a - sentenceWordCount) - Math.abs(b - sentenceWordCount));

  for (const windowSize of windowSizes) {
    const maxStart = Math.min(startIndex + maxShift + 1, segments.length - windowSize + 1);

    for (let start = startIndex; start < maxStart; start++) {
      // 合并窗口内的文本
      const substr = segments
        .slice(start, start + windowSize)
        .map(seg => seg.text)
        .join('');
      const substrProc = preprocessText(substr);

      // 计算相似度
      const ratio = calculateSimilarity(sentenceProc, substrProc);

      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestPos = start;
        bestWindowSize = windowSize;
      }

      // 完全匹配，提前退出
      if (ratio === 1.0) {
        break;
      }
    }

    // 完全匹配，提前退出
    if (bestRatio === 1.0) {
      break;
    }
  }

  // 检查是否达到阈值
  if (bestRatio >= threshold && bestPos !== null) {
    return {
      position: bestPos,
      windowSize: bestWindowSize,
      similarity: bestRatio,
    };
  }

  return null;
}
