# 项目结构

```
src/
├── extension/       # Chrome 扩展入口
│   ├── background.ts    # Service Worker
│   ├── content.ts       # Content Script
│   ├── inject.ts        # 注入脚本
│   ├── config.ts        # 扩展配置
│   └── ...
├── core/           # 核心逻辑
│   ├── translator.ts    # 翻译核心
│   ├── splitter.ts      # 字幕分段
│   └── prompts.ts       # AI 提示词
├── services/       # 外部服务
│   ├── openai-client.ts
│   └── translator-service.ts
├── types/          # 类型定义
└── utils/          # 工具函数
```

## 架构原则

- `extension/` 处理 Chrome API 和 DOM 交互
- `core/` 包含纯业务逻辑，不依赖浏览器 API
- `services/` 封装外部 API 调用
- `utils/` 提供可复用工具函数

## 添加新功能

1. 业务逻辑放 `core/`
2. Chrome API 交互放 `extension/`
3. 第三方服务调用放 `services/`
4. 通用工具放 `utils/`
