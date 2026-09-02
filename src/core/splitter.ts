/**
 * 断句模块 - 包含 5 层防护机制和智能分割策略
 */

import { setupLogger } from '../utils/logger.js';
import { buildSplitPrompt } from './prompts.js';
import { SubtitleData } from './subtitle-data.js';
import type { CancellationSignal } from '../utils/cancellation.js';
import type { TranslatorConfig, SplitStats, SubtitleEntry, PreSplitSentence } from '../types/index.js';

const logger = setupLogger('splitter');

// 时间间隔阈值（毫秒）
const MAX_GAP = 1500; // 1.5秒
const MAX_WORDS_PER_PRESPLIT = 80;
const TOKEN_BOUNDARY_PUNCTUATION = /([.,!?;:…。，！？；：、])/g;

/**
 * 基于标点预分句，返回句子列表及其对应的单词索引范围
 */
export function presplitByPunctuation(wordSegments: SubtitleEntry[]): PreSplitSentence[] {
  if (wordSegments.length === 0) return [];

  // 拼接所有单词为完整文本
  const fullText = wordSegments.map(seg => seg.text).join(' ');

  // 使用 splitByEndMarks 进行预分句
  const sentences = splitByEndMarks(fullText);

  const preSplitSentences: PreSplitSentence[] = [];
  let currentWordIndex = 0;

  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/);
    const wordCount = sentenceWords.length;

    // 计算单词索引范围
    const wordStartIndex = currentWordIndex;
    const wordEndIndex = currentWordIndex + wordCount;

    // 获取时间范围
    const startTime = wordSegments[wordStartIndex]?.startTime || 0;
    const endTime = wordSegments[Math.min(wordEndIndex - 1, wordSegments.length - 1)]?.endTime || 0;

    preSplitSentences.push({
      text: sentence,
      wordStartIndex,
      wordEndIndex,
      startTime,
      endTime,
    });

    currentWordIndex = wordEndIndex;
  }

  const finalSentences: PreSplitSentence[] = [];
  for (const sentence of preSplitSentences) {
    if (countWords(sentence.text) > MAX_WORDS_PER_PRESPLIT) {
      const splitSentences = splitLongSentenceByTimeGaps(
        sentence,
        wordSegments,
        MAX_WORDS_PER_PRESPLIT
      );
      finalSentences.push(...splitSentences);
    } else {
      finalSentences.push(sentence);
    }
  }

  return finalSentences;
}

function splitLongSentenceByTimeGaps(
  sentence: PreSplitSentence,
  wordSegments: SubtitleEntry[],
  maxWordsPerSplit: number
): PreSplitSentence[] {
  const wordCount = countWords(sentence.text);
  if (wordCount <= maxWordsPerSplit) {
    return [sentence];
  }

  const startIndex = sentence.wordStartIndex;
  const endIndex = Math.min(sentence.wordEndIndex, wordSegments.length);
  if (startIndex < 0 || startIndex >= endIndex) {
    return [sentence];
  }

  const sentenceSegments = wordSegments.slice(startIndex, endIndex);
  if (sentenceSegments.length === 0) {
    return [sentence];
  }

  const gaps: Array<{ index: number; gap: number }> = [];
  for (let i = 0; i < sentenceSegments.length - 1; i++) {
    const gap = sentenceSegments[i + 1].startTime - sentenceSegments[i].endTime;
    gaps.push({ index: i + 1, gap });
  }

  let splitPositions: number[] = [];
  const largeGaps = gaps.filter(item => item.gap > MAX_GAP);
  if (largeGaps.length > 0) {
    splitPositions = largeGaps.map(item => item.index);
  } else {
    const targetSplits = Math.max(Math.ceil(wordCount / maxWordsPerSplit) - 1, 0);
    if (targetSplits > 0) {
      const sortedGaps = gaps.slice().sort((a, b) => b.gap - a.gap);
      splitPositions = sortedGaps.slice(0, targetSplits).map(item => item.index);
    }
  }

  if (splitPositions.length === 0) {
    return [sentence];
  }

  splitPositions = Array.from(new Set(splitPositions)).sort((a, b) => a - b);

  const results: PreSplitSentence[] = [];
  let prevIndex = 0;

  const pushSegment = (from: number, to: number): void => {
    if (to <= from) return;
    const segs = sentenceSegments.slice(from, to);
    if (segs.length === 0) return;
    results.push({
      text: segs.map(seg => seg.text).join(' '),
      wordStartIndex: startIndex + from,
      wordEndIndex: startIndex + to,
      startTime: segs[0].startTime || 0,
      endTime: segs[segs.length - 1].endTime || 0,
    });
  };

  for (const pos of splitPositions) {
    if (pos <= prevIndex || pos >= sentenceSegments.length) continue;
    pushSegment(prevIndex, pos);
    prevIndex = pos;
  }

  pushSegment(prevIndex, sentenceSegments.length);

  return results.length > 0 ? results : [sentence];
}

/**
 * 按词数分批，保持预分句完整不切割
 */
export function batchBySentenceCount(
  sentences: PreSplitSentence[],
  firstBatchMaxWords: number = 150,
  batchMaxWords: number = 500
): PreSplitSentence[][] {
  if (sentences.length === 0) return [];

  const batches: PreSplitSentence[][] = [];
  let currentBatch: PreSplitSentence[] = [];
  let currentWords = 0;
  let isFirstBatch = true;

  for (const sentence of sentences) {
    const words = countWords(sentence.text);
    const maxWords = isFirstBatch ? firstBatchMaxWords : batchMaxWords;

    if (currentBatch.length > 0 && currentWords + words > maxWords) {
      batches.push(currentBatch);
      currentBatch = [sentence];
      currentWords = words;
      isFirstBatch = false;
    } else {
      currentBatch.push(sentence);
      currentWords += words;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * 在批次内进行断句和时间戳对齐
 */
export async function mergeSegmentsWithinBatch(
  preSplitSentences: PreSplitSentence[],
  wordSegments: SubtitleEntry[],
  client: OpenAIClient,
  config: TranslatorConfig,
  batchIndex?: number,
  signal?: CancellationSignal
): Promise<SubtitleData> {
  if (preSplitSentences.length === 0) {
    return new SubtitleData([]);
  }

  // 提取批次对应的单词片段
  const startIndex = preSplitSentences[0].wordStartIndex;
  const endIndex = preSplitSentences[preSplitSentences.length - 1].wordEndIndex;
  const batchWordSegments = wordSegments.slice(startIndex, endIndex);

  // 发送给 LLM 的文本使用自然标点格式；内部预分句仍保留独立标点 token，
  // 以免改变用于时间戳对齐的 token 索引。
  const batchText = new SubtitleData(batchWordSegments).toText();

  // LLM 断句
  const llmSentences = await splitByLLM(batchText, client, config, batchIndex, signal);

  // 时间戳对齐：在当前批次的单词片段中匹配（使用旧的相似度匹配方式）
  const alignedSegments = mergeSegmentsBasedOnSentences(
    batchWordSegments,
    llmSentences
  );

  return new SubtitleData(alignedSegments);
}


/**
 * 按时间间隔分组片段
 */
function groupSegmentsByTimeGaps(segments: SubtitleEntry[], maxGap: number = MAX_GAP): SubtitleEntry[][] {
  if (segments.length === 0) return [];

  const groups: SubtitleEntry[][] = [];
  let currentGroup: SubtitleEntry[] = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].startTime - segments[i - 1].endTime;
    if (gap > maxGap) {
      // 间隔过大，开始新组
      groups.push(currentGroup);
      currentGroup = [segments[i]];
    } else {
      currentGroup.push(segments[i]);
    }
  }

  // 添加最后一组
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function normalizeComparableToken(token: string): string {
  return token.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizeComparableText(text: string): string[] {
  return text
    .replace(TOKEN_BOUNDARY_PUNCTUATION, ' $1 ')
    .split(/\s+/)
    .map(normalizeComparableToken)
    .filter(token => token.length > 0);
}

function appendSourceGroups(
  output: SubtitleEntry[],
  sourceSegments: SubtitleEntry[]
): void {
  for (const group of groupSegmentsByTimeGaps(sourceSegments, MAX_GAP)) {
    const text = new SubtitleData(group).toText();
    if (!text) continue;

    output.push({
      index: output.length + 1,
      startTime: group[0].startTime,
      endTime: group[group.length - 1].endTime,
      text,
    });
  }
}

/**
 * 按断句结果的 token 数顺序消费源片段。源片段是唯一文本来源：LLM 只
 * 决定边界，不能改写英文；每个源片段也只会被消费一次。
 */
function mergeSegmentsBasedOnSentences(
  segments: SubtitleEntry[],
  sentences: string[]
): SubtitleEntry[] {
  const newSegments: SubtitleEntry[] = [];
  const sourceTokenCounts = segments.map(segment =>
    Math.max(1, tokenizeComparableText(segment.text).length)
  );
  let sourceSegmentIndex = 0;
  let consumedSourceTokens = 0;
  let targetTokenCount = 0;

  logger.info(`🔗 开始顺序时间戳对齐: ${sentences.length} 个句子 -> ${segments.length} 个原始片段`);

  sentences.forEach((sentence, sentenceIndex) => {
    targetTokenCount += tokenizeComparableText(sentence).length;
    let endIndex = sourceSegmentIndex;

    while (
      endIndex < segments.length
      && (consumedSourceTokens < targetTokenCount || endIndex === sourceSegmentIndex)
    ) {
      consumedSourceTokens += sourceTokenCounts[endIndex];
      endIndex++;
    }

    // 最后一句兜底消费批次剩余内容，避免舍弃尾部 token。
    if (sentenceIndex === sentences.length - 1) {
      endIndex = segments.length;
    }

    if (endIndex > sourceSegmentIndex) {
      appendSourceGroups(newSegments, segments.slice(sourceSegmentIndex, endIndex));
      sourceSegmentIndex = endIndex;
    }
  });

  if (sourceSegmentIndex < segments.length) {
    appendSourceGroups(newSegments, segments.slice(sourceSegmentIndex));
  }

  logger.info(`✅ 时间戳对齐完成: ${newSegments.length} 个字幕片段`);
  return newSegments;
}

/**
 * 统计文本中的单词数
 */
export function countWords(text: string): number {
  // 移除非英文字符后统计单词数
  const englishText = text.replace(/[\u4e00-\u9fff]/g, ' ');
  const words = englishText.trim().split(/\s+/).filter(w => w.length > 0);
  return words.length;
}

/**
 * 按明确的句子结束标记拆分句子
 */
export function splitByEndMarks(sentence: string): string[] {
  const positions: number[] = [];

  const nearestNonWhitespace = (start: number, direction: -1 | 1): string => {
    for (let i = start; i >= 0 && i < sentence.length; i += direction) {
      if (!/\s/.test(sentence[i])) return sentence[i];
    }
    return '';
  };

  for (let i = 0; i < sentence.length; i++) {
    const mark = sentence[i];
    if (mark !== '.' && mark !== '!' && mark !== '?') continue;

    if (mark === '.') {
      const previous = nearestNonWhitespace(i - 1, -1);
      const next = nearestNonWhitespace(i + 1, 1);
      if (/\d/.test(previous) && /\d/.test(next)) continue;
    }

    let end = i + 1;
    while (end < sentence.length && /\s/.test(sentence[end])) end++;
    positions.push(end);
  }

  // 如果没有找到结束标记，返回原句子
  if (positions.length === 0) {
    return [sentence];
  }

  // 去重并排序
  const uniquePositions = Array.from(new Set(positions)).sort((a, b) => a - b);

  // 执行分割
  const segments: string[] = [];
  let start = 0;

  for (const pos of uniquePositions) {
    const segment = sentence.slice(start, pos).trim();
    // 确保每段至少有3个单词才分割
    if (segment && countWords(segment) >= 3) {
      segments.push(segment);
      start = pos;
    }
  }

  // 处理最后一段
  const lastSegment = sentence.slice(start).trim();
  if (lastSegment) {
    if (segments.length > 0 && countWords(lastSegment) < 2) {
      // 最后一段太短，合并到前一段
      segments[segments.length - 1] += ' ' + lastSegment;
    } else {
      segments.push(lastSegment);
    }
  }

  return segments.length > 1 ? segments : [sentence];
}

/**
 * 智能断句 - 多层阈值保护机制
 */
export function aggressiveSplit(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/);
  const wordCount = words.length;

  // 如果已经满足要求，直接返回
  if (wordCount <= maxWords) {
    return [text];
  }

  logger.info(`🔧 尝试智能分割: ${wordCount}字 -> 目标≤${maxWords}字`);

  // 策略1: 规则匹配分割（6层优先级）
  const splitCandidates: Array<[number, number, string]> = [];

  // 优先级1: 句子结束标记
  for (let i = 2; i < wordCount - 2; i++) {
    const word = words[i].replace(/[,;:]$/, '');
    if (word.endsWith('.') || word.endsWith('!') || word.endsWith('?')) {
      splitCandidates.push([i + 1, 10, `句号'${word.slice(-1)}'`]);
    }
  }

  // 优先级2: 分号/冒号
  for (let i = 2; i < wordCount - 2; i++) {
    const word = words[i];
    if (word.endsWith(';') || word.endsWith(':')) {
      splitCandidates.push([i + 1, 9, `分隔'${word.slice(-1)}'`]);
    }
  }

  // 优先级3: 逗号
  for (let i = 2; i < wordCount - 2; i++) {
    const word = words[i];
    if (word.endsWith(',')) {
      splitCandidates.push([i + 1, 8, '逗号']);
    }
  }

  // 优先级4: 并列连词
  const coordinatingConj = ['and', 'but', 'or', 'so', 'yet', 'nor'];
  for (let i = 3; i < wordCount - 2; i++) {
    const word = words[i].toLowerCase().replace(/[,.!?]/g, '');
    if (coordinatingConj.includes(word)) {
      splitCandidates.push([i, 7, `并列连词'${word}'`]);
    }
  }

  // 优先级5: 从属连词
  const subordinatingConj = ['because', 'although', 'though', 'unless', 'since',
    'while', 'whereas', 'if', 'when', 'before', 'after'];
  for (let i = 3; i < wordCount - 2; i++) {
    const word = words[i].toLowerCase().replace(/[,.!?]/g, '');
    if (subordinatingConj.includes(word)) {
      splitCandidates.push([i, 6, `从属连词'${word}'`]);
    }
  }

  // 优先级6: 关系代词
  const relativePronouns = ['that', 'which', 'who', 'whom', 'whose', 'where', 'when', 'whether'];
  for (let i = 3; i < wordCount - 2; i++) {
    const word = words[i].toLowerCase().replace(/[,.!?]/g, '');
    if (relativePronouns.includes(word)) {
      splitCandidates.push([i, 5, `关系词'${word}'`]);
    }
  }

  // 如果找到候选点，选择最优的
  if (splitCandidates.length > 0) {
    // 按优先级排序，同优先级选择最接近中点的
    const midPoint = Math.floor(wordCount / 2);
    splitCandidates.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // 优先级高的在前
      return Math.abs(a[0] - midPoint) - Math.abs(b[0] - midPoint); // 更接近中点的在前
    });

    const [bestPos, priority, reason] = splitCandidates[0];

    // 执行分割
    const firstPart = words.slice(0, bestPos).join(' ').trim();
    const secondPart = words.slice(bestPos).join(' ').trim();

    logger.info(`✅ [策略1] 规则匹配分割在${reason}处 (优先级${priority}):`);
    logger.info(`   片段1(${countWords(firstPart)}字): ${firstPart.slice(0, 50)}...`);
    logger.info(`   片段2(${countWords(secondPart)}字): ${secondPart.slice(0, 50)}...`);

    // 递归处理仍然超长的片段
    const result: string[] = [];
    const warningThreshold = Math.floor(maxWords * 1.5);

    for (const part of [firstPart, secondPart]) {
      if (countWords(part) > warningThreshold) {
        result.push(...aggressiveSplit(part, maxWords));
      } else {
        result.push(part);
      }
    }

    return result;
  }

  return [text];
}

/**
 * 降级分割（兜底方案）：在理想切分点附近寻找语义边界
 */
export function fallbackSplit(text: string, maxWords: number, warningThreshold?: number): string[] {
  if (warningThreshold === undefined) {
    warningThreshold = Math.floor(maxWords * 1.5);
  }

  const words = text.split(/\s+/);
  const wordCount = words.length;

  // 计算需要分成几段
  const numSegments = Math.ceil(wordCount / maxWords);

  if (numSegments === 1) {
    return [text];
  }

  logger.info(`🔨 降级分割: ${wordCount}字 -> ${numSegments}段 (每段≤${maxWords}字)`);

  // 计算理想分割点
  const segmentSize = wordCount / numSegments;
  const idealPoints: number[] = [];
  for (let i = 1; i < numSegments; i++) {
    idealPoints.push(Math.floor(segmentSize * i));
  }

  // 在每个理想点附近寻找最佳分割位置
  const actualSplits: number[] = [];
  const searchRange = 5;

  for (const idealPos of idealPoints) {
    let bestPos = idealPos;
    let bestScore = 0;

    const start = Math.max(1, idealPos - searchRange);
    const end = Math.min(wordCount - 1, idealPos + searchRange);

    for (let i = start; i <= end; i++) {
      let score = 0;
      const word = words[i - 1].replace(/[,;:]$/, '');

      // 评分：标点优于连接词优于普通位置
      if (word.endsWith('.') || word.endsWith('!') || word.endsWith('?')) {
        score = 10;
      } else if (word.endsWith(',') || word.endsWith(';') || word.endsWith(':')) {
        score = 8;
      } else if (i < wordCount && ['and', 'but', 'or', 'so', 'because', 'when', 'while']
        .includes(words[i].toLowerCase())) {
        score = 6;
      } else {
        score = 1;
      }

      // 同等分数下，优先选择更接近理想点的
      if (score > bestScore || (score === bestScore && Math.abs(i - idealPos) < Math.abs(bestPos - idealPos))) {
        bestScore = score;
        bestPos = i;
      }
    }

    actualSplits.push(bestPos);
  }

  // 执行分割
  const result: string[] = [];
  let startIdx = 0;

  for (const splitPos of actualSplits) {
    const segment = words.slice(startIdx, splitPos).join(' ').trim();
    if (segment) {
      result.push(segment);
    }
    startIdx = splitPos;
  }

  // 添加最后一段
  const lastSegment = words.slice(startIdx).join(' ').trim();
  if (lastSegment) {
    result.push(lastSegment);
  }

  // 输出分割结果
  logger.info(`✅ 降级分割完成: ${result.length}段`);
  for (let i = 0; i < result.length; i++) {
    const segWords = countWords(result[i]);
    logger.info(`   片段${i + 1}(${segWords}字): ${result[i].slice(0, 50)}...`);
  }

  // 验证：如果仍有超标片段，递归处理
  const finalResult: string[] = [];
  for (const segment of result) {
    if (countWords(segment) > warningThreshold) {
      // 简单二分
      const segWords = segment.split(/\s+/);
      const mid = Math.floor(segWords.length / 2);
      finalResult.push(segWords.slice(0, mid).join(' '));
      finalResult.push(segWords.slice(mid).join(' '));
    } else {
      finalResult.push(segment);
    }
  }

  return finalResult;
}

/**
 * OpenAI API 客户端接口
 */
interface OpenAIClient {
  callChat(systemPrompt: string, userPrompt: string, options?: {
    temperature?: number;
    timeout?: number;
    signal?: CancellationSignal;
  }): Promise<string>;
}

/**
 * 使用 LLM 进行断句
 * @param text 要拆分的文本
 * @param client OpenAI 客户端
 * @param config 配置
 * @param batchIndex 批次索引（用于日志）
 */
export async function splitByLLM(
  text: string,
  client: OpenAIClient,
  config: TranslatorConfig,
  batchIndex?: number,
  signal?: CancellationSignal
): Promise<string[]> {
  const { maxWordCountEnglish, toleranceMultiplier, warningMultiplier, maxMultiplier } = config;

  // 构建 Prompt
  const systemPrompt = buildSplitPrompt({ maxWordCountEnglish });
  const userPrompt = `Please use multiple <br> tags to separate the following sentence. Make sure to preserve all spaces and punctuation exactly as they appear in the original text:\n${text}`;

  // 记录开始时间
  const startTime = Date.now();

  // 调用 API
  const response = await client.callChat(systemPrompt, userPrompt, {
    temperature: 0.2,
    timeout: 80000,
    signal,
  });

  // 记录耗时
  const duration = Date.now() - startTime;

  if (!response) {
    throw new Error('API 返回为空');
  }

  const batchPrefix = batchIndex !== undefined ? `[批次${batchIndex}] ` : '';
  logger.info(`${batchPrefix}API 返回结果: \n\n${response}\n`);

  // 清理响应并兼容 <br>、<br/>、大小写和普通换行。普通换行必须
  // 变成空格，不能把 Hello\nworld 粘成 Helloworld。
  const result = response.replace(/<think>[\s\S]*?<\/think>/gi, '');
  let sentences = result
    .split(/<br\s*\/?>/i)
    .map(segment => segment.replace(/\s+/g, ' ').trim())
    .filter(segment => segment.length > 0);

  const normalizeIntegrityText = (value: string): string =>
    value.replace(/\s+/g, ' ').trim();
  if (normalizeIntegrityText(sentences.join(' ')) !== normalizeIntegrityText(text)) {
    sentences = [text];
  }

  // 计算动态阈值
  const toleranceThreshold = Math.floor(maxWordCountEnglish * toleranceMultiplier);
  const warningThreshold = Math.floor(maxWordCountEnglish * warningMultiplier);
  const maxThreshold = Math.floor(maxWordCountEnglish * maxMultiplier);

  // 5 层防护机制
  const newSentences: string[] = [];
  const stats: SplitStats = {
    normal: 0,
    tolerated: 0,
    optimized: 0,
    forced: 0,
    rejected: 0,
  };

  for (const sentence of sentences) {
    // 首先按结束标记拆分句子
    const segments = splitByEndMarks(sentence);

    for (const segment of segments) {
      const wordCount = countWords(segment);

      // 层级1：正常范围 (≤ target)
      if (wordCount <= maxWordCountEnglish) {
        newSentences.push(segment);
        stats.normal++;
      }
      // 层级2：轻度容忍层 (target < x ≤ tolerance)
      else if (wordCount <= toleranceThreshold) {
        newSentences.push(segment);
        stats.tolerated++;
        logger.info(`✓ 轻度超标(${wordCount}/${maxWordCountEnglish}字): ${segment.slice(0, 40)}...`);
      }
      // 层级3：强制优化层 (tolerance < x ≤ warning)
      else if (wordCount <= warningThreshold) {
        logger.info(`🔧 尝试优化(${wordCount}/${maxWordCountEnglish}字): ${segment.slice(0, 40)}...`);
        const splitResults = aggressiveSplit(segment, maxWordCountEnglish);

        if (splitResults.length > 1) {
          stats.optimized++;
          logger.info(`✅ 优化成功: 分为${splitResults.length}段`);
          newSentences.push(...splitResults);
        } else {
          stats.tolerated++;
          newSentences.push(segment);
        }
      }
      // 层级4：智能拆分层 (warning < x ≤ max)
      else if (wordCount <= maxThreshold) {
        logger.info(`🔧 尝试智能分割...`);
        const splitResults = aggressiveSplit(segment, maxWordCountEnglish);

        if (splitResults.length > 1) {
          stats.optimized++;
          logger.info(`✅ 智能分割成功: 分为${splitResults.length}段`);
          newSentences.push(...splitResults);
        } else {
          const fallbackResults = fallbackSplit(segment, maxWordCountEnglish, warningThreshold);
          stats.forced++;
          newSentences.push(...fallbackResults);
        }
      }
      // 层级5：严重超标层 (> max)
      else {
        logger.info(`🔧 尝试智能分割...`);
        const splitResults = aggressiveSplit(segment, maxWordCountEnglish);

        if (splitResults.length > 1) {
          stats.optimized++;
          logger.info(`✅ 智能分割成功: 分为${splitResults.length}段`);
          newSentences.push(...splitResults);
        } else {
          const fallbackResults = fallbackSplit(segment, maxWordCountEnglish, warningThreshold);
          stats.rejected++;
          newSentences.push(...fallbackResults);
        }
      }
    }
  }

  sentences = newSentences;
  if (normalizeIntegrityText(sentences.join(' ')) !== normalizeIntegrityText(text)) {
    sentences = [text];
  }

  // 记录统计信息
  logger.info(`📊 断句质量统计:`);
  logger.info(`   ✅ 正常: ${stats.normal}句 (≤${maxWordCountEnglish}字)`);
  if (stats.tolerated > 0) {
    logger.info(`   ✓ 轻度超标: ${stats.tolerated}句 (${maxWordCountEnglish}-${toleranceThreshold}字)`);
  }
  if (stats.optimized > 0) {
    logger.info(`   🔧 优化拆分: ${stats.optimized}句 (${toleranceThreshold}-${warningThreshold}字)`);
  }
  logger.info(`✅ ${batchPrefix}断句完成: ${sentences.length} 个句子，耗时 ${(duration / 1000).toFixed(1)}s`);

  return sentences;
}
