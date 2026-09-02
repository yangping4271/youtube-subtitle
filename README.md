# YouTube Subtitle Translator

一个将 YouTube 英文字幕翻译为所选目标语言的 Chrome 扩展。在播放器中直接看双语字幕，支持全文对照与 SRT 文件导出。

配置任意 OpenAI-compatible API（如 OpenAI、DeepSeek、OpenRouter）即可使用。

## 本地安装

1. 安装依赖并构建：
   ```bash
   bun install
   bun run build
   ```
2. 打开 Chrome 的 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择项目根目录下的 `dist/extension` 目录。

## License

MIT
