import type { SimpleSubtitleEntry } from '../types/index.js';

/**
 * 将按时间切分的字幕整理成适合复制到 TXT 的连续纯文本。
 *
 * YouTube 的 SRV3 字幕可能会把每个单词作为独立片段返回，因此这里不能
 * 像字幕文件那样用换行连接片段。
 */
export function buildPlainTextTranscript(
  subtitles: SimpleSubtitleEntry[]
): string {
  return subtitles
    .map((subtitle) => subtitle.text.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' ');
}
