import { SubtitleData } from '../src/core/subtitle-data.ts';
import { presplitByPunctuation, batchBySentenceCount } from '../src/core/splitter.ts';
import fs from 'fs';

// 读取真实 SRT 文件
const srtContent = fs.readFileSync('./tests/fixtures/sample.srt', 'utf-8');

// 简单的 SRT 解析
const lines = srtContent.split('\n');
const subtitles = [];
let current = {};

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  if (/^\d+$/.test(line)) {
    current.index = parseInt(line);
  } else if (line.includes('-->')) {
    const [start, end] = line.split('-->').map(s => s.trim());
    const parseTime = (t) => {
      const [h, m, s] = t.replace(',', '.').split(':');
      return (parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000;
    };
    current.startTime = parseTime(start);
    current.endTime = parseTime(end);
  } else if (current.index) {
    current.text = line;
    subtitles.push({...current});
    current = {};
  }
}

console.log('📊 原始字幕数:', subtitles.length);
console.log('📝 前3条字幕:');
subtitles.slice(0, 3).forEach(s => console.log(`  - ${s.text}`));

// 转换为单词级
const data = new SubtitleData(subtitles);
const wordData = data.splitToWordSegments();
const words = wordData.getSegments();

console.log('\n📝 单词数:', words.length);
console.log('📝 前30个token:', words.slice(0, 30).map(w => w.text).join(' '));

// 预分句
const preSplit = presplitByPunctuation(words);
console.log('\n📝 预分句数:', preSplit.length);
console.log('📝 前5个预分句:');
preSplit.slice(0, 5).forEach((s, i) => {
  console.log(`  ${i + 1}. ${s.text.substring(0, 80)}...`);
  console.log(`     单词范围: [${s.wordStartIndex}, ${s.wordEndIndex})`);
});

// 分批
const batches = batchBySentenceCount(preSplit, 5, 5, 10);
console.log('\n📦 批次数:', batches.length);
console.log('📦 每批句子数:', batches.map(b => b.length).join(', '));

console.log('\n✅ 测试完成！');
