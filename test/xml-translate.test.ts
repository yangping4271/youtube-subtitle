/**
 * 集成测试 - 验证 XML 格式翻译
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config as loadDotenv } from 'dotenv';
import { TranslatorService } from '../src/services/translator-service.js';
import type { SubtitleEntry, TranslatorConfig } from '../src/types/index.js';

loadDotenv();

function loadConfig(): TranslatorConfig {
  return {
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    splitModel: process.env.SPLIT_MODEL || 'gpt-4o-mini',
    translationModel: process.env.TRANSLATION_MODEL || 'gpt-4o',
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: 3,
    batchSize: 20,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
  };
}

function parseSRT(content: string): SubtitleEntry[] {
  const lines = content.trim().split('\n');
  const subtitles: SubtitleEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const index = parseInt(lines[i].trim());
    i++;
    const timeLine = lines[i].trim();
    const [startStr, endStr] = timeLine.split(' --> ');
    i++;
    let text = '';
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^\d+$/)) {
      text += (text ? ' ' : '') + lines[i].trim();
      i++;
    }
    const parseTime = (ts: string): number => {
      const [h, m, s] = ts.split(':');
      const [sec, ms] = s.split(',');
      return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(sec) * 1000 + parseInt(ms);
    };
    subtitles.push({ index, startTime: parseTime(startStr), endTime: parseTime(endStr), text });
  }
  return subtitles;
}

describe('XML 格式翻译集成测试', () => {
  it('应该用 XML 格式正确翻译 srt 字幕', async () => {
    const config = loadConfig();
    if (!config.openaiApiKey) {
      console.log('⚠️ API 密钥未配置，跳过测试');
      return;
    }

    const srtPath = join(process.cwd(), 'Learn tRPC in 5 minutes - Matt Pocock_S6rcrkbsDI0.srt');
    const srtContent = readFileSync(srtPath, 'utf-8');
    const subtitles = parseSRT(srtContent);

    console.log(`加载了 ${subtitles.length} 条字幕`);

    const service = new TranslatorService(config);
    let totalReceived = 0;

    await service.translateFull(subtitles.slice(0, 20), {
      firstBatchSize: 10,
      onPartialResult: (partial, isFirst) => {
        totalReceived += partial.english.length;
        console.log(`${isFirst ? '首批' : '批次'} 完成: ${partial.english.length} 条 (累计: ${totalReceived})`);

        // 验证英文字幕不为空
        for (const e of partial.english) {
          expect(e.text).toBeTruthy();
        }
        // 验证中文翻译不为空且不含 [翻译失败]
        for (const c of partial.chinese) {
          expect(c.text).toBeTruthy();
          expect(c.text).not.toContain('[翻译失败]');
        }

        // 打印前3条对照
        const count = Math.min(3, partial.english.length);
        for (let i = 0; i < count; i++) {
          console.log(`  EN: ${partial.english[i].text}`);
          console.log(`  ZH: ${partial.chinese[i].text}\n`);
        }
      },
    });

    expect(totalReceived).toBeGreaterThan(0);
    console.log(`翻译完成，共 ${totalReceived} 条`);
  }, 300000);
});
