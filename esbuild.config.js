import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');
const staticDir = 'public/extension';
const outDir = 'dist/extension';

const browserConfig = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  minify: isProduction,
  sourcemap: !isProduction,
};

const extensionEntries = [
  {
    entryPoints: ['src/extension/config.ts'],
    outfile: `${outDir}/config.js`,
    globalName: 'ConfigModule',
  },
  {
    entryPoints: ['src/extension/inject.ts'],
    outfile: `${outDir}/inject.js`,
  },
  {
    entryPoints: ['src/extension/subtitle-parser.ts'],
    outfile: `${outDir}/subtitle-parser.js`,
    globalName: 'SubtitleParserModule',
  },
  {
    entryPoints: ['src/extension/transcript-core.ts'],
    outfile: `${outDir}/transcript-core.js`,
  },
  {
    entryPoints: ['src/extension/background.ts'],
    outfile: `${outDir}/background.js`,
    globalName: 'BackgroundModule',
  },
  {
    entryPoints: ['src/extension/content.ts'],
    outfile: `${outDir}/content.js`,
    globalName: 'ContentModule',
  },
];

function ensureStaticFiles() {
  const requiredFiles = [
    'manifest.json',
    'popup.html',
    'popup.js',
    'popup.css',
    'subtitle-overlay.css',
  ];

  const missingFiles = requiredFiles.filter((file) => !fs.existsSync(path.join(staticDir, file)));

  if (missingFiles.length > 0) {
    console.warn('Missing static files:');
    missingFiles.forEach((file) => console.warn(`  - ${path.join(staticDir, file)}`));
  }
}

function prepareOutDir() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(staticDir, outDir, { recursive: true });
}

async function build() {
  try {
    ensureStaticFiles();
    prepareOutDir();

    const extensionConfigs = extensionEntries.map((entry) => ({
      ...browserConfig,
      ...entry,
    }));

    if (isWatch) {
      const contexts = await Promise.all(extensionConfigs.map((config) => esbuild.context(config)));
      await Promise.all(contexts.map((context) => context.watch()));
      console.log('Watching for changes...');
      console.log(`Extension output: ${outDir}`);
      return;
    }

    console.log('Building extension...');
    await Promise.all(extensionConfigs.map((config) => esbuild.build(config)));
    console.log(`Build complete: ${outDir}`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
