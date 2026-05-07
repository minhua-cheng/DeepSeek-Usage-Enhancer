// ==UserScript==
// @name         DeepSeek Usage Enhancer 
// @namespace    https://github.com/local/deepseek-usage-enhancer
// @version      1.0.0
// @description  在 DeepSeek 用量页面直接注入今日数据：今日消费、今日请求数、今日Token、缓存命中率；图表悬停数字加千分位
// @author       Jmkwang
// @match        https://platform.deepseek.com/usage*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 状态
  // ============================================================
  let bearerToken = null;

  let rawUserSummary = null;
  let rawUsageAmount = null;
  let rawUsageCost = null;

  // ============================================================
  // 工具函数
  // ============================================================
  function utcToday() {
    const d = new Date();
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function utcYesterday() {
    const d = new Date(Date.now() - 86400000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function utcMonthYear() {
    const d = new Date();
    return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
  }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function log(msg) {
    console.log('[DS Inject] ' + msg);
  }

  // ============================================================
  // biz_data 提取
  // ============================================================
  function extractBizData(json) {
    if (!json) return null;
    let result = null;
    if (json.biz_data) result = json.biz_data;
    else if (json.data && json.data.biz_data) result = json.data.biz_data;
    else if (json.data && Array.isArray(json.data) && json.data.length > 0) result = json.data[0];
    else result = json;
    if (Array.isArray(result) && result.length > 0) return result[0];
    return result;
  }

  function findAuthHeader(req) {
    if (req.headers && typeof req.headers.get === 'function') {
      return req.headers.get('Authorization') || req.headers.get('authorization');
    }
    if (req.headers && typeof req.headers === 'object') {
      return req.headers['Authorization'] || req.headers['authorization'];
    }
    return null;
  }

  // ============================================================
  // 数据变换
  // ============================================================
  function usageArrayToMap(usageArr) {
    if (!Array.isArray(usageArr)) return {};
    const map = {};
    for (const u of usageArr) {
      map[u.type] = Number(u.amount) || 0;
    }
    return map;
  }

  function extractMetricsFromUsage(usageMap) {
    const types = Object.keys(usageMap);
    const lowerMap = {};
    for (const t of types) {
      lowerMap[t.toLowerCase()] = usageMap[t];
    }

    const find = (keywords) => {
      for (const kw of keywords) {
        if (usageMap[kw] !== undefined) return usageMap[kw];
        if (lowerMap[kw.toLowerCase()] !== undefined) return lowerMap[kw.toLowerCase()];
        for (const t of types) {
          if (t.toLowerCase().includes(kw.toLowerCase())) return usageMap[t];
        }
      }
      return 0;
    };

    const cachedInput = find(['PROMPT_CACHE_HIT_TOKEN', 'PROMPT_CACHE_HIT_TOKENS',
      'CACHE_HIT_TOKENS', 'cache_hit_tokens', 'prompt_cache_hit_tokens']);
    const uncachedInput = find(['PROMPT_CACHE_MISS_TOKEN', 'PROMPT_CACHE_MISS_TOKENS',
      'CACHE_MISS_TOKENS', 'cache_miss_tokens', 'prompt_cache_miss_tokens']);
    const output = find(['RESPONSE_TOKEN', 'RESPONSE_TOKENS',
      'COMPLETION_TOKEN', 'COMPLETION_TOKENS',
      'output_tokens', 'completion_tokens']);
    const requests = find(['REQUEST', 'REQUESTS',
      'API_REQUESTS', 'request_count', 'api_requests']);

    const total = cachedInput + uncachedInput + output;
    const divisor = cachedInput + uncachedInput;
    const cacheHitRate = divisor > 0
      ? Math.round((cachedInput / divisor) * 10000) / 100
      : null;

    return { requests, tokens: { total, cached_input: cachedInput, uncached_input: uncachedInput, output }, cache_hit_rate: cacheHitRate };
  }

  function transformUserSummary(bizData) {
    const normalBal = (bizData.normal_wallets && bizData.normal_wallets[0])
      ? Number(bizData.normal_wallets[0].balance) || 0 : 0;
    const bonusBal = (bizData.bonus_wallets && bizData.bonus_wallets[0])
      ? Number(bizData.bonus_wallets[0].balance) || 0 : 0;
    const monthlyCost = (bizData.monthly_costs && bizData.monthly_costs[0])
      ? Number(bizData.monthly_costs[0].amount) || 0 : 0;
    const currency = (bizData.monthly_costs && bizData.monthly_costs[0])
      ? bizData.monthly_costs[0].currency : 'CNY';
    return {
      balance: { total: normalBal, normal_wallet_balance: normalBal, bonus_wallet_balance: bonusBal, currency },
      monthly_consumption: { amount: monthlyCost, currency },
    };
  }

  function extractModelsForDate(bizData, dateStr) {
    const models = {};
    let dayEntries = [];
    if (bizData.days) {
      const day = bizData.days.find(d => d.date === dateStr);
      if (day && day.data) dayEntries = day.data;
    }
    const allEntries = [...dayEntries, ...(bizData.total || [])];

    for (const entry of allEntries) {
      if (!entry.model) continue;
      const lower = entry.model.toLowerCase();
      const isPro = lower.includes('pro') && (lower.includes('v4') || lower.includes('v-4'));
      const isFlash = lower.includes('flash') && (lower.includes('v4') || lower.includes('v-4'));
      if (!isPro && !isFlash) continue;

      const metrics = extractMetricsFromUsage(usageArrayToMap(entry.usage));
      if (dayEntries.includes(entry) || !models[entry.model]) {
        models[entry.model] = metrics;
      }
    }
    return models;
  }

  function transformUsageAmount(bizData) {
    const today = utcToday();
    const yesterday = utcYesterday();
    return {
      today_date: today,
      models: extractModelsForDate(bizData, today),
      yesterday_models: extractModelsForDate(bizData, yesterday),
    };
  }

  function transformUsageCost(bizData) {
    const today = utcToday();
    let todayCost = 0;
    const currency = bizData.currency || 'CNY';

    if (bizData.days) {
      const todayDay = bizData.days.find(d => d.date === today);
      if (todayDay && todayDay.data) {
        for (const entry of todayDay.data) {
          if (entry.usage) {
            for (const u of entry.usage) {
              todayCost += Number(u.amount) || 0;
            }
          }
        }
      }
    }

    return { today_cost: { amount: Math.floor(todayCost * 100) / 100, currency } };
  }

  function buildOutputPayload() {
    const summary = rawUserSummary
      ? transformUserSummary(rawUserSummary)
      : { balance: { total: 0, currency: 'CNY' }, monthly_consumption: { amount: 0, currency: 'CNY' } };

    let usageData = { today_date: utcToday(), models: {}, yesterday_models: {} };
    if (rawUsageAmount) usageData = transformUsageAmount(rawUsageAmount);

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost) costData = transformUsageCost(rawUsageCost);

    return {
      timestamp: new Date().toISOString(),
      ...summary,
      ...usageData,
      ...costData,
    };
  }

  // ============================================================
  // 数据接收
  // ============================================================
  function processApiResponse(endpoint, bizData) {
    switch (endpoint) {
    case 'get_user_summary': rawUserSummary = bizData; break;
    case 'usage_amount': rawUsageAmount = bizData; break;
    case 'usage_cost': rawUsageCost = bizData; break;
    }
    const payload = buildOutputPayload();
    if (payload) {
      onDataUpdate(payload);
    }
  }

  // ============================================================
  // 拦截层
  // ============================================================
  const TRACKED_ENDPOINTS = [
    { method: 'GET', path: '/api/v0/users/get_user_summary', id: 'get_user_summary' },
    { method: 'GET', path: '/api/v0/usage/amount', id: 'usage_amount' },
    { method: 'GET', path: '/api/v0/usage/cost', id: 'usage_cost' },
  ];

  function matchEndpoint(method, url) {
    for (const ep of TRACKED_ENDPOINTS) {
      if (method.toUpperCase() === ep.method && url.includes(ep.path)) {
        return ep;
      }
    }
    return null;
  }

  // --- fetch 拦截 ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    const ep = matchEndpoint(method, url);

    if (ep) {
      const req = input instanceof Request ? input : { headers: init && init.headers };
      if (!bearerToken) {
        const auth = findAuthHeader(req);
        if (auth && auth.startsWith('Bearer ')) bearerToken = auth.slice(7);
      }
    }

    return origFetch.call(window, input, init).then(async (response) => {
      if (ep && response.ok) {
        try {
          const cloned = response.clone();
          const json = await cloned.json();
          const bizData = extractBizData(json);
          if (bizData) processApiResponse(ep.id, bizData);
        } catch (e) { /* ignore */ }
      }
      return response;
    });
  };

  // --- XHR 拦截 ---
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let _method = 'GET';
    let _url = '';

    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      _method = method;
      _url = typeof url === 'string' ? url : url.toString();
      return origOpen.call(xhr, method, url, ...rest);
    };

    const origSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (header, value) {
      if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
        if (!bearerToken) bearerToken = value.slice(7);
      }
      return origSetRequestHeader.call(xhr, header, value);
    };

    const origSend = xhr.send;
    xhr.send = function (body) {
      const ep = matchEndpoint(_method, _url);
      xhr.addEventListener('load', function () {
        if (ep && xhr.status >= 200 && xhr.status < 300) {
          const json = safeJSON(xhr.responseText);
          if (json) {
            const bizData = extractBizData(json);
            if (bizData) processApiResponse(ep.id, bizData);
          }
        }
      });
      return origSend.call(xhr, body);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  // ============================================================
  // DOM 注入
  // ============================================================
  let latestPayload = null;
  let tooltipObserverSetup = false;
  const INJECT_MARKER = 'data-ds-inject';

  function onDataUpdate(payload) {
    latestPayload = payload;
    tryAllInjections();
  }

  // 检查页面上是否已有注入标记（被 React 重绘后标记消失）
  function isInjectionPresent(marker) {
    return !!document.querySelector('[' + INJECT_MARKER + '="' + marker + '"]');
  }

  function tryAllInjections() {
    if (!latestPayload) return;

    // 今日消费卡片：不存在则创建，已存在则更新金额
    if (!isInjectionPresent('cost')) {
      injectTodayCostCard();
    } else {
      updateTodayCostAmount();
    }

    const modelNames = Object.keys(latestPayload.models || {});
    for (const name of modelNames) {
      const marker = 'model-' + name.replace(/[^a-z0-9-]/gi, '_');
      if (!isInjectionPresent(marker)) {
        const yd = (latestPayload.yesterday_models || {})[name];
        injectModelData(name, latestPayload.models[name], yd, marker);
      }
    }

    if (!tooltipObserverSetup) {
      setupTooltipFormatter();
      tooltipObserverSetup = true;
    }
  }

  // ---- 今日消费卡片 ----
  function injectTodayCostCard() {
    // 找到本月消费卡片（确认数据已加载：_7ed1d04 里必须有 ¥ + 数字两个 span）
    const allCards = document.querySelectorAll('[class*="a0cde8c1"]');
    let monthCard = null;
    for (const card of allCards) {
      const titleEl = card.querySelector('[class*="_477051d"]');
      if (titleEl && titleEl.textContent.includes('本月消费')) {
        const valueEl = card.querySelector('[class*="_7ed1d04"]');
        if (valueEl && valueEl.querySelectorAll('span').length >= 2) {
          monthCard = card;
        }
        break;
      }
    }
    if (!monthCard) return;

    // 从原始卡片读取精确的 class 名，从头构建（不用 cloneNode，避免 React 导致子元素丢失）
    const cardClass = monthCard.className;
    const titleClass = monthCard.querySelector('[class*="_477051d"]').className;

    const todayCard = document.createElement('div');
    todayCard.className = cardClass;
    todayCard.setAttribute(INJECT_MARKER, 'cost');

    const titleDiv = document.createElement('div');
    titleDiv.className = titleClass;
    titleDiv.textContent = '今日消费';

    const outerDiv = document.createElement('div');
    outerDiv.className = 'abf3dfef';
    const midDiv = document.createElement('div');
    const bbDiv = document.createElement('div');
    bbDiv.className = '_4bb7bee';

    const v7Div = document.createElement('div');
    v7Div.className = '_7ed1d04';
    const yen = document.createElement('span');
    yen.textContent = '¥';
    const amt = document.createElement('span');
    amt.textContent = (latestPayload.today_cost || {}).amount.toFixed(2);
    v7Div.appendChild(yen);
    v7Div.appendChild(amt);
    bbDiv.appendChild(v7Div);

    const cnyDiv = document.createElement('div');
    cnyDiv.className = '_1ef3557';
    cnyDiv.style.cssText = 'color: rgb(var(--ds-rgb-label-2));';
    cnyDiv.textContent = 'CNY';
    bbDiv.appendChild(cnyDiv);

    midDiv.appendChild(bbDiv);
    outerDiv.appendChild(midDiv);

    todayCard.appendChild(titleDiv);
    todayCard.appendChild(outerDiv);

    monthCard.parentElement.insertBefore(todayCard, monthCard.nextSibling);
  }

  function updateTodayCostAmount() {
    const costCard = document.querySelector('[' + INJECT_MARKER + '="cost"]');
    if (!costCard) return;
    const v7Div = costCard.querySelector('[class*="_7ed1d04"]');
    if (!v7Div) return;
    const spans = v7Div.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = (latestPayload.today_cost || {}).amount.toFixed(2);
    }
  }

  // ---- 模型数据注入 ----
  function injectModelData(modelName, modelMetrics, yesterdayMetrics, marker) {
    // 找到页面上对应的模型名 span
    const modelSpans = document.querySelectorAll('.ds-text.ds-text--monospace');
    let targetSpan = null;
    for (const span of modelSpans) {
      const text = span.textContent.trim();
      const tLower = text.toLowerCase();
      const mLower = modelName.toLowerCase();
      if (tLower.includes(mLower) || mLower.includes(tLower)) {
        targetSpan = span;
        break;
      }
    }
    if (!targetSpan) return;

    // 找到 grid 容器
    const sectionHeader = targetSpan.closest('[class*="_6926780"]') || targetSpan.closest('div');
    let gridContainer = sectionHeader.nextElementSibling;
    while (gridContainer && !gridContainer.querySelector('[class*="columns-2"]')) {
      gridContainer = gridContainer.nextElementSibling;
    }
    if (!gridContainer) return;

    const grid = gridContainer.querySelector('[class*="columns-2"]');
    if (!grid) return;

    const gridItems = grid.querySelectorAll('.ds-grid-item');

    // ---- 列1: 请求次数 ----
    let requestColumn = null;
    for (const item of gridItems) {
      if (item.textContent.includes('API 请求次数') || item.textContent.includes('请求次数')) {
        requestColumn = item;
        break;
      }
    }
    if (requestColumn) {
      injectRequestExtras(requestColumn, modelMetrics.requests,
        yesterdayMetrics ? yesterdayMetrics.requests : 0, marker);
    }

    // ---- 列2: Tokens ----
    let tokenColumn = null;
    for (const item of gridItems) {
      const labels = item.querySelectorAll('.ds-text--lsp');
      for (const lbl of labels) {
        if (lbl.textContent.trim() === 'Tokens') {
          tokenColumn = item;
          break;
        }
      }
      if (tokenColumn) break;
    }
    if (tokenColumn) {
      injectTokenToday(tokenColumn, modelMetrics, marker);
    }
  }

  // 创建一行：label（与 API 请求次数/Tokens 同款）+ value（与数值同款）
  function makeInjectRow(labelText, valueText) {
    const row = document.createElement('div');
    row.className = 'ds-flex';
    row.style.cssText = 'align-items:baseline;gap:12px;';

    const label = document.createElement('span');
    label.className = 'ds-text ds-text--fsp ds-text--lsp';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = 'ds-text ds-text--label2';
    value.textContent = valueText;

    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function injectRequestExtras(column, todayRequests, yesterdayRequests, marker) {
    // 找到 "API 请求次数" label 的那一行
    const labels = column.querySelectorAll('.ds-text--lsp');
    let labelRow = null;
    for (const lbl of labels) {
      if (lbl.textContent.includes('请求次数')) {
        labelRow = lbl.closest('.ds-flex');
        break;
      }
    }
    if (!labelRow) return;

    const stack = labelRow.parentElement;

    // 昨日请求次数（在今日上方）
    const rowY = makeInjectRow('昨日请求次数', yesterdayRequests.toLocaleString());
    rowY.setAttribute(INJECT_MARKER, marker);
    stack.insertBefore(rowY, labelRow.nextSibling);

    // 今日请求次数
    const rowT = makeInjectRow('今日请求次数', todayRequests.toLocaleString());
    rowT.setAttribute(INJECT_MARKER, marker);
    stack.insertBefore(rowT, rowY.nextSibling);
  }

  function injectTokenToday(column, metrics, marker) {
    // 1. 把 "Tokens" label 改成 "本月总Tokens"
    const labels = column.querySelectorAll('.ds-text--lsp');
    let tokenLabelEl = null;
    for (const lbl of labels) {
      if (lbl.textContent.trim() === 'Tokens') {
        lbl.textContent = '本月总Tokens';
        tokenLabelEl = lbl;
        break;
      }
    }
    if (!tokenLabelEl) return;

    // 找到 token label 那一行 → 垂直 stack
    const tokenRow = tokenLabelEl.closest('.ds-flex');
    if (!tokenRow) return;
    const stack = tokenRow.parentElement;

    // 2. 今日总Tokens
    const totalVal = metrics.tokens ? metrics.tokens.total.toLocaleString() : '0';
    const row1 = makeInjectRow('今日总Tokens', totalVal);
    row1.setAttribute(INJECT_MARKER, marker);

    // 3. 缓存命中率
    const rate = metrics.cache_hit_rate !== null && metrics.cache_hit_rate !== undefined
      ? metrics.cache_hit_rate.toFixed(1) + '%' : '—';
    const row2 = makeInjectRow('今日缓存命中率', rate);
    row2.setAttribute(INJECT_MARKER, marker);

    // 插入到 tokenRow 后面（图表 div 前面）
    let insertAfter = tokenRow;
    stack.insertBefore(row1, insertAfter.nextSibling);
    stack.insertBefore(row2, row1.nextSibling);
  }

  // ---- 图表 tooltip 数字千分位 ----
  function setupTooltipFormatter() {
    const formatNumber = (text) => {
      return text.replace(/\b(\d{4,})\b/g, (_, n) => Number(n).toLocaleString());
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 处理任何包含大数字的新增元素（ECharts tooltip 内层 div 也覆盖）
          if (/\d{4,}/.test(node.textContent)) {
            formatTooltipText(node, formatNumber);
            node.querySelectorAll('*').forEach(el => {
              if (!el._dsFormatted && /\d{4,}/.test(el.textContent)) {
                formatTooltipText(el, formatNumber);
              }
            });
          }
        }
        if (m.type === 'characterData' && m.target.parentElement) {
          const el = m.target.parentElement;
          if (!el._dsFormatted && /\d{4,}/.test(el.textContent)) {
            formatTooltipText(el, formatNumber);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    log('已启用图表数字千分位格式化');
  }

  function formatTooltipText(root, formatter) {
    if (root._dsFormatted) return;
    root._dsFormatted = true;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const orig = node.textContent;
      const formatted = formatter(orig);
      if (formatted !== orig) {
        node.textContent = formatted;
      }
    }
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek Usage Enhancer 已加载');

    let pollFast = true;
    let pollCount = 0;

    function poll() {
      pollCount++;
      tryAllInjections();

      // 初始阶段每 500ms 快速轮询；稳定后降到 3s
      if (pollFast && pollCount > 20) {
        pollFast = false;
      }
      setTimeout(poll, pollFast ? 500 : 3000);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(poll, 800);
      });
    } else {
      setTimeout(poll, 800);
    }
  }

  init();
})();
