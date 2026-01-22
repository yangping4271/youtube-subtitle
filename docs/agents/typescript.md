# TypeScript 约定

## 类型优先

- 优先使用 `interface` 定义对象类型
- 使用 `type` 定义联合类型和工具类型
- 避免 `any`，使用 `unknown` 处理未知类型

## 导入导出

- 使用命名导出，避免默认导出
- 类型导入使用 `import type`

## 错误处理

- 使用 `utils/error-handler.ts` 统一处理错误
- 异步操作使用 try-catch

## 命名规范

- 文件名：kebab-case（如 `subtitle-parser.ts`）
- 类型/接口：PascalCase
- 变量/函数：camelCase
- 常量：UPPER_SNAKE_CASE

## 避免过度工程

- 不写一次性使用的抽象
- 不添加未来可能需要的功能
- 保持函数简单直接
