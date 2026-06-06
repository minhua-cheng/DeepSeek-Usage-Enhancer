// Based on deepseek-usage-monitor.js by Jmkwang
// ==UserScript==
// @name         DeepSeek 每日用量监控
// @namespace    https://github.com/local/deepseek-usage-monitor
// @version      1.4.1
// @description  拦截 DeepSeek 开放平台用量 API，在小窗口中展示完整数据，支持日历查看历史每日用量（纯本地，无远程通信）
// @author       minhua-cheng
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

  // 每日数据缓存 (合并 amount 和 cost)
  // 结构: Map<dateString, { models: { modelName: { tokens, cost, requests, cache_hit_rate } }, totalTokens, totalCost, totalRequests, overallHitRate }>
  let dailyDataMap = new Map();

  // 视图状态: 'today' 或 'date'
  let currentView = 'today';
  let selectedDate = null; // 'YYYY-MM-DD'

  // ============================================================
  // 工具函数
  // ============================================================

  function utcToday() {
    const d = new Date();
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function log(msg) {
    console.log('[DS 监控] ' + msg);
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
      balance: {
        total: normalBal,
        normal_wallet_balance: normalBal,
        bonus_wallet_balance: bonusBal,
        currency,
      },
      monthly_consumption: { amount: monthlyCost, currency },
    };
  }

  function transformUsageAmount(bizData) {
    const today = utcToday();
    const models = {};

    let todayEntries = [];
    if (bizData.days) {
      const todayDay = bizData.days.find(d => d.date === today);
      if (todayDay && todayDay.data) {
        todayEntries = todayDay.data;
      }
    }

    const allEntries = [...todayEntries, ...(bizData.total || [])];

    for (const entry of allEntries) {
      if (!entry.model) continue;
      const modelLower = entry.model.toLowerCase();
      const isPro = modelLower.includes('pro') && (modelLower.includes('v4') || modelLower.includes('v-4'));
      const isFlash = modelLower.includes('flash') && (modelLower.includes('v4') || modelLower.includes('v-4'));
      if (!isPro && !isFlash) continue;

      const metrics = extractMetricsFromUsage(usageArrayToMap(entry.usage));
      if (todayEntries.includes(entry) || !models[entry.model]) {
        models[entry.model] = metrics;
      }
    }

    return { today_date: today, models };
  }

  function transformUsageCost(bizData) {
    const today = utcToday();
    let todayCost = 0;
    const modelCosts = {};
    const currency = bizData.currency || 'CNY';

    if (bizData.days) {
      const todayDay = bizData.days.find(d => d.date === today);
      if (todayDay && todayDay.data) {
        for (const entry of todayDay.data) {
          if (entry.usage) {
            let entryCost = 0;
            for (const u of entry.usage) {
              entryCost += Number(u.amount) || 0;
            }
            todayCost += entryCost;
            if (entry.model) {
              const ml = entry.model.toLowerCase();
              const isPro = ml.includes('pro') && (ml.includes('v4') || ml.includes('v-4'));
              const isFlash = ml.includes('flash') && (ml.includes('v4') || ml.includes('v-4'));
              if (isPro || isFlash) {
                modelCosts[entry.model] = (modelCosts[entry.model] || 0) + entryCost;
              }
            }
          }
        }
      }
    }

    return { today_cost: { amount: Math.floor(todayCost * 100) / 100, currency }, model_costs: modelCosts };
  }

  function buildOutputPayload() {
    const summary = rawUserSummary
      ? transformUserSummary(rawUserSummary)
      : { balance: { total: 0, normal_wallet_balance: 0, bonus_wallet_balance: 0, currency: 'CNY' }, monthly_consumption: { amount: 0, currency: 'CNY' } };

    let usageData = { today_date: utcToday(), models: {} };
    if (rawUsageAmount) {
      usageData = transformUsageAmount(rawUsageAmount);
    }

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost) {
      costData = transformUsageCost(rawUsageCost);
    }

    // 将模型费用合并到模型数据中
    if (costData.model_costs && usageData.models) {
      for (const [model, cost] of Object.entries(costData.model_costs)) {
        if (usageData.models[model]) {
          usageData.models[model].cost = Math.floor(cost * 100) / 100;
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      ...summary,
      ...usageData,
      ...costData,
    };
  }

  // ============================================================
  // 每日数据构建
  // ============================================================

  // 从 amount 数据更新每日数据（只关注选定模型）
  function updateDailyDataFromAmount(bizData) {
    if (!bizData || !bizData.days) return;
    for (const day of bizData.days) {
      const date = day.date;
      if (!dailyDataMap.has(date)) {
        dailyDataMap.set(date, { models: {}, totalTokens: 0, totalCost: 0, totalRequests: 0, overallHitRate: null });
      }
      const dayData = dailyDataMap.get(date);
      for (const entry of day.data) {
        if (!entry.model) continue;
        const modelLower = entry.model.toLowerCase();
        const isPro = modelLower.includes('pro') && (modelLower.includes('v4') || modelLower.includes('v-4'));
        const isFlash = modelLower.includes('flash') && (modelLower.includes('v4') || modelLower.includes('v-4'));
        if (!isPro && !isFlash) continue;
        const metrics = extractMetricsFromUsage(usageArrayToMap(entry.usage));
        if (!dayData.models[entry.model]) {
          dayData.models[entry.model] = { tokens: {}, requests: 0, cache_hit_rate: null, cost: 0 };
        }
        dayData.models[entry.model].tokens = metrics.tokens;
        dayData.models[entry.model].requests = metrics.requests;
        dayData.models[entry.model].cache_hit_rate = metrics.cache_hit_rate;
        // 累加总 token 和 总请求
        dayData.totalTokens += metrics.tokens.total || 0;
        dayData.totalRequests += metrics.requests || 0;
      }
    }
  }

  // 从 cost 数据更新每日数据（补充费用信息）
  function updateDailyDataFromCost(bizData) {
    if (!bizData || !bizData.days) return;
    const currency = bizData.currency || 'CNY';
    for (const day of bizData.days) {
      const date = day.date;
      if (!dailyDataMap.has(date)) {
        dailyDataMap.set(date, { models: {}, totalTokens: 0, totalCost: 0, totalRequests: 0, overallHitRate: null });
      }
      const dayData = dailyDataMap.get(date);
      let dayCost = 0;
      for (const entry of day.data) {
        if (!entry.usage) continue;
        let entryCost = 0;
        for (const u of entry.usage) {
          entryCost += Number(u.amount) || 0;
        }
        dayCost += entryCost;
        if (entry.model) {
          const modelLower = entry.model.toLowerCase();
          const isPro = modelLower.includes('pro') && (modelLower.includes('v4') || modelLower.includes('v-4'));
          const isFlash = modelLower.includes('flash') && (modelLower.includes('v4') || modelLower.includes('v-4'));
          if (isPro || isFlash) {
            if (!dayData.models[entry.model]) {
              dayData.models[entry.model] = { tokens: {}, requests: 0, cache_hit_rate: null, cost: 0 };
            }
            dayData.models[entry.model].cost = Math.floor((dayData.models[entry.model].cost || 0) + entryCost * 100) / 100;
          }
        }
      }
      dayData.totalCost = Math.floor(dayCost * 100) / 100;
    }
  }

  // 已主动抓取的月份数据缓存（跨月数据）
  // 结构: Map<monthStr, { amount: bizData, cost: bizData }>
  let fetchedMonthCache = new Map();

  // 综合更新每日数据缓存
  function rebuildDailyData() {
    dailyDataMap.clear();
    if (rawUsageAmount) updateDailyDataFromAmount(rawUsageAmount);
    if (rawUsageCost) updateDailyDataFromCost(rawUsageCost);
    // 合并已抓取的跨月数据
    for (const [monthStr, cache] of fetchedMonthCache.entries()) {
      if (cache.amount) updateDailyDataFromAmount(cache.amount);
      if (cache.cost) updateDailyDataFromCost(cache.cost);
    }
    // 重新计算每条记录的总体命中率（基于模型的总输入）
    for (const [date, dayData] of dailyDataMap.entries()) {
      let totalCached = 0, totalInput = 0;
      for (const model of Object.values(dayData.models)) {
        if (model.tokens) {
          totalCached += model.tokens.cached_input || 0;
          totalInput += (model.tokens.cached_input || 0) + (model.tokens.uncached_input || 0);
        }
      }
      dayData.overallHitRate = totalInput > 0 ? (totalCached / totalInput) * 100 : null;
    }
  }

  // 主动抓取指定月份的数据
  function fetchMonthData(year, month) {
    var monthStr = year + '-' + String(month + 1).padStart(2, '0');
    if (fetchedMonthCache.has(monthStr)) return Promise.resolve(false);
    if (!bearerToken) return Promise.resolve(false);

    var base = window.location.origin;
    var headers = { 'Authorization': 'Bearer ' + bearerToken, 'Accept': 'application/json' };
    var cache = {};

    return Promise.all([
      origFetch(base + '/api/v0/usage/amount?month=' + monthStr, { headers })
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function(json) {
          var data = extractBizData(json);
          if (data) cache.amount = data;
        }).catch(function() { /* 忽略单个请求失败 */ }),
      origFetch(base + '/api/v0/usage/cost?month=' + monthStr, { headers })
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function(json) {
          var data = extractBizData(json);
          if (data) cache.cost = data;
        }).catch(function() { /* 忽略单个请求失败 */ })
    ]).then(function() {
      if (cache.amount || cache.cost) {
        fetchedMonthCache.set(monthStr, cache);
        rebuildDailyData();
        return true;
      }
      return false;
    });
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
        } catch (e) { /* 忽略 */ }
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
  // 数据接收
  // ============================================================
  function processApiResponse(endpoint, bizData) {
    switch (endpoint) {
    case 'get_user_summary': rawUserSummary = bizData; break;
    case 'usage_amount': rawUsageAmount = bizData; break;
    case 'usage_cost': rawUsageCost = bizData; break;
    }
    // 每次收到新数据，重新构建每日缓存
    rebuildDailyData();
    const payload = buildOutputPayload();
    if (payload) {
      if (currentView === 'today') {
        updatePanelData(payload);
        updateSummaryBar(payload);
      } else if (selectedDate && dailyDataMap.has(selectedDate)) {
        showDateDetail(selectedDate);
      } else {
        // 如果当前视图是某日期但数据消失，回退今日
        currentView = 'today';
        selectedDate = null;
        updatePanelData(payload);
        updateSummaryBar(payload);
      }
    }
  }

  // ============================================================
  // 格式化数字
  // ============================================================
  function fmtNumShort(n) {
    if (n === undefined || n === null) return '—';
    if (typeof n === 'number') {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return n.toLocaleString();
    }
    return String(n);
  }

  function fmtNumRaw(n) {
    if (n === undefined || n === null) return '—';
    if (typeof n === 'number') return n.toLocaleString();
    return String(n);
  }

  function makeToggleValue(n) {
    const span = document.createElement('span');
    span.className = 'ds-val-toggle';
    span.setAttribute('data-short', fmtNumShort(n));
    span.setAttribute('data-raw', fmtNumRaw(n));
    span.textContent = fmtNumShort(n);
    span.style.cursor = 'pointer';
    span.title = '点击查看原始数字';
    return span;
  }

  function fmtMoney(n) {
    if (n === undefined || n === null) return '—';
    const val = Math.floor(Number(n) * 100) / 100;
    return '￥' + val.toFixed(2);
  }

  function fmtPercent(n) {
    if (n === undefined || n === null || n === '') return '—';
    return Number(n).toFixed(1) + '%';
  }

  // ============================================================
  // 主题管理
  // ============================================================
  const THEME_KEY = 'ds_monitor_theme';

  const darkThemeStyle = `
    #ds-monitor-panel {
      background: rgba(30, 30, 46, 0.92);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255,255,255,0.1);
      color: #cdd6f4;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.05);
    }
    .ds-titlebar { border-bottom: 1px solid rgba(255,255,255,0.06); }
    .ds-title { color: #e5e5e5; }
    .ds-title-models { color: #6c7086; }
    .ds-btn { color: #6c7086; }
    .ds-btn:hover { background: rgba(255,255,255,0.08); color: #cdd6f4; }
    .ds-acct-label { color: #6c7086; }
    .ds-acct-value { color: #cdd6f4; }
    .ds-acct-value.accent { background: linear-gradient(135deg, #89b4fa, #a6e3a1); -webkit-background-clip: text; background-clip: text; }
    .ds-acct-unit { color: #585b70; }
    .ds-section-gap { background: rgba(255,255,255,0.06); }
    .ds-model-block { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.04); }
    .ds-model-id { color: #fab387; }
    .ds-model-sep { background: rgba(255,255,255,0.04); }
    .ds-metric-val { color: #cdd6f4; }
    .ds-metric-val.green { color: #a6e3a1; }
    .ds-metric-val.yellow { color: #f9e2af; }
    .ds-metric-lbl { color: #6c7086; }
    .ds-cache-row { border-top: 1px solid rgba(255,255,255,0.04); }
    .ds-cache-label { color: #6c7086; }
    .ds-cache-track { background: rgba(255,255,255,0.06); }
    .ds-cache-fill { background: linear-gradient(90deg, #89b4fa, #a6e3a1); }
    .ds-cache-pct { color: #a6e3a1; }
    .ds-summary-bar { background: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); color: #6c7086; }
    .ds-sum-val { color: #a6adc8; }
    .ds-summary-dot { background: #45475a; }
    .ds-no-data { color: #585b70; }
    #ds-monitor-panel.ds-collapsed .ds-body,
    #ds-monitor-panel.ds-collapsed .ds-summary-bar { display: none; }
    .ds-calendar { background: rgba(30, 30, 46, 0.96); border: 1px solid rgba(255,255,255,0.1); }
    .ds-calendar th { color: #6c7086; }
    .ds-calendar-day { color: #cdd6f4; }
    .ds-calendar-day.other-month { color: #585b70; }
    .ds-calendar-day.has-data { background: rgba(137, 180, 250, 0.2); border-radius: 4px; font-weight: 600; }
    .ds-calendar-day.selected { background: #89b4fa; color: #1e1e2e; border-radius: 4px; }
    .ds-calendar-day:hover { background: rgba(137, 180, 250, 0.4); border-radius: 4px; }
    .ds-calendar-day.today { box-shadow: inset 0 0 0 1.5px #89b4fa; }
    .ds-calendar-cost { display: block; font-size: 8px; line-height: 1.1; opacity: 0.65; margin-top: 0px; }
    .ds-calendar-today-btn { font-size: 11px; color: #89b4fa; cursor: pointer; background: none; border: none; padding: 2px 6px; border-radius: 3px; }
    .ds-calendar-today-btn:hover { background: rgba(137, 180, 250, 0.2); }
    .ds-calendar-tooltip { position: absolute; display: none; background: rgba(30,30,46,0.96); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 6px 10px; font-size: 11px; line-height: 1.5; z-index: 100001; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.4); white-space: nowrap; }
    .ds-calendar-tooltip .ds-tt-row { display: flex; justify-content: space-between; gap: 12px; }
    .ds-calendar-tooltip .ds-tt-label { opacity: 0.6; }
    .ds-calendar-tooltip .ds-tt-val { font-weight: 600; }
    .ds-calendar-summary { margin-top: 6px; padding: 5px 4px 2px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; opacity: 0.7; }
    .ds-calendar-summary b { opacity: 0.9; }
    @keyframes ds-calendar-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .ds-calendar { animation: ds-calendar-in 0.15s ease-out; }
    .ds-calendar-day { transition: background 0.12s, color 0.12s, transform 0.12s; }
  `;

  const lightThemeStyle = `
    #ds-monitor-panel {
      background: rgba(245, 245, 250, 0.96);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(0,0,0,0.1);
      color: #1e1e2e;
      box-shadow: 0 12px 40px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.05);
    }
    .ds-titlebar { border-bottom: 1px solid rgba(0,0,0,0.08); }
    .ds-title { color: #1e1e2e; }
    .ds-title-models { color: #7c7f8a; }
    .ds-btn { color: #7c7f8a; }
    .ds-btn:hover { background: rgba(0,0,0,0.05); color: #1e1e2e; }
    .ds-acct-label { color: #7c7f8a; }
    .ds-acct-value { color: #1e1e2e; }
    .ds-acct-value.accent { background: linear-gradient(135deg, #1e66f5, #40a02b); -webkit-background-clip: text; background-clip: text; }
    .ds-acct-unit { color: #9ca0b0; }
    .ds-section-gap { background: rgba(0,0,0,0.08); }
    .ds-model-block { background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.06); }
    .ds-model-id { color: #d4611a; }
    .ds-model-sep { background: rgba(0,0,0,0.06); }
    .ds-metric-val { color: #1e1e2e; }
    .ds-metric-val.green { color: #2e7d32; }
    .ds-metric-val.yellow { color: #b95b0a; }
    .ds-metric-lbl { color: #7c7f8a; }
    .ds-cache-row { border-top: 1px solid rgba(0,0,0,0.08); }
    .ds-cache-label { color: #7c7f8a; }
    .ds-cache-track { background: rgba(0,0,0,0.08); }
    .ds-cache-fill { background: linear-gradient(90deg, #1e66f5, #40a02b); }
    .ds-cache-pct { color: #40a02b; }
    .ds-summary-bar { background: rgba(0,0,0,0.03); border-top: 1px solid rgba(0,0,0,0.08); color: #7c7f8a; }
    .ds-sum-val { color: #1e1e2e; }
    .ds-summary-dot { background: #c0c2ce; }
    .ds-no-data { color: #9ca0b0; }
    #ds-monitor-panel.ds-collapsed .ds-body,
    #ds-monitor-panel.ds-collapsed .ds-summary-bar { display: none; }
    .ds-calendar { background: rgba(245, 245, 250, 0.96); border: 1px solid rgba(0,0,0,0.1); }
    .ds-calendar th { color: #7c7f8a; }
    .ds-calendar-day { color: #1e1e2e; }
    .ds-calendar-day.other-month { color: #9ca0b0; }
    .ds-calendar-day.has-data { background: rgba(30, 102, 245, 0.15); border-radius: 4px; font-weight: 600; }
    .ds-calendar-day.selected { background: #1e66f5; color: #ffffff; border-radius: 4px; }
    .ds-calendar-day:hover { background: rgba(30, 102, 245, 0.3); border-radius: 4px; }
    .ds-calendar-day.today { box-shadow: inset 0 0 0 1.5px #1e66f5; }
    .ds-calendar-cost { display: block; font-size: 8px; line-height: 1.1; opacity: 0.6; margin-top: 0px; }
    .ds-calendar-today-btn { font-size: 11px; color: #1e66f5; cursor: pointer; background: none; border: none; padding: 2px 6px; border-radius: 3px; }
    .ds-calendar-today-btn:hover { background: rgba(30, 102, 245, 0.12); }
    .ds-calendar-tooltip { position: absolute; display: none; background: rgba(245,245,250,0.97); border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; padding: 6px 10px; font-size: 11px; line-height: 1.5; z-index: 100001; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.12); white-space: nowrap; }
    .ds-calendar-tooltip .ds-tt-row { display: flex; justify-content: space-between; gap: 12px; }
    .ds-calendar-tooltip .ds-tt-label { opacity: 0.55; }
    .ds-calendar-tooltip .ds-tt-val { font-weight: 600; }
    .ds-calendar-summary { margin-top: 6px; padding: 5px 4px 2px; border-top: 1px solid rgba(0,0,0,0.08); font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; opacity: 0.65; }
    .ds-calendar-summary b { opacity: 0.85; }
    @keyframes ds-calendar-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .ds-calendar { animation: ds-calendar-in 0.15s ease-out; }
    .ds-calendar-day { transition: background 0.12s, color 0.12s, transform 0.12s; }
  `;

  let currentTheme = 'dark';

  function loadTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') currentTheme = saved;
      else currentTheme = 'dark';
    } catch { /* 忽略 */ }
    return currentTheme;
  }

  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* 忽略 */ }
  }

  function applyTheme(styleElement) {
    if (!styleElement) return;
    styleElement.textContent = currentTheme === 'dark' ? darkThemeStyle : lightThemeStyle;
  }

  // ============================================================
  // 面板 & 日历
  // ============================================================
  const PANEL_POS_KEY = 'ds_monitor_panel_pos';

  function loadPanelPos() {
    try {
      const saved = localStorage.getItem(PANEL_POS_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        if (pos.left !== null && pos.left !== undefined) {
          pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - 40));
        }
        pos.top = Math.max(0, Math.min(pos.top || 60, window.innerHeight - 60));
        if (pos.theme) currentTheme = pos.theme;
        return pos;
      }
    } catch { /* 忽略 */ }
    return { top: 60, left: null, right: 12, width: 320, collapsed: false };
  }

  function savePanelPos(pos) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos)); } catch { /* 忽略 */ }
  }

  let panelPos = loadPanelPos();
  let lastPayload = null;

  // 日历浮层相关
  let calendarOverlay = null;
  let currentCalendarYear = new Date().getFullYear();
  let currentCalendarMonth = new Date().getMonth(); // 0-11

  // 显示某个日期的详情
  function showDateDetail(dateStr) {
    const dayData = dailyDataMap.get(dateStr);
    if (!dayData) return;
    selectedDate = dateStr;
    currentView = 'date';
    // 构建一个模拟的 payload 用于展示
    const mockPayload = {
      timestamp: new Date().toISOString(),
      balance: rawUserSummary ? transformUserSummary(rawUserSummary).balance : { total: 0, currency: 'CNY' },
      monthly_consumption: rawUserSummary ? transformUserSummary(rawUserSummary).monthly_consumption : { amount: 0, currency: 'CNY' },
      today_date: dateStr,
      models: dayData.models,
      today_cost: { amount: dayData.totalCost, currency: (rawUserSummary && rawUserSummary.balance && rawUserSummary.balance.currency) || 'CNY' }
    };
    // 为每个模型补充 cost（如果缺失）
    for (const modelName of Object.keys(mockPayload.models)) {
      if (mockPayload.models[modelName].cost === undefined) mockPayload.models[modelName].cost = 0;
    }
    updatePanelData(mockPayload);
    updateSummaryBar(mockPayload);
    // 显示返回今日按钮
    const backBtn = document.getElementById('ds-back-today');
    if (backBtn) backBtn.style.display = 'flex';
  }

  function resetToToday() {
    currentView = 'today';
    selectedDate = null;
    const payload = buildOutputPayload();
    if (payload) {
      updatePanelData(payload);
      updateSummaryBar(payload);
    }
    const backBtn = document.getElementById('ds-back-today');
    if (backBtn) backBtn.style.display = 'none';
  }

  // 生成日历网格
  function renderCalendar(container, year, month) {
    const firstDay = new Date(year, month, 1);
    const startDayOfWeek = firstDay.getDay(); // 0周日
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const days = [];
    // 上个月末尾
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const dayNum = prevMonthDays - i;
      days.push({ date: new Date(year, month - 1, dayNum), isCurrentMonth: false });
    }
    // 本月
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    }
    // 补全6行
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false });
    }

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '12px';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    ['日', '一', '二', '三', '四', '五', '六'].forEach(day => {
      const th = document.createElement('th');
      th.textContent = day;
      th.style.padding = '6px 0';
      th.style.fontWeight = '500';
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let i = 0; i < days.length; i += 7) {
      const row = document.createElement('tr');
      for (let j = 0; j < 7; j++) {
        const cell = days[i + j];
        const td = document.createElement('td');
        td.style.textAlign = 'center';
        td.style.padding = '2px 0';
        const daySpan = document.createElement('span');
        daySpan.textContent = cell.date.getDate();
        daySpan.className = 'ds-calendar-day';
        if (!cell.isCurrentMonth) daySpan.classList.add('other-month');
        const dateStr = cell.date.toISOString().slice(0, 10);
        if (dailyDataMap.has(dateStr) && cell.isCurrentMonth) {
          daySpan.classList.add('has-data');
        }
        if (selectedDate === dateStr && cell.isCurrentMonth) {
          daySpan.classList.add('selected');
        }
        if (dateStr === utcToday() && cell.isCurrentMonth) {
          daySpan.classList.add('today');
        }
        daySpan.style.cursor = 'pointer';
        daySpan.style.display = 'inline-block';
        daySpan.style.padding = '4px 6px';
        daySpan.style.width = '28px';
        daySpan.style.textAlign = 'center';
        daySpan.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cell.isCurrentMonth) {
            showDateDetail(dateStr);
            closeCalendar();
          }
        });
        td.appendChild(daySpan);
        if (cell.isCurrentMonth && dailyDataMap.has(dateStr)) {
          const dayData = dailyDataMap.get(dateStr);
          const costEl = document.createElement('span');
          costEl.className = 'ds-calendar-cost';
          const amt = dayData.totalCost || 0;
          costEl.textContent = amt < 100 ? amt.toFixed(1) : Math.round(amt).toString();
          td.appendChild(costEl);
          daySpan.addEventListener('mouseenter', (e) => { showCalendarTooltip(e, dayData); });
          daySpan.addEventListener('mouseleave', () => { hideCalendarTooltip(); });
        }
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  let calendarTooltip = null;

  function showCalendarTooltip(event, dayData) {
    const overlay = calendarOverlay;
    if (!overlay) return;
    if (!calendarTooltip) {
      calendarTooltip = document.createElement('div');
      calendarTooltip.id = 'ds-calendar-tooltip';
      calendarTooltip.className = 'ds-calendar-tooltip';
      overlay.appendChild(calendarTooltip);
    }
    const cost = dayData.totalCost || 0;
    const tokens = dayData.totalTokens || 0;
    const requests = dayData.totalRequests || 0;
    const hitRate = dayData.overallHitRate;
    calendarTooltip.innerHTML =
      '<div class="ds-tt-row"><span class="ds-tt-label">费用</span><span class="ds-tt-val">' + fmtMoney(cost) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Token</span><span class="ds-tt-val">' + fmtNumShort(tokens) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">请求</span><span class="ds-tt-val">' + requests.toLocaleString() + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">缓存命中</span><span class="ds-tt-val">' + (hitRate !== null ? hitRate.toFixed(0) + '%' : '—') + '</span></div>';
    calendarTooltip.style.display = 'block';

    const cell = event.target;
    const cellRect = cell.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const ttHeight = calendarTooltip.offsetHeight || 60;
    const ttWidth = calendarTooltip.offsetWidth || 140;

    let top = cellRect.top - overlayRect.top - ttHeight - 4;
    if (top < 4) {
      top = cellRect.bottom - overlayRect.top + 4;
    }
    let left = cellRect.left - overlayRect.left + cellRect.width / 2;
    left = Math.max(4, Math.min(left, overlayRect.width - ttWidth - 4));

    calendarTooltip.style.top = top + 'px';
    calendarTooltip.style.left = left + 'px';
    calendarTooltip.style.transform = 'translateX(-50%)';
  }

  function hideCalendarTooltip() {
    if (calendarTooltip) calendarTooltip.style.display = 'none';
  }

  function buildMonthlySummary(year, month) {
    let totalCost = 0, totalTokens = 0, totalRequests = 0, dayCount = 0;
    for (const [dateStr, dayData] of dailyDataMap.entries()) {
      const parts = dateStr.split('-');
      if (parseInt(parts[0]) === year && parseInt(parts[1]) - 1 === month) {
        totalCost += dayData.totalCost || 0;
        totalTokens += dayData.totalTokens || 0;
        totalRequests += dayData.totalRequests || 0;
        dayCount++;
      }
    }
    const div = document.createElement('div');
    div.className = 'ds-calendar-summary';
    const unit = rawUserSummary ? (transformUserSummary(rawUserSummary).balance.currency === 'CNY' ? '￥' : '$') : '￥';
    div.innerHTML =
      '<span>(' + (month + 1) + '月) 合计</span>' +
      '<span>费用 <b>' + unit + totalCost.toFixed(2) + '</b></span>' +
      '<span>Token <b>' + fmtNumShort(totalTokens) + '</b></span>' +
      '<span>请求 <b>' + totalRequests.toLocaleString() + '</b></span>' +
      '<span>天数 ' + dayCount + '</span>';
    return div;
  }

  function createCalendarOverlay() {
    if (calendarOverlay) return;
    const overlay = document.createElement('div');
    overlay.id = 'ds-calendar-overlay';
    overlay.style.cssText = `
      position: fixed;
      z-index: 100000;
      background: inherit;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
      padding: 12px;
      min-width: 296px;
      font-family: inherit;
      max-height: 80vh;
      overflow-y: auto;
      overscroll-behavior: contain;
    `;
    overlay.className = 'ds-calendar';
    document.body.appendChild(overlay);
    calendarOverlay = overlay;
    // 点击其他地方关闭
    document.addEventListener('click', function closeCalendarOnClickOutside(e) {
      if (calendarOverlay && !calendarOverlay.contains(e.target) && !e.target.closest('#ds-calendar-btn')) {
        closeCalendar();
        document.removeEventListener('click', closeCalendarOnClickOutside);
      }
    });
  }

  function showCalendar(anchorElement) {
    if (!calendarOverlay) createCalendarOverlay();
    const rect = anchorElement.getBoundingClientRect();
    calendarOverlay.style.top = (rect.bottom + 5) + 'px';
    calendarOverlay.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    calendarOverlay.style.display = 'block';
    // 重新渲染内容
    calendarOverlay.innerHTML = '';
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '12px';
    header.style.padding = '0 4px';
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '◀';
    prevBtn.className = 'ds-btn';
    prevBtn.style.width = '28px';
    prevBtn.style.height = '28px';
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentCalendarMonth--;
      if (currentCalendarMonth < 0) {
        currentCalendarMonth = 11;
        currentCalendarYear--;
      }
      var _y = currentCalendarYear, _m = currentCalendarMonth;
      fetchMonthData(_y, _m).then(function() { renderCalendarContent(); }).catch(function() { renderCalendarContent(); });
    });
    const monthYear = document.createElement('span');
    monthYear.style.fontWeight = '600';
    monthYear.style.fontSize = '13px';
    const updateMonthYear = () => {
      monthYear.textContent = `${currentCalendarYear}年 ${currentCalendarMonth + 1}月`;
    };
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '▶';
    nextBtn.className = 'ds-btn';
    nextBtn.style.width = '28px';
    nextBtn.style.height = '28px';
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentCalendarMonth++;
      if (currentCalendarMonth > 11) {
        currentCalendarMonth = 0;
        currentCalendarYear++;
      }
      var _y = currentCalendarYear, _m = currentCalendarMonth;
      fetchMonthData(_y, _m).then(function() { renderCalendarContent(); }).catch(function() { renderCalendarContent(); });
    });
    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.alignItems = 'center';
    leftGroup.style.gap = '2px';
    leftGroup.appendChild(prevBtn);
    const todayBtn = document.createElement('button');
    todayBtn.textContent = '今天';
    todayBtn.className = 'ds-calendar-today-btn';
    todayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const now = new Date();
      currentCalendarYear = now.getFullYear();
      currentCalendarMonth = now.getMonth();
      var _y = currentCalendarYear, _m = currentCalendarMonth;
      fetchMonthData(_y, _m).then(function() { renderCalendarContent(); }).catch(function() { renderCalendarContent(); });
    });
    leftGroup.appendChild(todayBtn);
    header.appendChild(leftGroup);
    header.appendChild(monthYear);
    header.appendChild(nextBtn);
    calendarOverlay.appendChild(header);
    const calendarContainer = document.createElement('div');
    calendarContainer.id = 'ds-calendar-grid';
    calendarOverlay.appendChild(calendarContainer);
    const renderCalendarContent = () => {
      calendarContainer.innerHTML = '';
      updateMonthYear();
      renderCalendar(calendarContainer, currentCalendarYear, currentCalendarMonth);
      const summary = buildMonthlySummary(currentCalendarYear, currentCalendarMonth);
      calendarContainer.appendChild(summary);
    };
    renderCalendarContent();
  }

  function closeCalendar() {
    if (calendarOverlay) calendarOverlay.style.display = 'none';
  }

  // ============================================================
  // 面板构建（原有 + 日历按钮 + 返回今日按钮）
  // ============================================================

  function injectPanel() {
    loadTheme();
    const pos = panelPos;
    const panel = document.createElement('div');
    panel.id = 'ds-monitor-panel';

    let styleLeft = '', styleRight = '';
    if (pos.left !== null && pos.left !== undefined) {
      styleLeft = 'left: ' + pos.left + 'px;';
    } else {
      styleRight = 'right: ' + (pos.right || 12) + 'px;';
    }
    panel.style.cssText = 'top: ' + (pos.top || 60) + 'px;' + styleLeft + styleRight +
      'width: ' + (pos.width || 320) + 'px;';

    panel.innerHTML = `
      <style id="ds-monitor-theme-style"></style>
      <style>
        #ds-monitor-panel {
          position: fixed; z-index: 99999;
          font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif;
          font-size: 12px;
          border-radius: 12px;
          display: flex; flex-direction: column; overflow: hidden;
          user-select: none; min-width: 280px;
          transition: background 0.2s, color 0.2s, border-color 0.2s;
        }
        .ds-titlebar {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 14px;
          cursor: move; flex-shrink: 0;
        }
        .ds-titlebar-left { display: flex; align-items: baseline; gap: 4px; }
        .ds-title { font-size: 13px; font-weight: 600; }
        .ds-title-models { font-size: 11px; font-family: 'SF Mono', 'Menlo', monospace; }
        .ds-titlebar-actions { display: flex; align-items: center; gap: 2px; }
        .ds-btn {
          width: 26px; height: 26px; border: none; background: none;
          cursor: pointer; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; transition: all 0.15s;
        }
        .ds-body { padding: 0; flex: 1 1 auto; min-height: 0; }
        .ds-account-overview { padding: 10px 14px; display: flex; gap: 10px; }
        .ds-acct-item { flex: 1; text-align: center; }
        .ds-acct-label {
          font-size: 9px; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 2px;
        }
        .ds-acct-value {
          font-size: 20px; font-weight: 700;
          font-variant-numeric: tabular-nums; line-height: 1;
        }
        .ds-acct-value.accent {
          -webkit-background-clip: text;
          background-clip: text;
        }
        .ds-acct-unit { font-size: 10px; margin-top: 2px; }
        .ds-section-gap { height: 1px; margin: 0 14px; }
        .ds-model-section { padding: 12px 14px; }
        .ds-model-block { border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
        .ds-model-block:last-child { margin-bottom: 0; }
        .ds-model-row {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .ds-model-id { font-size: 12px; font-weight: 600; font-family: 'SF Mono', 'Menlo', monospace; }
        .ds-model-sep { height: 1px; margin-bottom: 8px; }
        .ds-metrics {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          gap: 6px 0;
        }
        .ds-metric { display: flex; flex-direction: column; align-items: center; }
        .ds-metric-val { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
        .ds-metric-lbl { font-size: 9px; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
        .ds-cache-row {
          margin-top: 8px; padding-top: 8px;
          display: flex; align-items: center; gap: 8px;
        }
        .ds-cache-label { font-size: 10px; white-space: nowrap; }
        .ds-cache-track { flex: 1; height: 3px; border-radius: 2px; overflow: hidden; }
        .ds-cache-fill { height: 100%; border-radius: 2px; }
        .ds-cache-pct { font-size: 11px; font-weight: 600; min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
        .ds-summary-bar {
          display: flex; align-items: center; justify-content: center;
          gap: 14px; padding: 10px 14px;
          font-size: 11px;
        }
        .ds-sum-val { font-weight: 500; font-variant-numeric: tabular-nums; }
        .ds-summary-dot { width: 3px; height: 3px; border-radius: 50%; }
        .ds-no-data { text-align: center; padding: 20px 0; font-size: 12px; }
        .ds-val-toggle { font-variant-numeric: tabular-nums; }
        .ds-back-today {
          display: flex; justify-content: center; padding: 6px 14px 10px;
        }
        .ds-back-btn {
          background: rgba(137, 180, 250, 0.2);
          border: none;
          border-radius: 20px;
          padding: 4px 12px;
          font-size: 11px;
          cursor: pointer;
          color: inherit;
        }
        .ds-back-btn:hover { background: rgba(137, 180, 250, 0.4); }
        .ds-calendar {
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
        }
      </style>
      <div class="ds-titlebar" id="ds-titlebar">
        <div class="ds-titlebar-left">
          <span class="ds-title">用量监控</span>
          <span class="ds-title-models">· DeepSeek</span>
        </div>
        <div class="ds-titlebar-actions">
          <button class="ds-btn" id="ds-calendar-btn" title="查看历史用量">📅</button>
          <button class="ds-btn" id="ds-theme-btn" title="切换主题">🌓</button>
          <button class="ds-btn" id="ds-collapse-btn" title="收起/展开">${pos.collapsed ? '▶' : '▼'}</button>
        </div>
      </div>
      <div class="ds-body" id="ds-body">
        <div class="ds-account-overview">
          <div class="ds-acct-item">
            <div class="ds-acct-label">余额</div>
            <div class="ds-acct-value" id="ds-balance">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
          <div class="ds-acct-item">
            <div class="ds-acct-label">本月消费</div>
            <div class="ds-acct-value" id="ds-monthly-cost">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
          <div class="ds-acct-item">
            <div class="ds-acct-label">今日消费</div>
            <div class="ds-acct-value accent" id="ds-today-cost">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
        </div>
        <div class="ds-section-gap"></div>
        <div class="ds-model-section" id="ds-model-section">
          <div class="ds-no-data" id="ds-no-data">等待数据…</div>
        </div>
      </div>
      <div class="ds-summary-bar" id="ds-summary-bar" style="display:none;">
        <span>总 Token <span class="ds-sum-val" id="ds-sum-tokens">—</span></span>
        <span class="ds-summary-dot"></span>
        <span>总请求 <span class="ds-sum-val" id="ds-sum-requests">—</span></span>
        <span class="ds-summary-dot"></span>
        <span>命中率 <span class="ds-sum-val" id="ds-sum-hitrate">—</span></span>
      </div>
      <div class="ds-back-today" id="ds-back-today" style="display:none;">
        <button class="ds-back-btn" id="ds-back-today-btn">← 返回今日</button>
      </div>
    `;
    document.body.appendChild(panel);

    const themeStyleTag = document.getElementById('ds-monitor-theme-style');
    if (themeStyleTag) applyTheme(themeStyleTag);

    if (pos.collapsed) panel.classList.add('ds-collapsed');

    if (lastPayload) {
      if (currentView === 'today') {
        updatePanelData(lastPayload);
        updateSummaryBar(lastPayload);
      } else if (selectedDate && dailyDataMap.has(selectedDate)) {
        showDateDetail(selectedDate);
      }
    }

    // --- 拖拽 (修复：使用 closest 避免干扰按钮) ---
    const titleBar = document.getElementById('ds-titlebar');
    let dragInfo = null;
    titleBar.addEventListener('mousedown', (e) => {
      // 如果点击的是任何按钮或其内部元素，不启动拖拽
      if (e.target.closest('.ds-btn')) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      dragInfo = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
      panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragInfo) return;
      const dx = e.clientX - dragInfo.startX;
      const dy = e.clientY - dragInfo.startY;
      panel.style.left = (dragInfo.startLeft + dx) + 'px';
      panel.style.right = 'auto';
      panel.style.top = Math.max(0, dragInfo.startTop + dy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragInfo) return;
      dragInfo = null;
      panel.style.transition = '';
      const rect = panel.getBoundingClientRect();
      const w = rect.width;
      panelPos.top = Math.max(0, Math.min(rect.top, window.innerHeight - 60));
      panelPos.left = Math.max(-w + 40, Math.min(rect.left, window.innerWidth - 40));
      panelPos.right = null;
      panel.style.top = panelPos.top + 'px';
      panel.style.left = panelPos.left + 'px';
      savePanelPos(panelPos);
    });

    // --- 折叠/展开 (确保事件绑定正确) ---
    const collapseBtn = document.getElementById('ds-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = panel.classList.toggle('ds-collapsed');
        collapseBtn.textContent = collapsed ? '▶' : '▼';
        panelPos.collapsed = collapsed;
        savePanelPos(panelPos);
      });
    } else {
      console.error('[DS 监控] 折叠按钮未找到');
    }

    // --- 主题切换 ---
    const themeBtn = document.getElementById('ds-theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        saveTheme(currentTheme);
        if (themeStyleTag) applyTheme(themeStyleTag);
        panelPos.theme = currentTheme;
        savePanelPos(panelPos);
      });
    }

    // --- 日历按钮 ---
    const calendarBtn = document.getElementById('ds-calendar-btn');
    if (calendarBtn) {
      calendarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (calendarOverlay && calendarOverlay.style.display === 'block') {
          closeCalendar();
        } else {
          showCalendar(calendarBtn);
        }
      });
    }

    // --- 返回今日 ---
    const backTodayBtn = document.getElementById('ds-back-today-btn');
    if (backTodayBtn) {
      backTodayBtn.addEventListener('click', () => {
        resetToToday();
      });
    }

    // --- 点击切换原始数字 (代理)---
    panel.addEventListener('click', (e) => {
      const span = e.target.closest('[data-short]');
      if (!span) return;
      const showing = span.textContent === span.getAttribute('data-raw');
      span.textContent = showing
        ? span.getAttribute('data-short')
        : span.getAttribute('data-raw');
    });
  }

  // 更新面板数据（复用原有逻辑，但调整了今日消费的显示）
  function updatePanelData(payload) {
    const modelSection = document.getElementById('ds-model-section');
    const noDataEl = document.getElementById('ds-no-data');
    const todayCostEl = document.getElementById('ds-today-cost');
    const monthlyCostEl = document.getElementById('ds-monthly-cost');
    const balanceEl = document.getElementById('ds-balance');

    if (!modelSection) {
      lastPayload = payload;
      return;
    }

    if (!payload || !payload.timestamp) {
      if (noDataEl) noDataEl.style.display = '';
      return;
    }

    const balance = payload.balance || {};
    const monthly = payload.monthly_consumption || {};
    const todayCost = payload.today_cost || {};
    const currency = balance.currency || 'CNY';

    if (todayCostEl) todayCostEl.textContent = fmtMoney(todayCost.amount);
    if (monthlyCostEl) monthlyCostEl.textContent = fmtMoney(monthly.amount);
    if (balanceEl) balanceEl.textContent = fmtMoney(balance.total);

    const units = document.querySelectorAll('.ds-acct-unit');
    units.forEach(u => { u.textContent = currency; });

    if (noDataEl) noDataEl.style.display = 'none';

    const existingBlocks = modelSection.querySelectorAll('.ds-model-block');
    existingBlocks.forEach(b => b.remove());

    const models = payload.models || {};
    const modelNames = Object.keys(models);

    if (modelNames.length === 0) {
      if (noDataEl) noDataEl.style.display = '';
      return;
    }

    for (const name of modelNames) {
      const m = models[name];
      const mLower = name.toLowerCase();
      let shortName = name;
      if (mLower.includes('flash')) shortName = 'deepseek-v4-flash';
      else if (mLower.includes('pro')) shortName = 'deepseek-v4-pro';

      const block = document.createElement('div');
      block.className = 'ds-model-block';

      const modelRow = document.createElement('div');
      modelRow.className = 'ds-model-row';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'ds-model-id';
      nameSpan.textContent = shortName;
      modelRow.appendChild(nameSpan);
      block.appendChild(modelRow);

      const modelSep = document.createElement('div');
      modelSep.className = 'ds-model-sep';
      block.appendChild(modelSep);

      const metricsGrid = document.createElement('div');
      metricsGrid.className = 'ds-metrics';
      const tokens = m.tokens || {};

      metricsGrid.appendChild(makeToggleMetric(tokens.total, '总计'));
      metricsGrid.appendChild(makeToggleMetric(m.cost, '费用', '', true));
      metricsGrid.appendChild(makeToggleMetric(m.requests, '请求次数'));
      metricsGrid.appendChild(makeToggleMetric(tokens.cached_input, '缓存命中', 'green'));
      metricsGrid.appendChild(makeToggleMetric(tokens.uncached_input, '未命中'));
      metricsGrid.appendChild(makeToggleMetric(tokens.output, '输出'));

      block.appendChild(metricsGrid);

      if (m.cache_hit_rate !== null && m.cache_hit_rate !== undefined) {
        const cacheRow = document.createElement('div');
        cacheRow.className = 'ds-cache-row';
        const cacheLabel = document.createElement('span');
        cacheLabel.className = 'ds-cache-label';
        cacheLabel.textContent = '缓存命中';
        const cacheTrack = document.createElement('div');
        cacheTrack.className = 'ds-cache-track';
        const cacheFill = document.createElement('div');
        cacheFill.className = 'ds-cache-fill';
        cacheFill.style.width = Math.min(100, Math.max(0, m.cache_hit_rate)) + '%';
        cacheTrack.appendChild(cacheFill);
        const cachePct = document.createElement('span');
        cachePct.className = 'ds-cache-pct';
        cachePct.textContent = fmtPercent(m.cache_hit_rate);
        cacheRow.appendChild(cacheLabel);
        cacheRow.appendChild(cacheTrack);
        cacheRow.appendChild(cachePct);
        block.appendChild(cacheRow);
      }
      modelSection.appendChild(block);
    }
  }

  function makeToggleMetric(n, labelText, extraClass, isMoney) {
    const metric = document.createElement('div');
    metric.className = 'ds-metric';
    const val = document.createElement('span');
    val.className = 'ds-metric-val';
    if (extraClass) val.classList.add(extraClass);
    if (n !== undefined && n !== null && typeof n === 'number') {
      if (isMoney) {
        val.textContent = '￥' + n.toFixed(2);
      } else {
        val.setAttribute('data-short', fmtNumShort(n));
        val.setAttribute('data-raw', fmtNumRaw(n));
        val.textContent = fmtNumShort(n);
        val.style.cursor = 'pointer';
        val.title = '点击查看原始数字';
      }
    } else {
      val.textContent = '—';
    }
    const lbl = document.createElement('span');
    lbl.className = 'ds-metric-lbl';
    lbl.textContent = labelText;
    metric.appendChild(val);
    metric.appendChild(lbl);
    return metric;
  }

  function updateSummaryBar(payload) {
    const bar = document.getElementById('ds-summary-bar');
    const sumTokens = document.getElementById('ds-sum-tokens');
    const sumRequests = document.getElementById('ds-sum-requests');
    const sumHitrate = document.getElementById('ds-sum-hitrate');
    if (!bar || !payload) return;
    const models = payload.models || {};
    const modelNames = Object.keys(models);
    if (modelNames.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    let totalTokens = 0, totalRequests = 0, totalCached = 0, totalInput = 0;
    for (const name of modelNames) {
      const m = models[name];
      totalRequests += m.requests || 0;
      if (m.tokens) {
        totalTokens += m.tokens.total || 0;
        totalCached += m.tokens.cached_input || 0;
        totalInput += (m.tokens.cached_input || 0) + (m.tokens.uncached_input || 0);
      }
    }
    const overallHitRate = totalInput > 0 ? (totalCached / totalInput) * 100 : null;
    if (sumTokens) sumTokens.textContent = fmtNumShort(totalTokens);
    if (sumRequests) sumRequests.textContent = totalRequests.toLocaleString();
    if (sumHitrate) sumHitrate.textContent = overallHitRate !== null ? fmtPercent(overallHitRate) : '—';
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek 用量监控已加载（纯本地模式，支持日历）');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(injectPanel, 500);
      });
    } else {
      setTimeout(injectPanel, 500);
    }
  }

  init();
})();