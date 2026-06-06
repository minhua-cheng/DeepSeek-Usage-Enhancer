# DeepSeek Usage Enhancer

> Forked from [Jmkwang/DeepSeek-Usage-Enhancer](https://github.com/Jmkwang/DeepSeek-Usage-Enhancer)

在 DeepSeek 用量页面自动补全今日消费、请求次数、Token 用量、缓存命中率。

## 版本

| 版本 | 文件 | 特点 |
|------|------|------|
| **页面注入版** | `DeepSeek-Usage-Enhancer.js` | 数据注入页面布局，像原生功能 |
| **悬浮面板版** | `deepseek-usage-monitor.js` | 独立浮窗，可拖拽折叠 |
| **悬浮面板版（中文）** | `deepseek-usage-monitor-zh.js` | 悬浮面板版的中文本地化版本 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴对应 `.js` 文件内容，保存
3. 打开 [DeepSeek 用量页面](https://platform.deepseek.com/usage) 即可

## 原理

拦截页面 API 请求（`window.fetch` + `XMLHttpRequest`），在浏览器本地处理数据，不向第三方发送。

## 安全

- 纯本地运行，`@grant none`，无远程通信
- 源代码可逐行审查

## 许可

MIT
