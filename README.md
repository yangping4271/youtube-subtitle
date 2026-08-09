# YouTube Subtitle Translator

自动翻译 YouTube 视频字幕的 Chrome 扩展，仅支持远程 API 模式。

## 项目结构

```text
src/                TypeScript 源码
  core/             纯业务逻辑
  extension/        Chrome Extension 入口
  services/         外部服务封装
  types/            类型定义
  utils/            通用工具
public/extension/   扩展静态资源
tests/              测试用例
  unit/             单元测试
  integration/      离线集成测试
  manual/           真实 API / 手动测试
  fixtures/         测试样例文件
scripts/            开发辅助脚本
dist/extension/     构建产物
```

## 技术栈

- TypeScript
- esbuild
- Vitest
- Chrome Extension Manifest V3

## 快速开始

```bash
npm install
npm run build
```

构建完成后，Chrome 扩展目录为 `dist/extension`。

## API 配置

- 支持 OpenAI、OpenRouter、DeepSeek 及远程 HTTPS OpenAI-compatible API
- `API Base URL` 只需填写域名，例如 `https://api.openai.com`；OpenAI 请求会自动补全为 `/v1/chat/completions`，测试连接会自动补全为 `/v1/models`
- 已填写路径的第三方地址会原样保留，例如 `https://api.krill-ai.net/codex/v1`
- `API Base URL` 必须是远程 HTTPS 地址；本地模型服务和 HTTP 地址不受支持
- 所有翻译请求都会优先关闭模型思考模式；服务或模型不支持关闭参数时，会自动使用其默认思考模式继续翻译
- 首次连接新的 API 地址时，扩展会按该地址动态请求访问权限，而不是默认申请所有网站权限
- 升级后，已保存的本地 API 配置会被移除，需要重新选择远程 API

## 开发命令

```bash
npm run build         # 开发构建
npm run build:prod    # 生产构建
npm run watch         # 监听源码变化
npm run typecheck     # 类型检查
npm run test          # 运行默认测试（不含 manual）
npm run test:manual   # 运行手动测试
```

## 真实 SRT 本地测试

使用 `~/.config/subtitle-translator/.env` 中的真实 API 配置运行完整流水线：

```bash
bun run test:real-srt -- --srt "/path/to/subtitle.srt"
```

可通过 `--env` 指定其他配置文件，通过 `--output` 指定输出根目录。默认在
`log/real-srt/` 下保存完整日志、中文字幕 SRT 和双语 SRT；API Key 不会写入日志。

## 版本与发布

- 版本号保持一致：`package.json`、`public/extension/manifest.json`、`public/extension/popup.html`
- Git tag 使用 `vX.Y.Z`
- GitHub Release 附件使用 `youtube-subtitle-vX.Y.Z.zip`

示例打包命令：

```bash
VERSION=$(node -p "require('./public/extension/manifest.json').version")
npm run build
cd dist/extension
zip -r "../../youtube-subtitle-v${VERSION}.zip" .
```

## 加载扩展

1. 执行 `npm run build`
2. 打开 `chrome://extensions/`
3. 开启“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择 `dist/extension`

## 测试说明

- 默认测试只跑 `tests/unit` 和 `tests/integration`
- `tests/manual` 依赖 `.env` 和真实 API，不会默认执行
- 示例字幕文件放在 `tests/fixtures/sample.srt`

## License

MIT
