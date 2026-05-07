# DeepSeek Usage Enhancer

在 DeepSeek Platform 用量页面直接展示**今日数据**：今日消费、今日请求次数、今日 Token 用量、缓存命中率；同时给图表悬停数字自动加上千分位分隔符，让大数字一目了然。

## 你的用量页面本来缺什么？

打开 `[platform.deepseek.com/usage](https://platform.deepseek.com/usage)`，官方页面默认只展示**本月累计**数据。如果你想看「今天花了多少钱」「今天请求了多少次」「缓存命中率是多少」，需要自己点图表柱子、点日期、手动算缓存命中率。

这个脚本可以帮你自动补上这些信息，**直接嵌入页面，就像原生功能一样**。

## 安装

1. 首先给你的浏览器安装一个 **用户脚本管理器**：
   - [Tampermonkey](https://www.tampermonkey.net/)（推荐，支持 Chrome / Edge / Firefox）

2. 点击脚本管理器的「添加新脚本」，将本仓库中 `[deepseek-usage-injector.user.js](https://github.com/Jmkwang/DeepSeek-Usage-Enhancer/blob/main/DeepSeek%20Usage%20Enhancer.js)` 的**全部内容**粘贴进去，保存。

3. 脚本会自动生效。你什么都不用配置。

## 功能

安装后直接打开或刷新 [DeepSeek Platform 用量页面](https://platform.deepseek.com/usage)，你会发现多了以下内容：

- **「今日消费」** — 紧挨着官方「本月消费」卡片，显示今天的消费金额（CNY）。
- **今日/昨日请求次数** — 在每个模型的「API 请求次数」下方，追加展示昨天和今天的请求量。
- **今日总 Tokens + 缓存命中率** — 在「Tokens」区域下方展示今日 Token 总量和缓存命中百分比，再也不用手动复制给计算器了。
- **图表数字千分位** — 鼠标悬停在图表上时，所有 4 位以上的数字会自动加上逗号分隔（如 `1234567` → `1,234,567`），你也不想一位位数，对吧。

> 页面是 React 渲染的，脚本会持续监听 DOM 变化，即使页面重绘也不会丢失注入的数据。

## 原理简介

脚本通过拦截页面发起的三个 API 请求来获取原始数据：

| API | 用途 |
|-----|------|
| `GET /api/v0/users/get_user_summary` | 账户余额与本月消费 |
| `GET /api/v0/usage/amount` | 各模型的 Token/请求用量 |
| `GET /api/v0/usage/cost` | 每日费用明细 |

拦截到的数据经过解析后，直接注入到页面对应的 DOM 位置上，无需任何后端服务。

## 安全说明

- 脚本代码完全在浏览器本地运行，不向任何第三方发送数据。
- `@grant none` 表示不申请任何浏览器扩展特权，仅作用于 DeepSeek 用量页面。
- 源代码只有 **600 多行**，没有压缩混淆，可以逐行审查。

## 更新日志

### v1.0.0
- 首次发布：今日消费卡片、模型请求次数/Token/缓存命中率注入、图表数字千分位格式化。

## 许可

MIT
