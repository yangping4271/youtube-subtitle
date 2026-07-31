/**
 * 使用真实 API 跑一份本地 SRT，并保存完整日志与翻译结果。
 *
 * 示例：
 * bun run test:real-srt -- --srt "/path/to/subtitle.srt"
 */

import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { inspect } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { TranslationSession } from '../src/core/translation-session.js';
import { OpenAIClient } from '../src/services/openai-client.js';
import type {
  ApiProviderType,
  BilingualSubtitles,
  SubtitleEntry,
  TranslatorConfig,
} from '../src/types/index.js';

interface RunnerOptions {
  srtPath: string;
  envPath: string;
  outputRoot: string;
}

function readArgument(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(`--${name}`);
  if (exactIndex >= 0) {
    return process.argv[exactIndex + 1];
  }

  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

function loadOptions(): RunnerOptions {
  const srtArgument = readArgument('srt');
  if (!srtArgument) {
    throw new Error('缺少 --srt 参数，例如：bun run test:real-srt -- --srt "/path/to/file.srt"');
  }

  return {
    srtPath: resolve(srtArgument),
    envPath: resolve(
      readArgument('env') || join(homedir(), '.config', 'subtitle-translator', '.env')
    ),
    outputRoot: resolve(readArgument('output') || join(process.cwd(), 'log', 'real-srt')),
  };
}

function inferProviderType(baseUrl: string): ApiProviderType {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes('openrouter')) return 'openrouter';
  if (normalized.includes('deepseek.com')) return 'deepseek';
  if (normalized.includes('api.openai.com')) return 'openai';
  return 'custom';
}

function loadTranslatorConfig(envPath: string): TranslatorConfig {
  const result = loadDotenv({ path: envPath, quiet: true });
  if (result.error) {
    throw new Error(`无法读取环境配置: ${envPath}`);
  }

  const env = result.parsed || {};
  const openaiBaseUrl = env.OPENAI_BASE_URL?.trim() || '';
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || '';
  const model = (env.MODEL || env.LLM_MODEL)?.trim() || '';
  const threadNum = Number.parseInt(env.THREAD_NUM || '3', 10);

  const missing = [
    !openaiBaseUrl && 'OPENAI_BASE_URL',
    !openaiApiKey && 'OPENAI_API_KEY',
    !model && 'LLM_MODEL',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`环境配置缺少: ${missing.join(', ')}`);
  }

  return {
    openaiBaseUrl,
    openaiApiKey,
    model,
    providerType: inferProviderType(openaiBaseUrl),
    targetLanguage: 'zh',
    maxWordCountEnglish: 19,
    threadNum: Number.isFinite(threadNum) && threadNum > 0 ? threadNum : 3,
    batchSize: 20,
    disableThinking: true,
    toleranceMultiplier: 1.2,
    warningMultiplier: 1.5,
    maxMultiplier: 2.0,
  };
}

function parseTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    throw new Error(`无效的 SRT 时间戳: ${value}`);
  }

  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1_000 +
    Number(match[4])
  );
}

function parseSrt(content: string): SubtitleEntry[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  return normalized.split(/\n\s*\n/).map((block, position) => {
    const lines = block.split('\n');
    if (lines.length < 3) {
      throw new Error(`第 ${position + 1} 个 SRT 块格式不完整`);
    }

    const index = Number.parseInt(lines[0].trim(), 10);
    const [start, end] = lines[1].split(/\s*-->\s*/);
    if (!Number.isFinite(index) || !start || !end) {
      throw new Error(`第 ${position + 1} 个 SRT 块索引或时间轴无效`);
    }

    return {
      index,
      startTime: parseTimestamp(start),
      endTime: parseTimestamp(end),
      text: lines.slice(2).join(' ').replace(/<[^>]*>/g, '').trim(),
    };
  }).filter(subtitle => subtitle.text);
}

function formatTimestamp(milliseconds: number): string {
  const safeValue = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safeValue / 3_600_000);
  const minutes = Math.floor((safeValue % 3_600_000) / 60_000);
  const seconds = Math.floor((safeValue % 60_000) / 1_000);
  const millis = safeValue % 1_000;
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0'),
  ].join(':') + `,${millis.toString().padStart(3, '0')}`;
}

function formatSrt(
  result: BilingualSubtitles,
  bilingual: boolean
): string {
  return result.english.map((english, index) => {
    const chinese = result.chinese[index];
    const nextStartTime = result.english[index + 1]?.startTime;
    const endTime = nextStartTime !== undefined && nextStartTime > english.startTime
      ? Math.min(english.endTime, nextStartTime)
      : english.endTime;
    const text = bilingual
      ? `${english.text}\n${chinese?.text || ''}`
      : chinese?.text || '';

    return [
      index + 1,
      `${formatTimestamp(english.startTime)} --> ${formatTimestamp(endTime)}`,
      text,
    ].join('\n');
  }).join('\n\n') + '\n';
}

function countTimelineOverlaps(result: BilingualSubtitles): number {
  let overlaps = 0;
  for (let index = 1; index < result.english.length; index++) {
    if (result.english[index].startTime < result.english[index - 1].endTime) {
      overlaps++;
    }
  }
  return overlaps;
}

function createConsoleCapture(logPath: string): () => Promise<void> {
  const stream = createWriteStream(logPath, { flags: 'a' });
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const wrap = (level: 'INFO' | 'WARN' | 'ERROR', method: keyof typeof original) =>
    (...args: unknown[]): void => {
      original[method](...args);
      const message = args.map(value =>
        typeof value === 'string' ? value : inspect(value, { depth: 5, colors: false })
      ).join(' ');
      stream.write(`${new Date().toISOString()} [${level}] ${message}\n`);
    };

  console.log = wrap('INFO', 'log');
  console.warn = wrap('WARN', 'warn');
  console.error = wrap('ERROR', 'error');

  return async () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    await new Promise<void>((resolveEnd, rejectEnd) => {
      stream.once('error', rejectEnd);
      stream.end(resolveEnd);
    });
  };
}

function validateResult(result: BilingualSubtitles): void {
  if (result.english.length === 0) {
    throw new Error('流水线没有生成任何字幕');
  }
  if (result.english.length !== result.chinese.length) {
    throw new Error(
      `中英字幕数量不一致: ${result.english.length} / ${result.chinese.length}`
    );
  }

  const emptyTranslations = result.chinese.filter(item => !item.text.trim()).length;
  if (emptyTranslations > 0) {
    throw new Error(`存在 ${emptyTranslations} 条空翻译`);
  }

  const invalidTimelines = result.english.filter(
    item => item.startTime < 0 || item.endTime <= item.startTime
  ).length;
  if (invalidTimelines > 0) {
    throw new Error(`存在 ${invalidTimelines} 条无效时间轴`);
  }
}

async function main(): Promise<void> {
  const options = loadOptions();
  const inputName = parse(options.srtPath).name;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(options.outputRoot, `${inputName}-${runId}`);
  mkdirSync(outputDir, { recursive: true });

  const logPath = join(outputDir, 'run.log');
  const closeCapture = createConsoleCapture(logPath);

  try {
    const config = loadTranslatorConfig(options.envPath);
    const subtitles = parseSrt(readFileSync(options.srtPath, 'utf8'));

    console.log('真实 SRT 测试开始');
    console.log(`输入文件: ${options.srtPath}`);
    console.log(`环境配置: ${options.envPath}`);
    console.log(`API Base URL: ${config.openaiBaseUrl}`);
    console.log(`模型: ${config.model}`);
    console.log(`供应商类型: ${config.providerType}`);
    console.log(`API Key: ${config.openaiApiKey ? '已配置（未写入日志）' : '未配置'}`);
    console.log(`并发数: ${config.threadNum}`);
    console.log(`原始字幕数: ${subtitles.length}`);

    const startedAt = Date.now();
    const session = new TranslationSession(config, new OpenAIClient(config));
    const result = await session.translate(
      {
        subtitles,
        videoTitle: basename(options.srtPath, '.srt'),
      },
      {
        onProgress: (step, current, total) => {
          console.log(`进度: ${step} ${current}/${total}`);
        },
        onPartialResult: partial => {
          console.log(`收到批次结果: ${partial.english.length} 条`);
          for (let index = 0; index < Math.min(3, partial.english.length); index++) {
            console.log(`样例原文: ${partial.english[index].text}`);
            console.log(`样例译文: ${partial.chinese[index]?.text || ''}`);
          }
        },
      }
    );

    validateResult(result);

    const chinesePath = join(outputDir, `${inputName}.zh.srt`);
    const bilingualPath = join(outputDir, `${inputName}.bilingual.srt`);
    writeFileSync(chinesePath, formatSrt(result, false), 'utf8');
    writeFileSync(bilingualPath, formatSrt(result, true), 'utf8');

    console.log('真实 SRT 测试通过');
    console.log(`断句后字幕数: ${result.english.length}`);
    console.log(`导出时消除时间轴重叠: ${countTimelineOverlaps(result)} 处`);
    console.log(`耗时: ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
    console.log(`中文字幕: ${chinesePath}`);
    console.log(`双语字幕: ${bilingualPath}`);
    console.log(`完整日志: ${logPath}`);
  } catch (error) {
    console.error('真实 SRT 测试失败:', error instanceof Error ? error.stack : error);
    throw error;
  } finally {
    await closeCapture();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
