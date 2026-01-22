# YouTube 字幕翻译 Chrome 扩展

一个用于自动翻译 YouTube 视频字幕的 Chrome 浏览器扩展。

## 功能特性

- 自动提取 YouTube 视频字幕
- 字幕翻译功能

## 技术栈

- TypeScript
- esbuild（构建工具）
- Chrome Extension Manifest V3

## 项目结构

```
├── src/                    # 源代码
│   ├── extension/         # 扩展源码
│   ├── core/             # 核心功能（翻译、断句）
│   ├── services/         # 服务层
│   ├── types/            # 类型定义
│   └── utils/            # 工具函数
├── extension/             # 扩展构建输出
└── esbuild.config.js     # 构建配置
```

## 安装

### 依赖安装

```bash
npm install
```

### 构建扩展

```bash
# 开发模式（带 sourcemap）
npm run build

# 生产模式
npm run build:prod

# 监听模式
npm run watch
```

### 加载扩展

1. 运行 `npm run build` 构建扩展
2. 打开 Chrome 浏览器，进入 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目中的 `extension` 目录

## 使用

在 YouTube 视频页面使用扩展功能进行字幕翻译和摘要。

## 环境配置

复制 `.env.example` 为 `.env` 并配置必要的环境变量。

## 开发

```bash
# 类型检查
npm run typecheck

# 监听模式开发
npm run watch
```

## License

MIT
