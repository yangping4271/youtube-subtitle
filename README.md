# YouTube Subtitle Translator

YouTube 字幕翻译 Chrome 扩展，支持 OpenAI-compatible API。

## 开发

```bash
bun install
bun run build
bun run typecheck
bun test
```

加载目录：`dist/extension`

## 发布

```bash
bun run build:prod
cd dist/extension
zip -r ../../youtube-subtitle-vX.Y.Z.zip .
```

## License

MIT
