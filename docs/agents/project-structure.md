# 项目结构

```
src/
├── extension/       # Chrome 扩展入口
│   ├── background.ts    # Service Worker
│   ├── content.ts       # Content Script
│   ├── inject.ts        # 注入脚本
│   ├── config.ts        # 扩展配置
│   ├── subtitle-parser.ts  # 字幕解析
│   ├── transcript-core.ts  # 字幕获取核心
│   ├── translator.ts       # 扩展翻译逻辑
│   └── video-metadata.ts   # 视频元数据
├── core/           # 核心逻辑
│   ├── translator.ts    # 翻译核心
│   ├── splitter.ts      # 字幕分段
│   ├── subtitle-data.ts # 字幕数据结构
│   └── prompts.ts       # AI 提示词
├── services/       # 外部服务
│   ├── openai-client.ts
│   └── translator-service.ts
├── types/          # 类型定义
│   └── index.ts
├── utils/          # 工具函数
│   ├── batch-utils.ts   # 分批工具
│   ├── error-handler.ts # 错误处理
│   ├── json-repair.ts   # JSON 修复
│   ├── language.ts      # 语言检测
│   ├── logger.ts        # 日志
│   ├── punctuation.ts   # 标点处理
│   ├── retry.ts         # 重试逻辑
│   └── similarity.ts    # 相似度计算
└── tests/          # 测试
    ├── e2e-real-api.test.ts       # 端到端测试
    ├── integration.test.ts        # 集成测试
    └── pipeline-concurrent.test.ts # 并发流水线测试
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
