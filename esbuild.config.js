import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');

// 通用浏览器配置
const browserConfig = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  minify: isProduction,
  sourcemap: !isProduction,
};

// 扩展各入口文件配置
const extensionEntries = [
  {
    entryPoints: ['src/extension/translator.ts'],
    outfile: 'extension/translator.js',
    globalName: 'TranslatorModule',
  },
  {
    entryPoints: ['src/extension/config.ts'],
    outfile: 'extension/config.js',
    globalName: 'ConfigModule',
  },
  {
    entryPoints: ['src/extension/inject.ts'],
    outfile: 'extension/inject.js',
  },
  {
    entryPoints: ['src/extension/subtitle-parser.ts'],
    outfile: 'extension/subtitle-parser.js',
    globalName: 'SubtitleParserModule',
  },
  {
    entryPoints: ['src/extension/transcript-core.ts'],
    outfile: 'extension/transcript-core.js',
  },
  {
    entryPoints: ['src/extension/background.ts'],
    outfile: 'extension/background.js',
    globalName: 'BackgroundModule',
  },
  {
    entryPoints: ['src/extension/content.ts'],
    outfile: 'extension/content.js',
    globalName: 'ContentModule',
  },
];

// 检查静态文件是否存在
function checkStaticFiles() {
  // 确保 extension 目录存在
  if (!fs.existsSync('extension')) {
    fs.mkdirSync('extension', { recursive: true });
  }

  // 静态文件已经在 extension/ 目录中
  // 但为了支持 CI 或清理后重建，确保这些文件存在的提示
  const requiredFiles = [
    'manifest.json',
    'popup.html',
    'popup.js',
    'popup.css',
    'subtitle-overlay.css',
  ];

  const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join('extension', file)));

  if (missingFiles.length > 0) {
    console.warn('⚠️  警告：以下静态文件缺失：');
    missingFiles.forEach(file => console.warn(`   - extension/${file}`));
    console.warn('   请确保这些文件存在于 extension/ 目录中');
  }

  console.log('📁 Extension directory ready');
}

async function build() {
  try {
    // 检查静态文件
    checkStaticFiles();

    // 构建所有扩展入口
    const extensionConfigs = extensionEntries.map(entry => ({
      ...browserConfig,
      ...entry,
    }));

    if (isWatch) {
      // 开发模式：监听文件变化
      const contexts = await Promise.all(
        extensionConfigs.map(config => esbuild.context(config))
      );

      await Promise.all(contexts.map(ctx => ctx.watch()));
      console.log('👀 Watching for changes...');
    } else {
      // 一次性构建
      console.log('🔨 Building...');

      await Promise.all(
        extensionConfigs.map(config => esbuild.build(config))
      );

      console.log('✅ Build complete');
      console.log('   📦 Extension files:');
      extensionEntries.forEach(entry => {
        console.log(`      - ${entry.outfile}`);
      });
    }
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
