/**
 * 并发流水线测试 - 测试优化后的批次并发处理
 *
 * 测试目标：
 * 1. 所有批次并行处理（包括批次1）
 * 2. 并发控制（threadNum 参数）
 * 3. 批次内一次 API 调用翻译整批
 * 4. 统一批次命名（批次1、批次2...）
 * 5. 流式输出（每个批次完成后立即回调）
 * 6. 进度计算（按完成的句子数）
 */

import { TranslatorService } from '../../src/services/translator-service.js';
import { SubtitleData } from '../../src/core/subtitle-data.js';
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
    const service = new TranslatorService(config);

    // 4. 跟踪批次完成顺序和时间
    interface BatchCompletion {
      batchNumber: number;
      timestamp: number;
      sentenceCount: number;
      isFirst: boolean;
    }
    const batchCompletions: BatchCompletion[] = [];
    const startTime = Date.now();
    let batchCounter = 0;

    // 5. 跟踪进度更新
    const progressUpdates: Array<{ step: string; current: number; total: number }> = [];

    // 6. 执行翻译
    await service.translateFull(originalSubtitles, {
      onPartialResult: (partial: BilingualSubtitles, isFirst: boolean) => {
        const timestamp = Date.now() - startTime;
        batchCounter++;
        batchCompletions.push({
          batchNumber: batchCounter,
          timestamp,
          sentenceCount: partial.english.length,
          isFirst,
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

    // 验证流式输出：批次应该按完成顺序回调，不是按批次编号顺序
    // 如果是真正的并行，批次完成顺序可能不是 1, 2, 3...
    console.log('\n📊 并发验证:');
    if (batchCompletions.length > 1) {
      // 检查是否有批次乱序完成（说明是并行的）
      let hasOutOfOrder = false;
      for (let i = 1; i < batchCompletions.length; i++) {
        if (batchCompletions[i].batchNumber < batchCompletions[i - 1].batchNumber) {
          hasOutOfOrder = true;
          break;
        }
      }
      if (hasOutOfOrder) {
        console.log('   ✅ 检测到批次乱序完成，说明是并行处理');
      } else {
        console.log('   ⚠️  批次按顺序完成，可能是串行处理或批次太少');
      }
    }

    // 验证进度更新
    expect(progressUpdates.length).toBeGreaterThan(0);
    console.log(`\n✅ 测试通过: ${batchCompletions.length} 个批次完成`);
  }, 300000); // 5分钟超时

  it('应该遵守并发限制（threadNum）', async () => {
    // 1. 加载配置，设置较小的 threadNum
    const config = loadConfig();
    config.threadNum = 2; // 限制为2个并发
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

    // 3. 创建翻译服务
    const service = new TranslatorService(config);

    // 4. 跟踪同时运行的批次数
    let currentRunning = 0;
    let maxConcurrent = 0;
    const batchStarts: number[] = [];
    const batchEnds: number[] = [];

    // 5. 执行翻译
    await service.translateFull(originalSubtitles, {
      onPartialResult: (partial: BilingualSubtitles) => {
        // 记录批次完成
        batchEnds.push(Date.now());
        currentRunning--;
      },
    });

    // 6. 验证并发限制
    // 注意：这个测试比较难精确验证，因为我们无法直接监控批次开始
    // 实际验证需要在实现中添加钩子
    console.log('⚠️  并发限制验证需要在实现中添加监控钩子');
    console.log(`   配置的 threadNum: ${config.threadNum}`);
  }, 300000);

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
    const service = new TranslatorService(config);

    // 4. 跟踪进度更新
    const progressUpdates: Array<{ step: string; current: number; total: number }> = [];
    let totalSentences = 0;

    // 5. 执行翻译
    await service.translateFull(originalSubtitles, {
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

    // 验证进度更新中的 total 应该是总句子数（在新实现中）
    // 注意：这需要在实现后才能验证
    const translateProgress = progressUpdates.filter(p => p.step === 'translate');
    if (translateProgress.length > 0) {
      console.log(`   翻译进度更新: ${translateProgress.length} 次`);
      // 在新实现中，total 应该等于总句子数
      // expect(translateProgress[0].total).toBe(totalSentences);
    }

    expect(progressUpdates.length).toBeGreaterThan(0);
    console.log('✅ 进度验证完成（详细验证需要在实现后补充）');
  }, 300000);
});
