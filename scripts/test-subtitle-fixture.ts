/**
 * 使用项目内的字幕夹具验证字幕采集规范化逻辑，不调用远程 API。
 *
 * 示例：
 * bun run test:subtitle-fixture
 * bun run test:subtitle-fixture -- --srt /path/to/subtitle.srt
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeSubtitleTiming } from '../src/core/subtitle-acquisition.js';
import { SubtitleParser } from '../src/extension/subtitle-parser.js';

const DEFAULT_FIXTURE = resolve(
  process.cwd(),
  'tests/fixtures/sample.srt'
);
const LOCAL_REAL_FIXTURE = resolve(
  process.cwd(),
  'tmp/test-fixtures/Vp4glSVPT8o.en.srt'
);

function readArgument(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(`--${name}`);
  if (exactIndex >= 0) {
    return process.argv[exactIndex + 1];
  }

  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

const subtitlePath = resolve(
  readArgument('srt')
    || (existsSync(LOCAL_REAL_FIXTURE) ? LOCAL_REAL_FIXTURE : DEFAULT_FIXTURE)
);
const usingLocalRealFixture = subtitlePath === LOCAL_REAL_FIXTURE;
const content = readFileSync(subtitlePath, 'utf8');
const subtitles = SubtitleParser.parseSRT(content);

if (subtitles.length === 0) {
  throw new Error(`字幕夹具为空: ${subtitlePath}`);
}

if (usingLocalRealFixture && subtitles.length !== 776) {
  throw new Error(
    `真实字幕夹具条数异常: ${subtitles.length}，期望 Vp4glSVPT8o.en.srt 包含 776 条字幕`
  );
}

const normalized = normalizeSubtitleTiming(subtitles);
if (normalized.length !== subtitles.length) {
  throw new Error(
    `字幕经过一次规范化后数量发生变化: ${subtitles.length} -> ${normalized.length}`
  );
}

const duplicatedInput = normalizeSubtitleTiming([...subtitles, ...subtitles]);
if (duplicatedInput.length !== subtitles.length) {
  throw new Error(
    `重复字幕去重失败: ${subtitles.length * 2} -> ${duplicatedInput.length}，期望 ${subtitles.length}`
  );
}

if (usingLocalRealFixture && duplicatedInput.length !== 776) {
  throw new Error(
    `真实字幕夹具验收失败: 复制输入应为 1552 条并去重为 776 条，实际去重后 ${duplicatedInput.length} 条`
  );
}

console.log(`字幕夹具通过: ${subtitlePath}`);
console.log(`- 原始字幕: ${subtitles.length} 条`);
console.log(`- 复制输入: ${subtitles.length * 2} 条 -> 去重后 ${duplicatedInput.length} 条`);
