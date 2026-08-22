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

/**
 * 构建适合阅读与翻译的连续纯文本：合并全部字幕片段为一段，
 * 不带时间戳与换行。清洗（实体解码、去标注）由采集层完成。
 */
export function buildPlainTextTranscript(subtitles: SimpleSubtitleEntry[]): string {
  return subtitles
    .map((subtitle) => decodeHtmlEntities(subtitle.text).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' ');
}
