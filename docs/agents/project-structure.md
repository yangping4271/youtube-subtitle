# 项目结构

```text
src/
├── extension/       # Chrome 扩展 TypeScript 入口
├── core/            # 核心业务逻辑
├── services/        # 外部服务封装
├── types/           # 类型定义
└── utils/           # 通用工具

public/
└── extension/       # manifest、popup、样式、图标等静态资源

tests/
├── unit/            # 单元测试
├── integration/     # 离线集成测试
├── manual/          # 真实 API / 手动测试
└── fixtures/        # 测试样例文件

scripts/             # 开发辅助脚本

dist/
└── extension/       # 构建产物
```

## 架构原则

- `src/extension/` 只处理 Chrome API 和页面交互
- `src/core/` 保持纯逻辑，避免浏览器依赖
- `public/extension/` 只放静态资源，不放构建产物
- `tests/manual/` 不进入默认测试流程
- `dist/` 只放构建结果，不提交源码

## 添加新功能

1. 业务逻辑放 `src/core/`
2. 浏览器交互放 `src/extension/`
3. 静态资源放 `public/extension/`
4. 默认测试放 `tests/unit/` 或 `tests/integration/`
