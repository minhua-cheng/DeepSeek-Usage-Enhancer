// Based on deepseek-usage-monitor.js by Jmkwang
// ==UserScript==
// @name         DeepSeek 每日用量监控
// @namespace    https://github.com/local/deepseek-usage-monitor
// @version      1.5.0
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
  let rawUsageAmountMonthKey = null;
  let rawUsageCostMonthKey = null;
  let pendingCalendarMonthKey = null;
  let usageAmountByMonth = new Map();
  let usageCostByMonth = new Map();
  let usageRequestUrls = { usage_amount: null, usage_cost: null };
  let usageBackgroundInFlight = new Set();

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

  // 将 Date 对象格式化为本地时区的 YYYY-MM-DD（匹配 API 返回的日期格式）
  function localDateStr(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function localToday() {
    const d = new Date();
    return localDateStr(d);
  }

  function monthKey(year, month) {
    return year + '-' + (month + 1);
  }

  function parseMonthKey(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{1,2})$/);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    if (!Number.isFinite(year) || month < 0 || month > 11) return null;
    return { year, month, key: monthKey(year, month) };
  }

  function addMonths(year, month, delta) {
    const d = new Date(year, month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth(), key: monthKey(d.getFullYear(), d.getMonth()) };
  }

  function compareMonthInfo(a, b) {
    return (a.year - b.year) || (a.month - b.month);
  }

  function formatDateUTC(year, month, day) {
    return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function monthLastDay(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  function getBizDataMonthKey(bizData) {
    if (!bizData || !Array.isArray(bizData.days) || bizData.days.length === 0) return null;
    for (const day of bizData.days) {
      if (day && day.date) {
        const parts = String(day.date).split('-');
        if (parts.length >= 2) {
          return parseInt(parts[0], 10) + '-' + parseInt(parts[1], 10);
        }
      }
    }
    return null;
  }

  function getRequestMonthKey(url) {
    try {
      const parsedUrl = new URL(url, window.location.origin);
      const params = parsedUrl.searchParams;
      const directMonth = params.get('month') || params.get('date');
      const directParsed = parseMonthKey(directMonth);
      if (directParsed) return directParsed.key;
      const directDate = directMonth && String(directMonth).match(/^(\d{4})-(\d{1,2})/);
      if (directDate) return parseInt(directDate[1], 10) + '-' + parseInt(directDate[2], 10);

      const year = params.get('year');
      const month = params.get('month');
      if (year && month) {
        const parsed = parseMonthKey(year + '-' + month);
        if (parsed) return parsed.key;
      }

      const dateKeys = ['start', 'start_date', 'begin', 'begin_date', 'from', 'from_date', 'end', 'end_date', 'to', 'to_date'];
      for (const key of dateKeys) {
        const value = params.get(key);
        const match = value && String(value).match(/^(\d{4})-(\d{1,2})/);
        if (match) return parseInt(match[1], 10) + '-' + parseInt(match[2], 10);
      }
    } catch { /* 忽略 */ }
    return null;
  }

  function buildUsageMonthUrl(templateUrl, year, month) {
    if (!templateUrl) return null;
    const targetKey = monthKey(year, month);
    const firstDate = formatDateUTC(year, month, 1);
    const lastDate = formatDateUTC(year, month, monthLastDay(year, month));
    try {
      const parsedUrl = new URL(templateUrl, window.location.origin);
      const params = parsedUrl.searchParams;
      let changed = false;

      if (params.has('year')) {
        params.set('year', String(year));
        changed = true;
      }
      if (params.has('month')) {
        const oldMonth = params.get('month') || '';
        if (/^\d{4}-\d{1,2}$/.test(oldMonth)) {
          const oldParts = oldMonth.split('-');
          params.set('month', year + '-' + (oldParts[1].length === 2 ? String(month + 1).padStart(2, '0') : String(month + 1)));
        } else {
          params.set('month', oldMonth.length === 2 ? String(month + 1).padStart(2, '0') : String(month + 1));
        }
        changed = true;
      }
      if (params.has('date')) {
        const oldDate = params.get('date') || '';
        params.set('date', oldDate.length <= 7 ? targetKey : firstDate);
        changed = true;
      }

      const startKeys = ['start', 'start_date', 'begin', 'begin_date', 'from', 'from_date'];
      const endKeys = ['end', 'end_date', 'to', 'to_date'];
      for (const key of startKeys) {
        if (params.has(key)) {
          params.set(key, firstDate);
          changed = true;
        }
      }
      for (const key of endKeys) {
        if (params.has(key)) {
          params.set(key, lastDate);
          changed = true;
        }
      }
      if (changed) return parsedUrl.toString();
    } catch { /* 忽略 */ }

    const replaced = String(templateUrl).replace(/\d{4}-\d{1,2}(?:-\d{1,2})?/, function(match) {
      return match.length > 7 ? firstDate : targetKey;
    });
    return replaced !== String(templateUrl) ? replaced : null;
  }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function(ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
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

    const pageMonth = getSelectedPageMonth();
    const targetMonthKey = pageMonth
      ? pageMonth.key
      : (rawUsageAmountMonthKey || rawUsageCostMonthKey);
    let usageData = { today_date: utcToday(), models: {} };
    if (rawUsageAmount && (!targetMonthKey || rawUsageAmountMonthKey === targetMonthKey)) {
      usageData = transformUsageAmount(rawUsageAmount);
    }

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost && (!targetMonthKey || rawUsageCostMonthKey === targetMonthKey)) {
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
  function updateDailyDataFromAmount(bizData, targetMap) {
    if (!bizData || !bizData.days) return;
    const map = targetMap || dailyDataMap;
    for (const day of bizData.days) {
      const date = day.date;
      if (!map.has(date)) {
        map.set(date, { models: {}, totalTokens: 0, totalCost: 0, totalRequests: 0, overallHitRate: null });
      }
      const dayData = map.get(date);
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
  function updateDailyDataFromCost(bizData, targetMap) {
    if (!bizData || !bizData.days) return;
    const map = targetMap || dailyDataMap;
    const currency = bizData.currency || 'CNY';
    for (const day of bizData.days) {
      const date = day.date;
      if (!map.has(date)) {
        map.set(date, { models: {}, totalTokens: 0, totalCost: 0, totalRequests: 0, overallHitRate: null });
      }
      const dayData = map.get(date);
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

  // 综合更新每日数据缓存
  function recalcDailyHitRates(targetMap) {
    // 重新计算每条记录的总体命中率（基于模型的总输入）
    for (const [date, dayData] of targetMap.entries()) {
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

  function rebuildDailyData() {
    dailyDataMap.clear();
    const pageMonth = getSelectedPageMonth();
    const targetMonthKey = pageMonth
      ? pageMonth.key
      : (rawUsageAmountMonthKey || rawUsageCostMonthKey);
    const amountData = targetMonthKey ? (usageAmountByMonth.get(targetMonthKey) || rawUsageAmount) : rawUsageAmount;
    const costData = targetMonthKey ? (usageCostByMonth.get(targetMonthKey) || rawUsageCost) : rawUsageCost;
    if (amountData && (!targetMonthKey || (usageAmountByMonth.has(targetMonthKey) || rawUsageAmountMonthKey === targetMonthKey))) {
      updateDailyDataFromAmount(amountData);
    }
    if (costData && (!targetMonthKey || (usageCostByMonth.has(targetMonthKey) || rawUsageCostMonthKey === targetMonthKey))) {
      updateDailyDataFromCost(costData);
    }
    recalcDailyHitRates(dailyDataMap);
  }

  function buildDailyDataForMonthKeys(monthKeys) {
    const map = new Map();
    for (const key of monthKeys) {
      const amountData = usageAmountByMonth.get(key);
      const costData = usageCostByMonth.get(key);
      if (amountData) updateDailyDataFromAmount(amountData, map);
      if (costData) updateDailyDataFromCost(costData, map);
    }
    recalcDailyHitRates(map);
    return map;
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
      if (ep.id === 'usage_amount' || ep.id === 'usage_cost') {
        usageRequestUrls[ep.id] = url;
      }
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
          if (bizData) processApiResponse(ep.id, bizData, getRequestMonthKey(url));
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
      if (ep && (ep.id === 'usage_amount' || ep.id === 'usage_cost')) {
        usageRequestUrls[ep.id] = _url;
      }
      xhr.addEventListener('load', function () {
        if (ep && xhr.status >= 200 && xhr.status < 300) {
          const json = safeJSON(xhr.responseText);
          if (json) {
            const bizData = extractBizData(json);
            if (bizData) processApiResponse(ep.id, bizData, getRequestMonthKey(_url));
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
  function processApiResponse(endpoint, bizData, requestMonthKey) {
    const prevVisibleMonthKey = monthKey(currentCalendarYear, currentCalendarMonth);
    switch (endpoint) {
    case 'get_user_summary': rawUserSummary = bizData; break;
    case 'usage_amount':
      rawUsageAmount = bizData;
      rawUsageAmountMonthKey = getBizDataMonthKey(bizData) || requestMonthKey || (getSelectedPageMonth() && getSelectedPageMonth().key);
      if (rawUsageAmountMonthKey) usageAmountByMonth.set(rawUsageAmountMonthKey, bizData);
      break;
    case 'usage_cost':
      rawUsageCost = bizData;
      rawUsageCostMonthKey = getBizDataMonthKey(bizData) || requestMonthKey || (getSelectedPageMonth() && getSelectedPageMonth().key);
      if (rawUsageCostMonthKey) usageCostByMonth.set(rawUsageCostMonthKey, bizData);
      break;
    }
    // 每次收到新数据，重新构建每日缓存
    rebuildDailyData();
    // 如果日历已打开，自动刷新为当前数据的月份
    if (calendarOverlay && calendarOverlay.style.display === 'block') {
      updateCalendarMonthFromData();
      const nextVisibleMonthKey = monthKey(currentCalendarYear, currentCalendarMonth);
      if (pendingCalendarMonthKey && calendarMonthDataReady()) {
        pendingCalendarMonthKey = null;
      }
      if (prevVisibleMonthKey !== nextVisibleMonthKey) {
        // 重置范围选择状态（月份变了，旧范围失效）
        rangePhase = 'idle';
        rangeStartDate = null;
        rangeEndDate = null;
        calendarCursorDate = null;
      }
      if (calendarRefreshFn) calendarRefreshFn();
    }
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
      const abs = Math.abs(n);
      const units = [
        { value: 1e9, suffix: 'B' },
        { value: 1e6, suffix: 'M' },
        { value: 1e3, suffix: 'K' },
      ];
      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (abs >= unit.value) {
          let scaled = n / unit.value;
          let precision = Math.abs(scaled) >= 100 ? 0 : (Math.abs(scaled) >= 10 ? 1 : 2);
          let rounded = Number(scaled.toFixed(precision));
          if (Math.abs(rounded) >= 1000 && i > 0) {
            const nextUnit = units[i - 1];
            scaled = n / nextUnit.value;
            precision = Math.abs(scaled) >= 100 ? 0 : (Math.abs(scaled) >= 10 ? 1 : 2);
            rounded = Number(scaled.toFixed(precision));
            return rounded.toString() + nextUnit.suffix;
          }
          return rounded.toString() + unit.suffix;
        }
      }
      return Math.round(n).toLocaleString();
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
      background: rgba(17, 17, 31, 0.92);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid rgba(96, 165, 250, 0.12);
      color: #e2e8f0;
      box-shadow: 0 16px 48px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(96,165,250,0.06), inset 0 1px 0 rgba(255,255,255,0.04);
    }
    .ds-titlebar { border-bottom: 1px solid rgba(255,255,255,0.06); }
    .ds-title { color: #e5e5e5; }
    .ds-title-models { color: #6c7086; }
    .ds-btn { color: #6c7086; }
    .ds-btn:hover { background: rgba(255,255,255,0.08); color: #cdd6f4; }
    .ds-acct-label { color: #6c7086; }
    .ds-acct-value { color: #cdd6f4; }
    .ds-acct-value.accent { background: linear-gradient(135deg, #60a5fa, #34d399); -webkit-background-clip: text; background-clip: text; }
    .ds-acct-unit { color: #585b70; }
    .ds-section-gap { background: rgba(255,255,255,0.06); }
    .ds-model-block { background: rgba(15,15,30,0.5); border: 1px solid rgba(96,165,250,0.06); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .ds-model-id { color: #fab387; }
    .ds-model-sep { background: rgba(255,255,255,0.04); }
    .ds-metric-val { color: #e2e8f0; }
    .ds-metric-val.green { color: #34d399; }
    .ds-metric-val.yellow { color: #f9e2af; }
    .ds-metric-lbl { color: #6c7086; }
    .ds-cache-row { border-top: 1px solid rgba(255,255,255,0.04); }
    .ds-cache-label { color: #6c7086; }
    .ds-cache-track { background: rgba(255,255,255,0.06); }
    .ds-cache-fill { background: linear-gradient(90deg, #60a5fa, #34d399); box-shadow: 0 0 6px rgba(96,165,250,0.2); }
    .ds-cache-pct { color: #34d399; }
    .ds-summary-bar { background: rgba(15,15,30,0.5); border-top: 1px solid rgba(96,165,250,0.08); color: #94a3b8; }
    .ds-sum-val { color: #e2e8f0; }
    .ds-summary-dot { background: #45475a; }
    .ds-no-data { color: #585b70; }
    #ds-monitor-panel.ds-collapsed .ds-body,
    #ds-monitor-panel.ds-collapsed .ds-summary-bar { display: none; }
    .ds-calendar { background: rgba(30, 30, 46, 0.96); border: 1px solid rgba(255,255,255,0.1); color: #cdd6f4; }
    .ds-calendar th { color: #6c7086; }
    .ds-calendar-day { color: #cdd6f4; }
    .ds-calendar-day.other-month { color: #585b70; }
    .ds-calendar-day.has-data { background: rgba(96, 165, 250, 0.18); border-radius: 6px; font-weight: 600; }
    .ds-calendar-day.selected { background: #60a5fa; color: #0f0f1a; border-radius: 6px; box-shadow: 0 2px 8px rgba(96,165,250,0.3); }
    .ds-calendar-day:hover { background: rgba(96, 165, 250, 0.4); border-radius: 6px; transform: scale(1.08); }
    .ds-calendar-day.today { box-shadow: inset 0 0 0 1.5px #60a5fa, 0 0 10px rgba(96,165,250,0.25); }
    .ds-calendar-cost { display: block; font-size: 8px; line-height: 1.1; opacity: 0.65; margin-top: 0px; }
    .ds-calendar-today-btn { font-size: 11px; color: #60a5fa; cursor: pointer; background: none; border: none; padding: 2px 6px; border-radius: 3px; }
    .ds-calendar-today-btn:hover { background: rgba(96, 165, 250, 0.2); }
    .ds-calendar-tooltip { position: absolute; display: none; background: rgba(30,30,46,0.96); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 6px 10px; font-size: 11px; line-height: 1.5; z-index: 100001; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.4); white-space: nowrap; }
    .ds-calendar-tooltip .ds-tt-row { display: flex; justify-content: space-between; gap: 12px; }
    .ds-calendar-tooltip .ds-tt-label { opacity: 0.6; }
    .ds-calendar-tooltip .ds-tt-val { font-weight: 600; }
    .ds-calendar-tooltip .ds-tt-title { font-weight: 700; margin-bottom: 4px; }
    .ds-calendar-tooltip .ds-tt-divider { height: 1px; background: rgba(255,255,255,0.08); margin: 5px 0; }
    .ds-calendar-summary { margin-top: 6px; padding: 5px 4px 2px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; opacity: 0.7; }
    .ds-calendar-summary b { opacity: 0.95; color: #e2e8f0; }
    @keyframes ds-calendar-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .ds-calendar { animation: ds-calendar-in 0.15s ease-out; }
    .ds-calendar-day { transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s; }
    .ds-view-tabs { display: flex; gap: 2px; margin-bottom: 10px; position: sticky; top: -8px; z-index: 4; padding: 8px 0 6px; background: rgba(30, 30, 46, 0.98); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
    .ds-view-tab { flex: 1; padding: 4px 0; border: none; background: none; cursor: pointer; font-size: 11px; border-radius: 4px; color: #6c7086; transition: background 0.12s, color 0.12s; }
    .ds-view-tab.active { background: rgba(96,165,250,0.15); color: #60a5fa; font-weight: 600; }
    .ds-view-tab:hover:not(.active) { background: rgba(255,255,255,0.05); }
    .ds-week-grid { display: flex; flex-direction: column; gap: 6px; }
    .ds-week-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0; }
    .ds-week-cell { text-align: center; padding: 2px 0; border-radius: 4px; font-size: 11px; cursor: pointer; color: #cdd6f4; transition: background 0.12s; }
    .ds-week-cell.other-week { opacity: 0.3; }
    .ds-week-cell.has-data { background: rgba(137,180,250,0.2); font-weight: 600; }
    .ds-week-cell:hover { background: rgba(137,180,250,0.35); }
    .ds-week-cell.today { box-shadow: inset 0 0 0 1.5px #89b4fa; }
    .ds-week-label { font-size: 9px; opacity: 0.5; margin: 6px 0 1px; }
    .ds-week-header,
    .ds-week-summary { display: grid; grid-template-columns: 52px 56px minmax(54px, 1fr) 40px 38px; align-items: center; column-gap: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .ds-week-header { font-size: 9px; opacity: 0.46; padding: 0 4px 2px; }
    .ds-week-summary { font-size: 10px; opacity: 0.72; margin: 0; padding: 6px 4px; border-top: 1px solid rgba(255,255,255,0.06); cursor: default; }
    .ds-week-summary:hover { background: rgba(96,165,250,0.1); }
    .ds-week-month-header { font-size: 10px; font-weight: 700; color: #60a5fa; padding: 8px 4px 2px; border-top: 1px solid rgba(255,255,255,0.08); }
    .ds-week-month-header:first-child { border-top: none; padding-top: 0; }
    .ds-week-loading { font-size: 9px; opacity: 0.52; padding: 0 4px 2px; }
    .ds-week-header span,
    .ds-week-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .ds-week-cost,
    .ds-week-token,
    .ds-week-requests,
    .ds-week-hitrate { text-align: right; }
    .ds-range-indicator { font-size: 10px; text-align: center; opacity: 0.7; margin-bottom: 6px; min-height: 16px; }
    .ds-range-clear { font-size: 10px; cursor: pointer; text-align: center; opacity: 0.6; margin-top: 2px; }
    .ds-sum-break { width: 100%; height: 0; overflow: hidden; }
    .ds-range-clear:hover { opacity: 1; color: #60a5fa; }
    .ds-calendar-day.range-start { background: #89b4fa !important; color: #1e1e2e !important; border-radius: 4px 0 0 4px !important; }
    .ds-calendar-day.range-end { background: #89b4fa !important; color: #1e1e2e !important; border-radius: 0 4px 4px 0 !important; }
    .ds-calendar-day.range-mid { background: rgba(137, 180, 250, 0.50) !important; color: #1e1e2e !important; border-radius: 0 !important; }
    .ds-calendar-day.range-start:hover,
    .ds-calendar-day.range-end:hover { background: #89b4fa !important; }
    .ds-calendar-day.range-mid:hover { background: rgba(137, 180, 250, 0.65) !important; }
  `;

  const lightThemeStyle = `
    #ds-monitor-panel {
      background: rgba(245, 245, 250, 0.96);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid rgba(0,0,0,0.08);
      color: #1e1e2e;
      box-shadow: 0 12px 40px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04);
    }
    .ds-titlebar { border-bottom: 1px solid rgba(0,0,0,0.08); }
    .ds-title { color: #1e1e2e; }
    .ds-title-models { color: #7c7f8a; }
    .ds-btn { color: #7c7f8a; }
    .ds-btn:hover { background: rgba(0,0,0,0.05); color: #1e1e2e; }
    .ds-acct-label { color: #7c7f8a; }
    .ds-acct-value { color: #1e1e2e; }
    .ds-acct-value.accent { background: linear-gradient(135deg, #2563eb, #059669); -webkit-background-clip: text; background-clip: text; }
    .ds-acct-unit { color: #9ca0b0; }
    .ds-section-gap { background: rgba(0,0,0,0.08); }
    .ds-model-block { background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    .ds-model-id { color: #d4611a; }
    .ds-model-sep { background: rgba(0,0,0,0.06); }
    .ds-metric-val { color: #1e1e2e; }
    .ds-metric-val.green { color: #059669; }
    .ds-metric-val.yellow { color: #b95b0a; }
    .ds-metric-lbl { color: #7c7f8a; }
    .ds-cache-row { border-top: 1px solid rgba(0,0,0,0.08); }
    .ds-cache-label { color: #7c7f8a; }
    .ds-cache-track { background: rgba(0,0,0,0.08); }
    .ds-cache-fill { background: linear-gradient(90deg, #2563eb, #059669); box-shadow: 0 0 6px rgba(37,99,235,0.15); }
    .ds-cache-pct { color: #059669; }
    .ds-summary-bar { background: rgba(0,0,0,0.03); border-top: 1px solid rgba(0,0,0,0.08); color: #7c7f8a; }
    .ds-sum-val { color: #1e1e2e; }
    .ds-summary-dot { background: #c0c2ce; }
    .ds-no-data { color: #9ca0b0; }
    #ds-monitor-panel.ds-collapsed .ds-body,
    #ds-monitor-panel.ds-collapsed .ds-summary-bar { display: none; }
    .ds-calendar { background: rgba(245, 245, 250, 0.96); border: 1px solid rgba(0,0,0,0.1); color: #1e1e2e; }
    .ds-calendar th { color: #7c7f8a; }
    .ds-calendar-day { color: #1e1e2e; }
    .ds-calendar-day.other-month { color: #9ca0b0; }
    .ds-calendar-day.has-data { background: rgba(37, 99, 235, 0.12); border-radius: 6px; font-weight: 600; }
    .ds-calendar-day.selected { background: #2563eb; color: #ffffff; border-radius: 6px; box-shadow: 0 2px 8px rgba(37,99,235,0.25); }
    .ds-calendar-day:hover { background: rgba(37, 99, 235, 0.25); border-radius: 6px; transform: scale(1.08); }
    .ds-calendar-day.today { box-shadow: inset 0 0 0 1.5px #2563eb, 0 0 10px rgba(37,99,235,0.15); }
    .ds-calendar-cost { display: block; font-size: 8px; line-height: 1.1; opacity: 0.6; margin-top: 0px; }
    .ds-calendar-today-btn { font-size: 11px; color: #2563eb; cursor: pointer; background: none; border: none; padding: 2px 6px; border-radius: 3px; }
    .ds-calendar-today-btn:hover { background: rgba(37, 99, 235, 0.12); }
    .ds-calendar-tooltip { position: absolute; display: none; background: rgba(245,245,250,0.97); border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; padding: 6px 10px; font-size: 11px; line-height: 1.5; z-index: 100001; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.12); white-space: nowrap; }
    .ds-calendar-tooltip .ds-tt-row { display: flex; justify-content: space-between; gap: 12px; }
    .ds-calendar-tooltip .ds-tt-label { opacity: 0.55; }
    .ds-calendar-tooltip .ds-tt-val { font-weight: 600; }
    .ds-calendar-tooltip .ds-tt-title { font-weight: 700; margin-bottom: 4px; }
    .ds-calendar-tooltip .ds-tt-divider { height: 1px; background: rgba(0,0,0,0.08); margin: 5px 0; }
    .ds-calendar-summary { margin-top: 6px; padding: 5px 4px 2px; border-top: 1px solid rgba(0,0,0,0.08); font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; opacity: 0.65; }
    .ds-calendar-summary b { opacity: 0.85; }
    @keyframes ds-calendar-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .ds-calendar { animation: ds-calendar-in 0.15s ease-out; }
    .ds-calendar-day { transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s; }
    .ds-view-tabs { display: flex; gap: 2px; margin-bottom: 10px; position: sticky; top: -8px; z-index: 4; padding: 8px 0 6px; background: rgba(245, 245, 250, 0.98); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
    .ds-view-tab { flex: 1; padding: 4px 0; border: none; background: none; cursor: pointer; font-size: 11px; border-radius: 4px; color: #7c7f8a; transition: background 0.12s, color 0.12s; }
    .ds-view-tab.active { background: rgba(37,99,235,0.10); color: #2563eb; font-weight: 600; }
    .ds-view-tab:hover:not(.active) { background: rgba(0,0,0,0.04); }
    .ds-week-grid { display: flex; flex-direction: column; gap: 6px; }
    .ds-week-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0; }
    .ds-week-cell { text-align: center; padding: 2px 0; border-radius: 4px; font-size: 11px; cursor: pointer; color: #1e1e2e; transition: background 0.12s; }
    .ds-week-cell.other-week { opacity: 0.3; }
    .ds-week-cell.has-data { background: rgba(30,102,245,0.15); font-weight: 600; }
    .ds-week-cell:hover { background: rgba(30,102,245,0.25); }
    .ds-week-cell.today { box-shadow: inset 0 0 0 1.5px #1e66f5; }
    .ds-week-label { font-size: 9px; opacity: 0.5; margin: 6px 0 1px; }
    .ds-week-header,
    .ds-week-summary { display: grid; grid-template-columns: 52px 56px minmax(54px, 1fr) 40px 38px; align-items: center; column-gap: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .ds-week-header { font-size: 9px; opacity: 0.46; padding: 0 4px 2px; }
    .ds-week-summary { font-size: 10px; opacity: 0.72; margin: 0; padding: 6px 4px; border-top: 1px solid rgba(0,0,0,0.08); cursor: default; }
    .ds-week-summary:hover { background: rgba(37,99,235,0.06); }
    .ds-week-month-header { font-size: 10px; font-weight: 700; color: #2563eb; padding: 8px 4px 2px; border-top: 1px solid rgba(0,0,0,0.08); }
    .ds-week-month-header:first-child { border-top: none; padding-top: 0; }
    .ds-week-loading { font-size: 9px; opacity: 0.52; padding: 0 4px 2px; }
    .ds-week-header span,
    .ds-week-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .ds-week-cost,
    .ds-week-token,
    .ds-week-requests,
    .ds-week-hitrate { text-align: right; }
    .ds-range-indicator { font-size: 10px; text-align: center; opacity: 0.7; margin-bottom: 6px; min-height: 16px; }
    .ds-range-clear { font-size: 10px; cursor: pointer; text-align: center; opacity: 0.6; margin-top: 2px; }
    .ds-sum-break { width: 100%; height: 0; overflow: hidden; }
    .ds-range-clear:hover { opacity: 1; color: #2563eb; }
    .ds-calendar-day.range-start { background: #2563eb !important; color: #ffffff !important; border-radius: 6px 0 0 6px !important; }
    .ds-calendar-day.range-end { background: #2563eb !important; color: #ffffff !important; border-radius: 0 6px 6px 0 !important; }
    .ds-calendar-day.range-mid { background: rgba(37, 99, 235, 0.35) !important; color: #1c1917 !important; border-radius: 0 !important; }
    .ds-calendar-day.range-start:hover,
    .ds-calendar-day.range-end:hover { background: #2563eb !important; }
    .ds-calendar-day.range-mid:hover { background: rgba(37, 99, 235, 0.50) !important; }
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

  // 日历视图模式: 'month' | 'week' | 'range'
  let currentViewMode = 'month';

  // 范围选择状态
  let rangePhase = 'idle'; // 'idle' | 'select-start' | 'select-end' | 'done'
  let rangeStartDate = null; // 'YYYY-MM-DD' | null
  let rangeEndDate = null;

  // 日历刷新回调（由 showCalendar 注册，processApiResponse 调用）
  let calendarRefreshFn = null;

  // 日历键盘光标
  let calendarCursorDate = null;
  let weekAutoScrollMonthKey = null;

  function getUsageMonthSelect() {
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      const options = Array.from(select.options || []);
      if (options.some(option => parseMonthKey(option.value))) {
        return select;
      }
    }
    return null;
  }

  function getSelectedPageMonth() {
    const select = getUsageMonthSelect();
    if (select) {
      const selected = parseMonthKey(select.value);
      if (selected) return selected;
    }
    return null;
  }

  function getSelectableUsageMonths() {
    const select = getUsageMonthSelect();
    if (!select) return [];
    const months = [];
    const seen = new Set();
    for (const option of Array.from(select.options || [])) {
      const parsed = parseMonthKey(option.value);
      if (parsed && !seen.has(parsed.key)) {
        months.push(parsed);
        seen.add(parsed.key);
      }
    }
    return months.sort(compareMonthInfo);
  }

  function canSelectUsageMonth(year, month) {
    return getUsageMonthOptionValue(year, month) !== null;
  }

  function getUsageMonthOptionValue(year, month) {
    const select = getUsageMonthSelect();
    if (!select) return null;
    const key = monthKey(year, month);
    for (const option of Array.from(select.options || [])) {
      const parsed = parseMonthKey(option.value);
      if (parsed && parsed.key === key) return option.value;
    }
    return null;
  }

  function setNativeSelectValue(select, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(select, value);
    else select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectUsageMonth(year, month) {
    const select = getUsageMonthSelect();
    if (!select) return false;
    const key = monthKey(year, month);
    const optionValue = getUsageMonthOptionValue(year, month);
    if (!optionValue) return false;

    currentCalendarYear = year;
    currentCalendarMonth = month;
    calendarCursorDate = null;
    hideCalendarTooltip();

    if (currentViewMode === 'range') {
      rangePhase = 'select-start';
      rangeStartDate = null;
      rangeEndDate = null;
    }
    if (selectedDate) {
      const selectedParts = selectedDate.split('-');
      const selectedYear = parseInt(selectedParts[0], 10);
      const selectedMonth = parseInt(selectedParts[1], 10) - 1;
      if (selectedYear !== year || selectedMonth !== month) {
        currentView = 'today';
        selectedDate = null;
      }
    }

    if (parseMonthKey(select.value)?.key !== key) {
      pendingCalendarMonthKey = key;
      dailyDataMap.clear();
      setNativeSelectValue(select, optionValue);
    }
    return true;
  }

  function calendarMonthDataReady() {
    const key = monthKey(currentCalendarYear, currentCalendarMonth);
    return usageAmountByMonth.has(key) && usageCostByMonth.has(key);
  }

  function isCalendarMonthLoading() {
    const selected = getSelectedPageMonth();
    const key = monthKey(currentCalendarYear, currentCalendarMonth);
    return selected && selected.key === key && !calendarMonthDataReady();
  }

  // 获取页面所选月份（优先使用页面原生月份下拉框）
  function getPageMonth() {
    const selected = getSelectedPageMonth();
    if (selected) return { year: selected.year, month: selected.month };
    if (rawUsageAmountMonthKey) {
      const parsed = parseMonthKey(rawUsageAmountMonthKey);
      if (parsed) return { year: parsed.year, month: parsed.month };
    }
    var n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() };
  }

  // 从页面数据中获取当前显示的月份
  function updateCalendarMonthFromData() {
    var pageMonth = getPageMonth();
    currentCalendarYear = pageMonth.year;
    currentCalendarMonth = pageMonth.month;
  }

  function storeBackgroundUsageData(endpoint, bizData, key) {
    const resolvedKey = getBizDataMonthKey(bizData) || key;
    if (!resolvedKey) return;
    if (endpoint === 'usage_amount') usageAmountByMonth.set(resolvedKey, bizData);
    else if (endpoint === 'usage_cost') usageCostByMonth.set(resolvedKey, bizData);
  }

  function fetchUsageMonthEndpoint(endpoint, monthInfo) {
    const url = buildUsageMonthUrl(usageRequestUrls[endpoint], monthInfo.year, monthInfo.month);
    if (!url) return;
    const inFlightKey = endpoint + ':' + monthInfo.key;
    if (usageBackgroundInFlight.has(inFlightKey)) return;
    usageBackgroundInFlight.add(inFlightKey);

    const headers = {};
    if (bearerToken) headers.Authorization = 'Bearer ' + bearerToken;
    origFetch.call(window, url, {
      method: 'GET',
      credentials: 'include',
      headers,
    }).then(function(response) {
      if (!response.ok) return null;
      return response.clone().json().catch(function() { return null; });
    }).then(function(json) {
      const bizData = extractBizData(json);
      if (bizData) {
        storeBackgroundUsageData(endpoint, bizData, monthInfo.key);
        if (calendarOverlay && calendarOverlay.style.display === 'block' && currentViewMode === 'week' && calendarRefreshFn) {
          calendarRefreshFn();
        }
      }
    }).catch(function() {
      // 后台补取失败不影响当前月份视图。
    }).finally(function() {
      usageBackgroundInFlight.delete(inFlightKey);
    });
  }

  function ensureUsageMonthLoaded(monthInfo) {
    if (!usageAmountByMonth.has(monthInfo.key)) fetchUsageMonthEndpoint('usage_amount', monthInfo);
    if (!usageCostByMonth.has(monthInfo.key)) fetchUsageMonthEndpoint('usage_cost', monthInfo);
  }

  function isUsageMonthLoading(monthKeyValue) {
    return usageBackgroundInFlight.has('usage_amount:' + monthKeyValue) ||
      usageBackgroundInFlight.has('usage_cost:' + monthKeyValue);
  }

  function isUsageMonthComplete(monthKeyValue) {
    return usageAmountByMonth.has(monthKeyValue) && usageCostByMonth.has(monthKeyValue);
  }

  function getWeekTimelineMonths(year, month) {
    const selectable = getSelectableUsageMonths();
    if (selectable.length > 0) return selectable;
    const months = [];
    for (let offset = -2; offset <= 2; offset++) {
      months.push(addMonths(year, month, offset));
    }
    return months;
  }

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
    table.style.borderCollapse = 'separate';
	    table.style.borderSpacing = '0';
    table.style.fontSize = '11px';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    ['日', '一', '二', '三', '四', '五', '六'].forEach(day => {
      const th = document.createElement('th');
      th.textContent = day;
      th.style.padding = '4px 0';
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
        td.setAttribute('data-date', localDateStr(cell.date));
        td.style.textAlign = 'center';
        td.style.padding = '1px 0';
        const daySpan = document.createElement('span');
        daySpan.textContent = cell.date.getDate();
        daySpan.className = 'ds-calendar-day';
        if (!cell.isCurrentMonth) daySpan.classList.add('other-month');
        const dateStr = localDateStr(cell.date);
        if (dailyDataMap.has(dateStr) && cell.isCurrentMonth) {
          daySpan.classList.add('has-data');
        }
        if (selectedDate === dateStr && cell.isCurrentMonth) {
          daySpan.classList.add('selected');
        }
        if (calendarCursorDate === dateStr && cell.isCurrentMonth && calendarOverlay && calendarOverlay.style.display === 'block') {
          daySpan.classList.add('selected');
        }
        if (dateStr === localToday() && cell.isCurrentMonth) {
          daySpan.classList.add('today');
        }
        daySpan.style.cursor = 'pointer';
        daySpan.style.display = 'inline-block';
        daySpan.style.padding = '2px 0';
        daySpan.style.width = '24px';
        daySpan.style.textAlign = 'center';
        daySpan.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cell.isCurrentMonth) {
            showDateDetail(dateStr);
          }
        });
        td.appendChild(daySpan);
        if (cell.isCurrentMonth && dailyDataMap.has(dateStr)) {
          const dayData = dailyDataMap.get(dateStr);
          const costEl = document.createElement('span');
          costEl.className = 'ds-calendar-cost';
          const amt = dayData.totalCost || 0;
          costEl.textContent = '￥' + (amt < 100 ? amt.toFixed(1) : Math.round(amt).toString());
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
    left = Math.max(ttWidth / 2 + 4, Math.min(left, overlayRect.width - ttWidth / 2 - 4));

    calendarTooltip.style.top = top + 'px';
    calendarTooltip.style.left = left + 'px';
    calendarTooltip.style.transform = 'translateX(-50%)';
  }

  function showWeekTooltip(event, weekLabel, summary) {
    const overlay = calendarOverlay;
    if (!overlay) return;
    if (!calendarTooltip) {
      calendarTooltip = document.createElement('div');
      calendarTooltip.id = 'ds-calendar-tooltip';
      calendarTooltip.className = 'ds-calendar-tooltip';
      overlay.appendChild(calendarTooltip);
    }
    const hitRate = summary.overallHitRate;
    calendarTooltip.innerHTML =
      '<div class="ds-tt-title">' + escapeHTML(weekLabel) + '详情</div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">费用</span><span class="ds-tt-val">' + fmtMoney(summary.totalCost || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Token</span><span class="ds-tt-val">' + fmtNumShort(summary.totalTokens || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">请求</span><span class="ds-tt-val">' + (summary.totalRequests || 0).toLocaleString() + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">缓存命中</span><span class="ds-tt-val">' + (hitRate !== null ? hitRate.toFixed(1) + '%' : '—') + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">有数据天数</span><span class="ds-tt-val">' + (summary.dayCount || 0) + '</span></div>' +
      '<div class="ds-tt-divider"></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Pro 费用</span><span class="ds-tt-val">' + fmtMoney(summary.proCost || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Flash 费用</span><span class="ds-tt-val">' + fmtMoney(summary.flashCost || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Pro Token</span><span class="ds-tt-val">' + fmtNumShort(summary.proTokens || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Flash Token</span><span class="ds-tt-val">' + fmtNumShort(summary.flashTokens || 0) + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Pro 请求</span><span class="ds-tt-val">' + (summary.proRequests || 0).toLocaleString() + '</span></div>' +
      '<div class="ds-tt-row"><span class="ds-tt-label">Flash 请求</span><span class="ds-tt-val">' + (summary.flashRequests || 0).toLocaleString() + '</span></div>';
    calendarTooltip.style.display = 'block';

    const cell = event.currentTarget || event.target;
    const cellRect = cell.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const ttHeight = calendarTooltip.offsetHeight || 120;
    const ttWidth = calendarTooltip.offsetWidth || 170;

    let top = cellRect.top - overlayRect.top - ttHeight - 4;
    if (top < 4) {
      top = cellRect.bottom - overlayRect.top + 4;
    }
    let left = cellRect.left - overlayRect.left + cellRect.width / 2;
    left = Math.max(ttWidth / 2 + 4, Math.min(left, overlayRect.width - ttWidth / 2 - 4));

    calendarTooltip.style.top = top + 'px';
    calendarTooltip.style.left = left + 'px';
    calendarTooltip.style.transform = 'translateX(-50%)';
  }

  function hideCalendarTooltip() {
    if (calendarTooltip) calendarTooltip.style.display = 'none';
  }

  function buildMonthlySummary(year, month) {
    let totalCost = 0, totalTokens = 0, totalRequests = 0, dayCount = 0;
    let proTokens = 0, flashTokens = 0;
    let totalCached = 0, totalInput = 0;
    for (const [dateStr, dayData] of dailyDataMap.entries()) {
      const parts = dateStr.split('-');
      if (parseInt(parts[0]) === year && parseInt(parts[1]) - 1 === month) {
        totalCost += dayData.totalCost || 0;
        totalTokens += dayData.totalTokens || 0;
        totalRequests += dayData.totalRequests || 0;
        dayCount++;
        if (dayData.models) {
          for (const modelName of Object.keys(dayData.models)) {
            const m = dayData.models[modelName];
            const tokens = m.tokens ? (m.tokens.total || 0) : 0;
            const cached = m.tokens ? (m.tokens.cached_input || 0) : 0;
            const uncached = m.tokens ? (m.tokens.uncached_input || 0) : 0;
            totalCached += cached;
            totalInput += cached + uncached;
            const lower = modelName.toLowerCase();
            if (lower.includes('pro')) proTokens += tokens;
            else if (lower.includes('flash')) flashTokens += tokens;
          }
        }
      }
    }
    const overallHitRate = totalInput > 0 ? (totalCached / totalInput) * 100 : null;
    const div = document.createElement('div');
    div.className = 'ds-calendar-summary';
    div.innerHTML =
      '<span style="width:100%">(' + (month + 1) + '月) 合计</span>' +
      '<span>费用 <b>￥' + totalCost.toFixed(2) + '</b></span>' +
      '<span>Token <b>' + fmtNumShort(totalTokens) + '</b></span>' +
      '<span>请求 <b>' + totalRequests.toLocaleString() + '</b></span>' +
      '<span class="ds-sum-break"></span>' +
      '<span>Pro ' + fmtNumShort(proTokens) + '</span>' +
      '<span>Flash ' + fmtNumShort(flashTokens) + '</span>' +
      '<span>天数 ' + dayCount + '</span>' +
      '<span>命中率 <b>' + (overallHitRate !== null ? overallHitRate.toFixed(1) + '%' : '—') + '</b></span>';
    return div;
  }

  // 返回 dateStr 所在周的周一（'YYYY-MM-DD'）
  function getWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0=Sun, 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // 周日 → 前推6天，其他 → 回退到周一
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  // 获取某个月所涉及的所有周的周一日期数组
  function getWeeksForMonth(year, month) {
    const firstDay = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const startMonday = getWeekMonday(firstDay.toISOString().slice(0, 10));
    const weeks = [];
    const current = new Date(startMonday + 'T00:00:00Z');
    while (current <= lastDay || weeks.length === 0) {
      weeks.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 7);
    }
    // 如果最后一周包含下个月天数，仍然保留
    const lastMonday = getWeekMonday(lastDay.toISOString().slice(0, 10));
    if (weeks[weeks.length - 1] !== lastMonday) {
      weeks.push(lastMonday);
    }
    return weeks;
  }

  function getContinuousWeeksForMonths(months) {
    if (!months || months.length === 0) return [];
    const sorted = months.slice().sort(compareMonthInfo);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const firstDay = new Date(Date.UTC(first.year, first.month, 1));
    const lastDay = new Date(Date.UTC(last.year, last.month + 1, 0));
    const current = new Date(getWeekMonday(firstDay.toISOString().slice(0, 10)) + 'T00:00:00Z');
    const weeks = [];
    while (current <= lastDay || weeks.length === 0) {
      weeks.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 7);
    }
    return weeks;
  }

  function getWeekMonthKeys(weekMonday) {
    const start = new Date(weekMonday + 'T00:00:00Z');
    const keys = [];
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const key = monthKey(d.getUTCFullYear(), d.getUTCMonth());
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  }

  function getWeekDisplayMonth(weekMonday) {
    const start = new Date(weekMonday + 'T00:00:00Z');
    const counts = {};
    const order = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const key = monthKey(d.getUTCFullYear(), d.getUTCMonth());
      if (counts[key] === undefined) {
        counts[key] = { count: 0, year: d.getUTCFullYear(), month: d.getUTCMonth(), key };
        order.push(key);
      }
      counts[key].count++;
    }
    let best = counts[order[0]];
    for (const key of order) {
      const item = counts[key];
      if (item.count >= best.count) best = item;
    }
    return { year: best.year, month: best.month, key: best.key };
  }

  function getWeekNumberWithinMonth(weekMonday, year, month) {
    const weeks = getWeeksForMonth(year, month);
    const idx = weeks.indexOf(weekMonday);
    return idx >= 0 ? idx + 1 : 1;
  }

  // 聚合指定周的数据
  function buildWeeklySummary(weekMonday, sourceMap) {
    const dataMap = sourceMap || dailyDataMap;
    const start = new Date(weekMonday + 'T00:00:00Z');
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    let totalCost = 0, totalTokens = 0, totalRequests = 0, dayCount = 0;
    let totalCached = 0, totalInput = 0;
    let proTokens = 0, flashTokens = 0, proRequests = 0, flashRequests = 0;
    let proCost = 0, flashCost = 0;
    for (const [dateStr, dayData] of dataMap.entries()) {
      const d = new Date(dateStr + 'T00:00:00Z');
      if (d >= start && d < end) {
        totalCost += dayData.totalCost || 0;
        totalTokens += dayData.totalTokens || 0;
        totalRequests += dayData.totalRequests || 0;
        dayCount++;
        for (const modelName of Object.keys(dayData.models || {})) {
          const m = dayData.models[modelName];
          const tokens = m.tokens || {};
          const modelTokens = tokens.total || 0;
          const modelRequests = m.requests || 0;
          const modelCost = m.cost || 0;
          const cached = tokens.cached_input || 0;
          const uncached = tokens.uncached_input || 0;
          const lower = modelName.toLowerCase();
          totalCached += cached;
          totalInput += cached + uncached;
          if (lower.includes('pro')) {
            proTokens += modelTokens;
            proRequests += modelRequests;
            proCost += modelCost;
          } else if (lower.includes('flash')) {
            flashTokens += modelTokens;
            flashRequests += modelRequests;
            flashCost += modelCost;
          }
        }
      }
    }
    const overallHitRate = totalInput > 0 ? (totalCached / totalInput) * 100 : null;

    return { totalCost, totalTokens, totalRequests, dayCount, overallHitRate, proTokens, flashTokens, proRequests, flashRequests, proCost, flashCost };
  }

  // 聚合指定日期范围的数据
  function buildRangeSummary(startDateStr, endDateStr) {
    const start = new Date(startDateStr + 'T00:00:00Z');
    const endDate = new Date(endDateStr + 'T00:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 1); // 包含结束日
    let totalCost = 0, totalTokens = 0, totalRequests = 0, dayCount = 0;
    let totalCached = 0, totalInput = 0;
    let proTokens = 0, flashTokens = 0;
    for (const [dateStr, dayData] of dailyDataMap.entries()) {
      const d = new Date(dateStr + 'T00:00:00Z');
      if (d >= start && d < endDate) {
        totalCost += dayData.totalCost || 0;
        totalTokens += dayData.totalTokens || 0;
        totalRequests += dayData.totalRequests || 0;
        dayCount++;
        if (dayData.models) {
          for (const modelName of Object.keys(dayData.models)) {
            const m = dayData.models[modelName];
            const tokens = m.tokens ? (m.tokens.total || 0) : 0;
            const cached = m.tokens ? (m.tokens.cached_input || 0) : 0;
            const uncached = m.tokens ? (m.tokens.uncached_input || 0) : 0;
            totalCached += cached;
            totalInput += cached + uncached;
            const lower = modelName.toLowerCase();
            if (lower.includes('pro')) proTokens += tokens;
            else if (lower.includes('flash')) flashTokens += tokens;
          }
        }
      }
    }
    let overallHitRate = null;
    if (totalInput > 0) overallHitRate = (totalCached / totalInput) * 100;
    return { totalCost, totalTokens, totalRequests, dayCount, overallHitRate, proTokens, flashTokens };
  }

  // 渲染周视图
  function renderWeekView(container, year, month) {
    const months = getWeekTimelineMonths(year, month);
    for (const item of months) ensureUsageMonthLoaded(item);
    const monthKeys = months.map(function(item) { return item.key; });
    const weekDataMap = buildDailyDataForMonthKeys(monthKeys);
    const weeks = getContinuousWeeksForMonths(months);
    const grid = document.createElement('div');
    grid.className = 'ds-week-grid';
    const unit = rawUserSummary ? (transformUserSummary(rawUserSummary).balance.currency === 'CNY' ? '￥' : '$') : '￥';
    let currentMonthHeaderKey = null;

    for (let wi = 0; wi < weeks.length; wi++) {
      const displayMonth = getWeekDisplayMonth(weeks[wi]);
      if (displayMonth.key !== currentMonthHeaderKey) {
        currentMonthHeaderKey = displayMonth.key;
        const monthHeader = document.createElement('div');
        monthHeader.className = 'ds-week-month-header';
        monthHeader.setAttribute('data-week-month-key', displayMonth.key);
        monthHeader.textContent = displayMonth.year + '年 ' + (displayMonth.month + 1) + '月';
        grid.appendChild(monthHeader);

        const header = document.createElement('div');
        header.className = 'ds-week-header';
        header.innerHTML =
          '<span>周</span>' +
          '<span class="ds-week-cost">费用</span>' +
          '<span class="ds-week-token">Token</span>' +
          '<span class="ds-week-requests">请求</span>' +
          '<span class="ds-week-hitrate">命中</span>';
        grid.appendChild(header);

        if (!isUsageMonthComplete(displayMonth.key)) {
          const loading = document.createElement('div');
          loading.className = 'ds-week-loading';
          loading.textContent = isUsageMonthLoading(displayMonth.key) ? '正在加载该月份周数据…' : '该月份周数据尚未加载';
          grid.appendChild(loading);
        }
      }

      const summary = buildWeeklySummary(weeks[wi], weekDataMap);
      const weekNo = getWeekNumberWithinMonth(weeks[wi], displayMonth.year, displayMonth.month);
      const weekLabel = (displayMonth.month + 1) + '月第' + weekNo + '周';
      const missingWeekData = getWeekMonthKeys(weeks[wi]).some(function(key) {
        return monthKeys.includes(key) && !isUsageMonthComplete(key);
      });
      const totalEl = document.createElement('div');
      totalEl.className = 'ds-week-summary';
      if (missingWeekData) totalEl.style.opacity = '0.46';
      totalEl.innerHTML =
        '<span>' + weekLabel + '</span>' +
        '<span class="ds-week-cost">' + unit + summary.totalCost.toFixed(2) + '</span>' +
        '<span class="ds-week-token">' + fmtNumShort(summary.totalTokens) + '</span>' +
        '<span class="ds-week-requests">' + summary.totalRequests.toLocaleString() + '</span>' +
        '<span class="ds-week-hitrate">' + (summary.overallHitRate !== null ? summary.overallHitRate.toFixed(1) + '%' : '—') + '</span>';
      totalEl.addEventListener('mouseenter', function(e) {
        showWeekTooltip(e, weekLabel, summary);
      });
      totalEl.addEventListener('mouseleave', function() { hideCalendarTooltip(); });
      grid.appendChild(totalEl);
    }

    container.appendChild(grid);
    if (weekAutoScrollMonthKey) {
      const target = grid.querySelector('[data-week-month-key="' + weekAutoScrollMonthKey + '"]');
      if (target) {
        setTimeout(function() {
          target.scrollIntoView({ block: 'start' });
        }, 0);
        weekAutoScrollMonthKey = null;
      }
    }
  }

  function createCalendarOverlay() {
    if (calendarOverlay) return;
    const overlay = document.createElement('div');
    overlay.id = 'ds-calendar-overlay';
    overlay.style.cssText = `
      position: fixed;
      z-index: 100000;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
      padding: 8px;
      width: 290px;
      min-width: 290px;
      max-width: 290px;
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
    calendarOverlay.style.display = 'block';
    // 从当前页面数据确定显示的月份
    updateCalendarMonthFromData();
    if (currentViewMode === 'week') {
      weekAutoScrollMonthKey = monthKey(currentCalendarYear, currentCalendarMonth);
    }
    // 重新渲染内容
    calendarOverlay.innerHTML = '';
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '12px';
    header.style.padding = '0 4px';
    var navBtnStyle = 'background:none;border:none;cursor:pointer;font-size:12px;padding:2px 8px;border-radius:4px;opacity:0.7';
    var navBtnHover = 'background:rgba(128,128,128,0.15);opacity:1';
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '◀';
    prevBtn.style.cssText = navBtnStyle;
    prevBtn.title = '上个月';
    prevBtn.addEventListener('mouseenter', function() { if (!prevBtn.disabled) prevBtn.style.cssText = navBtnStyle + ';' + navBtnHover; });
    prevBtn.addEventListener('mouseleave', function() {
      prevBtn.style.cssText = navBtnStyle + (prevBtn.disabled ? ';opacity:0.22;cursor:not-allowed' : '');
    });
    prevBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (prevBtn.disabled) return;
      changeCalendarMonth(-1);
    });
    const monthYear = document.createElement('span');
    monthYear.style.fontWeight = '600';
    monthYear.style.fontSize = '13px';
    monthYear.title = '使用左右按钮切换页面月份并加载对应用量';
    const updateMonthYear = () => {
      monthYear.textContent = currentCalendarYear + '年 ' + (currentCalendarMonth + 1) + '月';
    };
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '▶';
    nextBtn.style.cssText = navBtnStyle;
    nextBtn.title = '下个月';
    nextBtn.addEventListener('mouseenter', function() { if (!nextBtn.disabled) nextBtn.style.cssText = navBtnStyle + ';' + navBtnHover; });
    nextBtn.addEventListener('mouseleave', function() {
      nextBtn.style.cssText = navBtnStyle + (nextBtn.disabled ? ';opacity:0.22;cursor:not-allowed' : '');
    });
    nextBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (nextBtn.disabled) return;
      changeCalendarMonth(1);
    });

    function applyNavButtonState(btn, enabled) {
      btn.disabled = !enabled;
      btn.style.cssText = navBtnStyle + (enabled ? '' : ';opacity:0.22;cursor:not-allowed');
    }

    function updateNavButtons() {
      const hasMonthSelect = !!getUsageMonthSelect();
      const prevTarget = addMonths(currentCalendarYear, currentCalendarMonth, -1);
      const nextTarget = addMonths(currentCalendarYear, currentCalendarMonth, 1);
      applyNavButtonState(prevBtn, !hasMonthSelect || canSelectUsageMonth(prevTarget.year, prevTarget.month));
      applyNavButtonState(nextBtn, !hasMonthSelect || canSelectUsageMonth(nextTarget.year, nextTarget.month));
    }

    function changeCalendarMonth(delta) {
      const target = addMonths(currentCalendarYear, currentCalendarMonth, delta);
      const hasMonthSelect = !!getUsageMonthSelect();
      if (hasMonthSelect) {
        if (!selectUsageMonth(target.year, target.month)) return;
      } else {
        currentCalendarYear = target.year;
        currentCalendarMonth = target.month;
        calendarCursorDate = null;
        hideCalendarTooltip();
        if (currentViewMode === 'range') {
          rangePhase = 'select-start';
          rangeStartDate = null;
          rangeEndDate = null;
        }
      }
      if (currentViewMode === 'week') {
        weekAutoScrollMonthKey = monthKey(currentCalendarYear, currentCalendarMonth);
      }
      renderCalendarContent();
    }

    header.appendChild(prevBtn);
    header.appendChild(monthYear);
    header.appendChild(nextBtn);
    calendarOverlay.appendChild(header);

    // 视图切换标签
    const tabsDiv = document.createElement('div');
    tabsDiv.className = 'ds-view-tabs';
    var tabs = ['month', 'week', 'range'];
    var tabLabels = { month: '月', week: '周', range: '范围' };
    for (var ti = 0; ti < tabs.length; ti++) {
      (function(mode) {
        var tab = document.createElement('button');
        tab.className = 'ds-view-tab' + (mode === currentViewMode ? ' active' : '');
        tab.textContent = tabLabels[mode];
        tab.addEventListener('click', function(e) {
          e.stopPropagation();
          if (mode !== currentViewMode) {
            currentViewMode = mode;
            if (mode === 'range') {
              rangePhase = 'select-start';
              rangeStartDate = null;
              rangeEndDate = null;
            }
            if (mode === 'week') {
              weekAutoScrollMonthKey = monthKey(currentCalendarYear, currentCalendarMonth);
            }
            renderCalendarContent();
          }
        });
        tabsDiv.appendChild(tab);
      })(tabs[ti]);
    }
    calendarOverlay.appendChild(tabsDiv);

    // 月份切换提示（页面月份 ≠ 显示月份时显示）
    const monthWarning = document.createElement('div');
    monthWarning.id = 'ds-month-warning';
    monthWarning.style.cssText = 'text-align:center;font-size:10px;opacity:0.7;padding:2px 0 6px;display:none';
    monthWarning.textContent = '';
    calendarOverlay.appendChild(monthWarning);

    const calendarContainer = document.createElement('div');
    calendarContainer.id = 'ds-calendar-grid';
    calendarOverlay.appendChild(calendarContainer);

    // 范围指示器
    const rangeIndicator = document.createElement('div');
    rangeIndicator.className = 'ds-range-indicator';
    calendarOverlay.appendChild(rangeIndicator);

    function updateViewTabs() {
      var btns = tabsDiv.querySelectorAll('.ds-view-tab');
      for (var i = 0; i < btns.length; i++) {
        btns[i].className = 'ds-view-tab' + (tabs[i] === currentViewMode ? ' active' : '');
      }
    }

    function setupRangeSelection() {
      var cells = calendarContainer.querySelectorAll('.ds-calendar-day');
      for (var i = 0; i < cells.length; i++) {
        (function(span) {
          // 使用 data-date 属性
          var td = span.closest('td');
          if (!td) return;
          var dateStr = td.getAttribute('data-date');
          if (!dateStr) return;

          // 替换 click 事件（移除原有监听 + 新增范围选择行为）
          var newSpan = span.cloneNode(true);
          span.parentNode.replaceChild(newSpan, span);

          newSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            if (rangePhase === 'select-start') {
              rangeStartDate = dateStr;
              rangePhase = 'select-end';
              renderCalendarContent();
            } else if (rangePhase === 'select-end') {
              // 确保结束日期 ≥ 起始日期
              if (dateStr < rangeStartDate) {
                rangeEndDate = rangeStartDate;
                rangeStartDate = dateStr;
              } else {
                rangeEndDate = dateStr;
              }
              rangePhase = 'done';
              renderCalendarContent();
            }
          });

          // 保留 hover tooltip
          var dayData = dailyDataMap.get(dateStr);
          if (dayData) {
            newSpan.addEventListener('mouseenter', function(e) { showCalendarTooltip(e, dayData); });
            newSpan.addEventListener('mouseleave', function() { hideCalendarTooltip(); });
          }
        })(cells[i]);
      }
    }

    function highlightRange() {
      if (!rangeStartDate) return;
      var start = new Date(rangeStartDate + 'T00:00:00Z');
      var end = rangeEndDate ? new Date(rangeEndDate + 'T00:00:00Z') : null;

      var allTds = calendarContainer.querySelectorAll('td[data-date]');
      for (var i = 0; i < allTds.length; i++) {
        (function(td) {
          var span = td.querySelector('.ds-calendar-day');
          if (!span) return;
          var dateStr = td.getAttribute('data-date');
          var d = new Date(dateStr + 'T00:00:00Z');

          if (end && d >= start && d <= end) {
            span.classList.add('range-cell');
            if (dateStr === rangeStartDate) span.classList.add('range-start');
            else if (dateStr === rangeEndDate) span.classList.add('range-end');
            else span.classList.add('range-mid');
          } else if (!end && dateStr === rangeStartDate) {
            span.classList.add('range-start');
          }
        })(allTds[i]);
      }
    }

    var renderCalendarContent = function() {
      calendarContainer.innerHTML = '';
      rangeIndicator.innerHTML = '';
      updateMonthYear();
      updateViewTabs();
      updateNavButtons();

      // 检测页面月份与接口数据是否已同步到当前日历月份
      var _pg = getPageMonth();
      var _warningEl = document.getElementById('ds-month-warning');
      var _sameAsPageMonth = _pg.year === currentCalendarYear && _pg.month === currentCalendarMonth;
      var _loadingMonth = isCalendarMonthLoading();
      if (_warningEl) {
        if (!_sameAsPageMonth) {
          _warningEl.textContent = '请使用上方月份按钮加载该月份数据';
          _warningEl.style.display = 'block';
        } else if (_loadingMonth) {
          _warningEl.textContent = '正在加载该月份用量…';
          _warningEl.style.display = 'block';
        } else {
          _warningEl.textContent = '';
          _warningEl.style.display = 'none';
        }
      }
      if (_loadingMonth) {
        const loading = document.createElement('div');
        loading.className = 'ds-no-data';
        loading.style.padding = '20px 0';
        loading.textContent = '正在加载该月份用量…';
        calendarContainer.appendChild(loading);
        return;
      }

      if (currentViewMode === 'month') {
        renderCalendar(calendarContainer, currentCalendarYear, currentCalendarMonth);
        var summary = buildMonthlySummary(currentCalendarYear, currentCalendarMonth);
        calendarContainer.appendChild(summary);
      } else if (currentViewMode === 'week') {
        renderWeekView(calendarContainer, currentCalendarYear, currentCalendarMonth);
      } else if (currentViewMode === 'range') {
        renderCalendar(calendarContainer, currentCalendarYear, currentCalendarMonth);
        // 范围模式提示
        if (rangePhase === 'select-start') {
          rangeIndicator.textContent = '请点击起始日期';
        } else if (rangePhase === 'select-end') {
          rangeIndicator.textContent = '请点击结束日期';
        } else if (rangePhase === 'done' && rangeStartDate && rangeEndDate) {
          rangeIndicator.innerHTML = '已选择 <b>' + rangeStartDate + '</b> 至 <b>' + rangeEndDate + '</b>';
        } else if (rangePhase === 'idle') {
          // 数据刷新后自动进入起始选择模式
          rangePhase = 'select-start';
          rangeIndicator.textContent = '请点击起始日期';
        }
        // 替换 click 行为为范围选择
        setupRangeSelection();
        // 高亮已选范围
        if (rangeStartDate) highlightRange();
        // 范围统计
        if (rangePhase === 'done' && rangeStartDate && rangeEndDate) {
          var rangeSummary = buildRangeSummary(rangeStartDate, rangeEndDate);
          var summaryDiv = document.createElement('div');
          summaryDiv.className = 'ds-calendar-summary';
          summaryDiv.innerHTML =
            '<span style="width:100%">范围合计</span>' +
            '<span>费用 <b>￥' + rangeSummary.totalCost.toFixed(2) + '</b></span>' +
            '<span>Token <b>' + fmtNumShort(rangeSummary.totalTokens) + '</b></span>' +
            '<span>请求 <b>' + rangeSummary.totalRequests.toLocaleString() + '</b></span>' +
            '<span class="ds-sum-break"></span>' +
            '<span>Pro ' + fmtNumShort(rangeSummary.proTokens) + '</span>' +
            '<span>Flash ' + fmtNumShort(rangeSummary.flashTokens) + '</span>' +
            '<span>天数 ' + rangeSummary.dayCount + '</span>' +
            '<span>缓存 <b>' + (rangeSummary.overallHitRate !== null ? rangeSummary.overallHitRate.toFixed(1) + '%' : '—') + '</b></span>';
          calendarContainer.appendChild(summaryDiv);
          // 清除范围按钮
          var clearBtn = document.createElement('div');
          clearBtn.className = 'ds-range-clear';
          clearBtn.textContent = '清除范围，重新选择';
          clearBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            rangePhase = 'select-start';
            rangeStartDate = null;
            rangeEndDate = null;
            renderCalendarContent();
          });
          calendarContainer.appendChild(clearBtn);
        }
      }
    };
    calendarRefreshFn = renderCalendarContent;
    renderCalendarContent();

    // 内容渲染后重新定位，确保不遮挡监控面板
    var _panelEl = document.getElementById('ds-monitor-panel');
    if (_panelEl) {
      var _panelRect = _panelEl.getBoundingClientRect();
      var _calW = calendarOverlay.offsetWidth || 320;
      calendarOverlay.style.top = Math.max(8, _panelRect.top) + 'px';
      calendarOverlay.style.left = Math.max(8, _panelRect.left - _calW - 8) + 'px';
      calendarOverlay.style.right = 'auto';
    }

    // 键盘导航
    function onCalendarKeydown(e) {
      if (!calendarOverlay || calendarOverlay.style.display !== 'block') return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        if (currentViewMode === 'month') {
          changeCalendarMonth(e.key === 'ArrowRight' ? 1 : -1);
          return;
        }

        if (!calendarCursorDate) {
          // 首次按键：从当天或当月首日开始
          var d = new Date();
          if (d.getFullYear() !== currentCalendarYear || d.getMonth() !== currentCalendarMonth) {
            d = new Date(currentCalendarYear, currentCalendarMonth, 1);
          }
          calendarCursorDate = localDateStr(d);
        }

        var parts = calendarCursorDate.split('-');
        var cur = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        cur.setDate(cur.getDate() + (e.key === 'ArrowRight' ? 1 : -1));

        // 限制在当前月份内
        var first = new Date(currentCalendarYear, currentCalendarMonth, 1);
        var last = new Date(currentCalendarYear, currentCalendarMonth + 1, 0);
        if (cur < first) cur = first;
        if (cur > last) cur = last;

        calendarCursorDate = localDateStr(cur);
        renderCalendarContent();

        // 有数据时显示 tooltip
        var dayData = dailyDataMap.get(calendarCursorDate);
        if (dayData) {
          var focusedEl = calendarOverlay.querySelector('[data-date="' + calendarCursorDate + '"] .ds-calendar-day');
          if (focusedEl) {
            showCalendarTooltip({ target: focusedEl }, dayData);
          }
        } else {
          hideCalendarTooltip();
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        var targetDate = calendarCursorDate || selectedDate;
        if (targetDate && dailyDataMap.has(targetDate)) {
          showDateDetail(targetDate);
          closeCalendar();
        }
        return;
      }

      if (e.key === 'Escape') {
        closeCalendar();
        return;
      }
    }

    document.addEventListener('keydown', onCalendarKeydown);
    calendarOverlay._keydownHandler = onCalendarKeydown;
  }

  function closeCalendar() {
    if (calendarOverlay) {
      calendarOverlay.style.display = 'none';
      // 移除键盘监听
      if (calendarOverlay._keydownHandler) {
        document.removeEventListener('keydown', calendarOverlay._keydownHandler);
        calendarOverlay._keydownHandler = null;
      }
      calendarCursorDate = null;
    }
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
