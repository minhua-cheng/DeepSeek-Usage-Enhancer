# DeepSeek Usage Enhancer

> Forked from [Jmkwang/DeepSeek-Usage-Enhancer](https://github.com/Jmkwang/DeepSeek-Usage-Enhancer)

在 DeepSeek 用量页面自动补全今日消费、请求次数、Token 用量、缓存命中率。

## 版本

| 版本 | 文件 | 特点 |
|------|------|------|
| **页面注入版** | `DeepSeek-Usage-Enhancer.js` | 数据注入页面布局，像原生功能 |
| **悬浮面板版** | `deepseek-usage-monitor.js` | 独立浮窗，可拖拽折叠 |
| **悬浮面板版（中文）** | `deepseek-usage-monitor-zh.js` | 独立浮窗，全中文界面，新增日历 & 主题切换 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴对应 `.js` 文件内容，保存
3. 打开 [DeepSeek 用量页面](https://platform.deepseek.com/usage) 即可

## 功能特色（中文版独有）

### 📅 历史用量日历
点击面板右上角 `📅` 按钮打开日历，查看过去任意日期的用量详情（消费、Token、请求数、缓存命中率），支持跨月浏览。

### 🌓 深色/浅色主题
点击 `🌓` 按钮在深色和浅色主题之间切换，主题偏好自动保存。

### 📊 完整数据面板
- **账户余额** — 充值余额、本月消费、今日消费
- **各模型详情** — deepseek-v4-pro 和 deepseek-v4-Flash 的请求数、总 Token、缓存命中/未命中/输出 Token、缓存命中率
- **状态栏** — 汇总总 Token 和总请求数

### 🔧 交互功能
- **拖拽移动** — 拖拽标题栏移动面板，位置自动保存
- **折叠/展开** — 点击 ▼ 收起面板
- **数值切换** — 点击任意数字在短格式（1.5K）和原始值（1,500）之间切换
- **返回今日** — 查看历史数据后一键回到今日视图

## 原理

拦截页面 API 请求（`window.fetch` + `XMLHttpRequest`），在浏览器本地处理数据，不向第三方发送。

## 安全

- 纯本地运行，`@grant none`，无远程通信
- 源代码可逐行审查

## 更新日志

### v1.4.1
- 新增中文本地化版本 deepseek-usage-monitor-zh.js
- 新增历史用量日历功能，支持按日期查看详情
- 新增深色/浅色主题切换
- 新增"返回今日"快捷按钮
- 拖拽逻辑优化：使用 closest 避免干扰按钮点击
- 全界面中文显示

## 许可

MIT
