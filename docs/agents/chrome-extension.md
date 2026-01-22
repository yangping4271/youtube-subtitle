# Chrome 扩展规范

## Manifest V3

使用 Manifest V3 规范，关键差异：
- Service Worker 替代 Background Page
- 声明式网络请求
- Promises 替代回调

## 扩展组件

### Background (Service Worker)
- 处理扩展生命周期事件
- 管理消息传递
- 不能直接访问 DOM

### Content Script
- 注入到页面中
- 可访问 DOM
- 与页面隔离的 JavaScript 环境

### Inject Script
- 直接在页面上下文执行
- 可访问页面的 JavaScript 变量

## 消息传递

使用 `chrome.runtime.sendMessage` 和 `chrome.runtime.onMessage`。

## 配置存储

使用 `chrome.storage.local`，不使用 `.env` 文件。
所有配置通过扩展界面手动设置。
