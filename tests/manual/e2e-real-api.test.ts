/**
 * 端到端测试 - 使用真实 API 和真实 SRT 文件
 */

import { SubtitleData } from '../../src/core/subtitle-data.js';
import { presplitByPunctuation, batchBySentenceCount, mergeSegmentsWithinBatch } from '../../src/core/splitter.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { SubtitleEntry, TranslatorConfig } from '../../src/types/index.js';
import { config as loadDotenv } from 'dotenv';
import fs from 'fs';
import path from 'path';

loadDotenv();

// 从环境变量读取配置
function loadConfig(): TranslatorConfig {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY 未设置，请检查 .env 文件');
  }

  return {
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    openaiApiKey: process.env.OPENAI_API_KEY,
    splitModel: process.env.SPLIT_MODEL || 'gpt-4',
    translationModel: process.env.TRANSLATION_MODEL || 'gpt-4',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
    threadNum: 1,
    batchSize: 20,
  };
}

// 解析 SRT 文件
function parseSRT(content: string): SubtitleEntry[] {
  const lines = content.split('\n');
  const subtitles: SubtitleEntry[] = [];
  let current: Partial<SubtitleEntry> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^\d+$/.test(line)) {
      current.index = parseInt(line);
    } else if (line.includes('-->')) {
      const [start, end] = line.split('-->').map(s => s.trim());
      const parseTime = (t: string) => {
        const [h, m, s] = t.replace(',', '.').split(':');
        return (parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000;
      };
      current.startTime = parseTime(start);
      current.endTime = parseTime(end);
    } else if (current.index) {
      current.text = line;
      subtitles.push(current as SubtitleEntry);
      current = {};
    }
  }

  return subtitles;
}

describe('端到端测试 - 真实 API', () => {
  it('应该完整处理真实 SRT 文件的前5个预分句', async () => {
    // 1. 加载配置
    const config = loadConfig();
    console.log('✅ 配置加载成功');

    // 2. 读取真实 SRT 文件
    const srtFiles = fs.readdirSync(path.join(process.cwd(), 'tests', 'fixtures')).filter(f => f.endsWith('.srt'));
    if (srtFiles.length === 0) {
      throw new Error('未找到 SRT 文件');
    }

    const srtPath = path.join(process.cwd(), 'tests', 'fixtures', srtFiles[0]);
    const srtContent = fs.readFileSync(srtPath, 'utf-8');
    const originalSubtitles = parseSRT(srtContent);
    console.log(`✅ 读取 SRT 文件: ${srtFiles[0]}`);
    console.log(`   原始字幕数: ${originalSubtitles.length}`);

    // 3. 转换为单词级
    const subtitleData = new SubtitleData(originalSubtitles);
    const wordSegments = subtitleData.splitToWordSegments();
    const words = wordSegments.getSegments();
    console.log(`✅ 转换为单词级: ${words.length} 个单词`);

    // 4. 预分句
    const preSplitSentences = presplitByPunctuation(words);
    console.log(`✅ 预分句完成: ${preSplitSentences.length} 个句子`);

    // 5. 分批
    const batches = batchBySentenceCount(preSplitSentences, 150, 500);
    console.log(`✅ 分批完成: ${batches.length} 批`);
    console.log(`   首批句子数: ${batches[0].length}`);

    // 6. 创建 OpenAI 客户端
    const client = new OpenAIClient(config, 'split');
    console.log('✅ OpenAI 客户端创建成功');

    // 7. 处理首批（只测试首批以节省 API 调用）
    const firstBatch = batches[0];
    console.log(`\n🔄 开始处理首批 ${firstBatch.length} 个句子...`);

    const result = await mergeSegmentsWithinBatch(
      firstBatch,
      words,
      client,
      config
      // 不传 batchIndex，测试首批场景
    );

    const segments = result.getSegments();
    console.log(`✅ 处理完成: ${segments.length} 个字幕片段`);

    // 8. 验证结果
    expect(segments.length).toBeGreaterThan(0);
    console.log('\n📊 结果验证:');
    console.log(`   输入: ${firstBatch.length} 个预分句`);
    console.log(`   输出: ${segments.length} 个优化后的句子`);

    // 验证每个片段都有有效的时间戳
    for (const segment of segments) {
      expect(segment.startTime).toBeGreaterThanOrEqual(0);
      expect(segment.endTime).toBeGreaterThan(segment.startTime);
      expect(segment.text).toBeTruthy();
    }

    // 输出前3个结果
    console.log('\n📝 前3个结果:');
    segments.slice(0, 3).forEach((seg, i) => {
      console.log(`   ${i + 1}. [${(seg.startTime / 1000).toFixed(1)}s - ${(seg.endTime / 1000).toFixed(1)}s]`);
      console.log(`      ${seg.text}`);
    });

    console.log('\n✅ 端到端测试通过！');
  });

  it('应该完整处理包括翻译的完整流水线', async () => {
    // 1. 加载配置
    const config = loadConfig();
    console.log('✅ 配置加载成功');

    // 2. 读取真实 SRT 文件
    const srtFiles = fs.readdirSync(path.join(process.cwd(), 'tests', 'fixtures')).filter(f => f.endsWith('.srt'));
    if (srtFiles.length === 0) {
      throw new Error('未找到 SRT 文件');
    }

    const srtPath = path.join(process.cwd(), 'tests', 'fixtures', srtFiles[0]);
    const srtContent = fs.readFileSync(srtPath, 'utf-8');
    const originalSubtitles = parseSRT(srtContent);
    console.log(`✅ 读取 SRT 文件: ${srtFiles[0]}`);

    // 3. 转换为单词级
    const subtitleData = new SubtitleData(originalSubtitles);
    const wordSegments = subtitleData.splitToWordSegments();
    const words = wordSegments.getSegments();
    console.log(`✅ 转换为单词级: ${words.length} 个单词`);

    // 4. 预分句
    const preSplitSentences = presplitByPunctuation(words);
    console.log(`✅ 预分句完成: ${preSplitSentences.length} 个句子`);

    // 5. 分批
    const batches = batchBySentenceCount(preSplitSentences, 150, 500);
    console.log(`✅ 分批完成: ${batches.length} 批`);

    // 6. 创建客户端
    const splitClient = new OpenAIClient(config, 'split');
    const translationClient = new OpenAIClient(config, 'translation');
    console.log('✅ OpenAI 客户端创建成功');

    // 7. 处理首批：断句 + 时间戳对齐
    const firstBatch = batches[0];
    console.log(`\n🔄 步骤1: 断句和时间戳对齐 (${firstBatch.length} 个预分句)...`);

    const splitResult = await mergeSegmentsWithinBatch(
      firstBatch,
      words,
      splitClient,
      config
    );

    const segments = splitResult.getSegments();
    console.log(`✅ 断句完成: ${segments.length} 个句子`);

    // 8. 翻译
    console.log(`\n🔄 步骤2: 翻译 ${segments.length} 个句子...`);

    const translatedSegments: SubtitleEntry[] = [];
    for (const segment of segments) {
      const systemPrompt = `You are a professional translator. Translate the following English subtitle to ${config.targetLanguage}. Only return the translation, no explanations.`;
      const userPrompt = segment.text;

      const translation = await translationClient.callChat(systemPrompt, userPrompt, {
        temperature: 0.3,
        timeout: 30000,
      });

      translatedSegments.push({
        ...segment,
        text: translation.trim(),
      });
    }

    console.log(`✅ 翻译完成: ${translatedSegments.length} 个字幕`);

    // 9. 验证结果
    expect(translatedSegments.length).toBe(segments.length);

    // 验证每个翻译都有内容
    for (const segment of translatedSegments) {
      expect(segment.text).toBeTruthy();
      expect(segment.text.length).toBeGreaterThan(0);
      expect(segment.startTime).toBeGreaterThanOrEqual(0);
      expect(segment.endTime).toBeGreaterThan(segment.startTime);
    }

    // 输出前3个翻译结果
    console.log('\n📝 前3个翻译结果:');
    for (let i = 0; i < Math.min(3, translatedSegments.length); i++) {
      console.log(`   ${i + 1}. [${(translatedSegments[i].startTime / 1000).toFixed(1)}s - ${(translatedSegments[i].endTime / 1000).toFixed(1)}s]`);
      console.log(`      原文: ${segments[i].text}`);
      console.log(`      译文: ${translatedSegments[i].text}`);
    }

    console.log('\n✅ 完整流水线测试通过（包括翻译）！');
  }, 180000); // 3分钟超时
});

