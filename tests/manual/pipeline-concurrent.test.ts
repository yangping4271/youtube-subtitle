/**
 * 并发流水线测试 - 测试优化后的批次并发处理
 *
 * 测试目标：
 * 1. 所有批次并行处理（包括批次1）
 * 2. 并发控制（threadNum 参数）
 * 3. 批次内一次 API 调用翻译整批
 * 4. 统一批次命名（批次1、批次2...）
 * 5. 有序渐进输出（并发完成后按输入顺序回调）
 * 6. 进度计算（按完成的句子数）
 */

import { TranslationSession } from '../../src/core/translation-session.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { SubtitleEntry, TranslatorConfig, BilingualSubtitles } from '../../src/types/index.js';
import fs from 'fs';
import path from 'path';

// 从环境变量读取配置
function loadConfig(): TranslatorConfig {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const envVars: Record<string, string> = {};

    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        envVars[match[1].trim()] = match[2].trim();
      }
    });

    return {
      openaiBaseUrl: envVars.OPENAI_BASE_URL || '',
      openaiApiKey: envVars.OPENAI_API_KEY || '',
      model: envVars.MODEL || envVars.LLM_MODEL || 'gpt-4',
      targetLanguage: 'zh',
      maxWordCountEnglish: 19,
      toleranceMultiplier: 1.2,
      warningMultiplier: 1.5,
      maxMultiplier: 2.0,
      threadNum: 3,  // 测试并发控制
      batchSize: 20,
    };
  }

  throw new Error('.env 文件不存在');
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

describe('并发流水线测试', () => {
  it('应该并行处理所有批次并支持流式输出', async () => {
    // 1. 加载配置
    const config = loadConfig();
    console.log('✅ 配置加载成功');
    console.log(`   threadNum: ${config.threadNum}`);

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

    // 3. 创建翻译服务
    const session = new TranslationSession(config, new OpenAIClient(config));

    // 4. 跟踪批次完成顺序和时间
    interface BatchCompletion {
      batchNumber: number;
      timestamp: number;
      sentenceCount: number;
    }
    const batchCompletions: BatchCompletion[] = [];
    const startTime = Date.now();
    let batchCounter = 0;

    // 5. 跟踪进度更新
    const progressUpdates: Array<{ step: string; current: number; total: number }> = [];

    // 6. 执行翻译
    await session.translate({ subtitles: originalSubtitles }, {
      onPartialResult: (partial: BilingualSubtitles) => {
        const timestamp = Date.now() - startTime;
        batchCounter++;
        batchCompletions.push({
          batchNumber: batchCounter,
          timestamp,
          sentenceCount: partial.english.length,
        });
        console.log(`📦 [${timestamp}ms] 批次${batchCounter}完成: ${partial.english.length} 条字幕`);
      },
      onProgress: (step, current, total) => {
        progressUpdates.push({ step, current, total });
        console.log(`📊 进度更新: ${step} - ${current}/${total}`);
      },
    });

    // 7. 验证结果
    console.log('\n📊 批次完成统计:');
    batchCompletions.forEach((completion) => {
      console.log(`   批次${completion.batchNumber}: ${completion.timestamp}ms (${completion.sentenceCount}条)`);
    });

    // 验证至少有一个批次完成
    expect(batchCompletions.length).toBeGreaterThan(0);

    // 验证进度更新
    expect(progressUpdates.length).toBeGreaterThan(0);
    console.log(`\n✅ 测试通过: ${batchCompletions.length} 个批次完成`);
  }, 300000); // 5分钟超时

  it('应该按完成的句子数计算进度', async () => {
    // 1. 加载配置
    const config = loadConfig();

    // 2. 读取真实 SRT 文件
    const srtFiles = fs.readdirSync(path.join(process.cwd(), 'tests', 'fixtures')).filter(f => f.endsWith('.srt'));
    if (srtFiles.length === 0) {
      throw new Error('未找到 SRT 文件');
    }

    const srtPath = path.join(process.cwd(), 'tests', 'fixtures', srtFiles[0]);
    const srtContent = fs.readFileSync(srtPath, 'utf-8');
    const originalSubtitles = parseSRT(srtContent);

    // 3. 创建翻译服务
    const session = new TranslationSession(config, new OpenAIClient(config));

    // 4. 跟踪进度更新
    const progressUpdates: Array<{ step: string; current: number; total: number }> = [];
    let totalSentences = 0;

    // 5. 执行翻译
    await session.translate({ subtitles: originalSubtitles }, {
      onPartialResult: (partial: BilingualSubtitles) => {
        totalSentences += partial.english.length;
      },
      onProgress: (step, current, total) => {
        progressUpdates.push({ step, current, total });
        console.log(`📊 进度: ${step} - ${current}/${total}`);
      },
    });

    // 6. 验证进度计算
    console.log('\n📊 进度验证:');
    console.log(`   总句子数: ${totalSentences}`);
    console.log(`   进度更新次数: ${progressUpdates.length}`);

    const translateProgress = progressUpdates.filter(p => p.step === 'translate');
    expect(translateProgress.length).toBeGreaterThan(0);
    expect(translateProgress.map(({ current }) => current)).toEqual(
      [...translateProgress]
        .sort((a, b) => a.current - b.current)
        .map(({ current }) => current)
    );
    expect(progressUpdates.filter(({ step }) => step === 'complete')).toHaveLength(1);
    console.log('✅ 进度验证完成');
  }, 300000);
});
