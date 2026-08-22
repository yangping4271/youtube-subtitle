import type { SimpleSubtitleEntry } from '../types/index.js';


const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

/**
 * 解码 YouTube timedtext 返回文本中的 HTML 实体（如 &#39;、&amp;）。
 * 不依赖 DOM，可在 Node 测试环境直接运行。
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function formatSegmentTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const wholeSeconds = totalSeconds % 60;
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
}

/**
 * 构建适合阅读的分段转录：每个字幕片段一段，段首带 m:ss 时间标记，
 * 类似 YouTube 转录面板被网页剪藏后的效果。
 */
export function buildMarkdownTranscript(subtitles: SimpleSubtitleEntry[]): string {
  return subtitles
    .map((subtitle) => ({
      startTime: subtitle.startTime,
      text: decodeHtmlEntities(subtitle.text).replace(/\s+/g, ' ').trim(),
    }))
    .filter((segment) => segment.text.length > 0)
    .map((segment) => `**${formatSegmentTimestamp(segment.startTime)}** · ${segment.text}`)
    .join('\n\n');
}
