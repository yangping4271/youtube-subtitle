/**
 * 集成测试 - 使用真实字幕文件测试渐进式翻译
 * 需要配置 .env 文件中的 API 密钥
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TranslationSession } from '../../src/core/translation-session.js';
import { OpenAIClient } from '../../src/services/openai-client.js';
import type { BilingualSubtitles, SubtitleEntry, TranslatorConfig } from '../../src/types/index.js';

// 从 .env 文件加载配置
function loadEnvConfig(): TranslatorConfig {
  const envPath = join(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const envVars: Record<string, string> = {};

  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    }
  });

  return {
    openaiBaseUrl: envVars.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiApiKey: envVars.OPENAI_API_KEY || '',
    model: envVars.MODEL || envVars.LLM_MODEL || 'gpt-4o',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
  };
}

// 解析 SRT 文件
function parseSRT(content: string): SubtitleEntry[] {
  const lines = content.trim().split('\n');
  const subtitles: SubtitleEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    // 跳过空行
    if (!lines[i].trim()) {
      i++;
      continue;
    }

    // 读取索引
    const index = parseInt(lines[i].trim());
    i++;

    // 读取时间戳
    const timeLine = lines[i].trim();
    const [startStr, endStr] = timeLine.split(' --> ');
    i++;

    // 读取文本（可能多行）
    let text = '';
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^\d+$/)) {
      text += (text ? ' ' : '') + lines[i].trim();
      i++;
    }

    // 转换时间戳为毫秒
    const parseTime = (timeStr: string): number => {
      const [hours, minutes, seconds] = timeStr.split(':');
      const [secs, ms] = seconds.split(',');
      return (
        parseInt(hours) * 3600000 +
        parseInt(minutes) * 60000 +
        parseInt(secs) * 1000 +
        parseInt(ms)
      );
    };

    subtitles.push({
      index,
      startTime: parseTime(startStr),
      endTime: parseTime(endStr),
      text,
    });
  }

  return subtitles;
}

describe('真实字幕文件集成测试', () => {
  it('应该能够渐进式翻译真实字幕文件', async () => {
    // 读取真实字幕文件
    const srtPath = join(
      process.cwd(),
      'tests',
      'fixtures',
      'sample.srt'
    );
    const srtContent = readFileSync(srtPath, 'utf-8');
    const subtitles = parseSRT(srtContent);

    console.log(`📊 加载了 ${subtitles.length} 条字幕`);
    console.log(`📝 前3条字幕预览:`);
    subtitles.slice(0, 3).forEach(s => {
      console.log(`  ${s.index}. ${s.text}`);
    });

    // 加载配置
    const config = loadEnvConfig();
    console.log(`\n⚙️  配置信息:`);
    console.log(`  - API Base URL: ${config.openaiBaseUrl}`);
    console.log(`  - Model: ${config.model}`);
    console.log(`  - API Key: ${config.openaiApiKey ? '已配置' : '未配置'}\n`);

    if (!config.openaiApiKey) {
      console.log('⚠️  警告: API 密钥未配置，跳过测试');
      return;
    }

    const session = new TranslationSession(config, new OpenAIClient(config));

    // 记录回调结果
    const partialResults: Array<{ count: number }> = [];
    let totalReceived = 0;

    // 执行渐进式翻译
    console.log('🚀 开始渐进式翻译...\n');

    const result = await session.translate({ subtitles }, {
      onPartialResult: (partial: BilingualSubtitles) => {
        partialResults.push({
          count: partial.english.length,
        });
        totalReceived += partial.english.length;

        console.log(
          `📦 批次翻译完成: ${partial.english.length} 条 (累计: ${totalReceived}/${subtitles.length})`
        );

        // 显示第一条翻译结果
        if (partial.english.length > 0) {
          console.log(`  原文: ${partial.english[0].text}`);
          console.log(`  译文: ${partial.chinese[0].text}\n`);
        }
      },
    });

    // 验证结果
    console.log('\n✅ 翻译完成，验证结果...\n');

    // 1. 验证至少有一个按顺序观察到的批次
    expect(partialResults.length).toBeGreaterThan(0);

    // 2. 验证总数（注意：断句后的数量可能与原始字幕数量不同）
    expect(totalReceived).toBeGreaterThan(0);
    console.log(`📊 统计信息:`);
    console.log(`  - 原始字幕数: ${subtitles.length}`);
    console.log(`  - 断句后字幕数: ${totalReceived}`);
    console.log(`  - 回调次数: ${partialResults.length}`);
    console.log(`  - 第一批大小: ${partialResults[0].count}`);
    console.log(`  - 累计接收: ${totalReceived}`);

  }, 300000); // 5分钟超时
});
