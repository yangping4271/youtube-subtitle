import { describe, expect, it } from 'vitest';

import {
  buildPlainTextTranscript,
  decodeHtmlEntities,
} from '../../src/core/transcript-text.js';


describe('decodeHtmlEntities', () => {
  it('解码十进制与十六进制数字实体', () => {
    expect(decodeHtmlEntities('That&#39;s the &quot;gist&quot;')).toBe('That\'s the "gist"');
    expect(decodeHtmlEntities('&#x27;quoted&#x27;')).toBe("'quoted'");
  });

  it('解码常见命名实体并保留未知实体原样', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('&unknownentity;')).toBe('&unknownentity;');
  });
});

describe('buildPlainTextTranscript', () => {
  it('合并全部片段为一段连续文本，不含时间戳与换行，并兜底解码实体', () => {
    expect(
      buildPlainTextTranscript([
        { startTime: 0, endTime: 2.9, text: 'Pi&#39;s technical makeup' },
        { startTime: 473, endTime: 480, text: 'is actually very trivial.' },
      ])
    ).toBe("Pi's technical makeup is actually very trivial.");
  });

  it('跳过空片段并压缩片段内部空白', () => {
    expect(
      buildPlainTextTranscript([
        { startTime: 5, endTime: 6, text: '  Hello\n world  ' },
        { startTime: 6, endTime: 7, text: '' },
        { startTime: 65, endTime: 70, text: 'Next.' },
      ])
    ).toBe('Hello world Next.');
  });
});
