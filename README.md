# YouTube 字幕翻译 Chrome 扩展

自动翻译 YouTube 视频字幕的 Chrome 浏览器扩展。

## 功能

- 自动提取 YouTube 视频字幕
- 字幕翻译

## 技术栈

- TypeScript
- esbuild
- Chrome Extension Manifest V3

## 快速开始

### 安装依赖

```bash
npm install
```

### 构建

```bash
npm run build      # 开发构建（带 sourcemap）
npm run build:prod # 生产构建
npm run watch      # 监听模式
```

### 加载扩展

1. 构建扩展：`npm run build`
2. 打开 Chrome：`chrome://extensions/`
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目中的 `extension` 目录

## 配置

所有配置通过扩展界面手动设置，无需配置文件。

## 开发

```bash
npm run typecheck  # 类型检查
npm run watch      # 监听模式开发
```

## License

MIT
