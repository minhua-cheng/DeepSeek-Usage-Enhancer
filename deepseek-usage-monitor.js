// ==UserScript==
// @name         DeepSeek Daily Monitor
// @namespace    https://github.com/local/deepseek-usage-monitor
// @version      1.1.2
// @description  拦截 DeepSeek 开放平台用量 API，在小窗口中展示完整数据（纯本地，无远程通信）
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

  // 缓存各接口的最新原始数据
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

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function log(msg) {
    console.log('[DS Monitor] ' + msg);
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
      : { balance: { total: 0, normal_wallet_balance: 0, bonus_wallet_balance: 0, currency: 'CNY' }, monthly_consumption: { amount: 0, currency: 'CNY' } };

    let usageData = { today_date: utcToday(), models: {} };
    if (rawUsageAmount) {
      usageData = transformUsageAmount(rawUsageAmount);
    }

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost) {
      costData = transformUsageCost(rawUsageCost);
    }

    return {
      timestamp: new Date().toISOString(),
      ...summary,
      ...usageData,
      ...costData,
    };
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
      updatePanelData(payload);
      updateStatus(payload);
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

  // 创建一个可点击切换短格式/原始数字的值元素
  function makeToggleValue(n) {
    const span = document.createElement('span');
    span.className = 'ds-value';
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
    return '¥' + val.toFixed(2);
  }

  function fmtPercent(n) {
    if (n === undefined || n === null || n === '') return '—';
    return Number(n).toFixed(1) + '%';
  }

  // ============================================================
  // 面板
  // ============================================================
  const PANEL_POS_KEY = 'ds_monitor_panel_pos';

  function loadPanelPos() {
    try {
      const saved = localStorage.getItem(PANEL_POS_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { top: 60, left: null, right: 12, width: 300, collapsed: false };
  }

  function savePanelPos(pos) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
  }

  let panelPos = loadPanelPos();
  let panelDataEl = null;
  let lastPayload = null;

  function injectPanel() {
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
      'width: ' + (pos.width || 300) + 'px;';

    panel.innerHTML = `
      <style>
        #ds-monitor-panel {
          position: fixed; z-index: 99999;
          background: #1a1a2e; color: #e0e0e0; border: 1px solid #333;
          border-radius: 8px; font-size: 12px; font-family: monospace;
          box-shadow: 0 4px 12px rgba(0,0,0,0.5);
          display: flex; flex-direction: column; overflow: hidden;
          user-select: none; min-width: 220px;
        }
        #ds-monitor-panel .ds-titlebar {
          display: flex; justify-content: space-between; align-items: center;
          padding: 5px 10px; background: #1e1e36; border-bottom: 1px solid #333;
          border-radius: 8px 8px 0 0; cursor: move; flex-shrink: 0; gap: 4px;
        }
        #ds-monitor-panel.ds-collapsed .ds-titlebar { border-radius: 8px 8px 8px 8px; border-bottom: none; }
        #ds-monitor-panel .ds-titlebar .title {
          font-weight: bold; color: #4fc3f7; font-size: 13px; flex: 1;
        }
        #ds-monitor-panel .ds-titlebar button {
          background: none; border: none; color: #888; cursor: pointer;
          font-size: 14px; line-height: 1; padding: 0 3px; margin: 0;
        }
        #ds-monitor-panel .ds-titlebar .ds-collapse:hover { color: #4fc3f7; }
        #ds-monitor-panel .ds-body {
          padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; min-height: 0;
        }
        #ds-monitor-panel .ds-body::-webkit-scrollbar { width: 4px; }
        #ds-monitor-panel .ds-body::-webkit-scrollbar-track { background: transparent; }
        #ds-monitor-panel .ds-body::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
        #ds-monitor-panel .ds-section-title {
          color: #81d4fa; font-weight: bold; margin: 6px 0 4px; font-size: 12px;
          border-bottom: 1px solid #2a2a3e; padding-bottom: 2px;
        }
        #ds-monitor-panel .ds-section-title:first-child { margin-top: 0; }
        #ds-monitor-panel .ds-row {
          display: flex; justify-content: space-between; margin: 2px 0; gap: 12px;
        }
        #ds-monitor-panel .ds-row .ds-label { color: #aaa; white-space: nowrap; }
        #ds-monitor-panel .ds-row .ds-value { color: #e0e0e0; text-align: right; word-break: break-all; }
        #ds-monitor-panel .ds-divider {
          border: none; border-top: 1px solid #2a2a3e; margin: 6px 0;
        }
        #ds-monitor-panel .ds-statusbar {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          padding: 5px 10px; border-top: 1px solid #333; background: #1e1e36;
          border-radius: 0 0 8px 8px; flex-shrink: 0; font-size: 11px;
        }
        #ds-monitor-panel.ds-collapsed .ds-statusbar { border-radius: 0; border-top: none; display: none; }
        #ds-monitor-panel .ds-model-block {
          background: #1e1e36; border-radius: 4px; padding: 5px 8px; margin: 4px 0;
        }
        #ds-monitor-panel .ds-model-name { color: #ffcc80; font-weight: bold; font-size: 11px; margin-bottom: 2px; }
        #ds-monitor-panel .ds-no-data { color: #666; text-align: center; padding: 12px 0; }
      </style>
      <div class="ds-titlebar" id="ds-titlebar">
        <span class="title">DeepSeek Daily Monitor</span>
        <button class="ds-collapse" id="ds-collapse-btn" title="收起/展开">${pos.collapsed ? '▶' : '▼'}</button>
      </div>
      <div class="ds-body" id="ds-body">
        <div class="ds-no-data" id="ds-no-data">等待数据…</div>
        <div id="ds-data-content" style="display:none;"></div>
      </div>
      <div class="ds-statusbar" id="ds-statusbar"></div>
    `;
    document.body.appendChild(panel);

    panelDataEl = document.getElementById('ds-data-content');

    if (lastPayload) {
      updatePanelData(lastPayload);
      updateStatus(lastPayload);
    }

    if (pos.collapsed) {
      panel.classList.add('ds-collapsed');
      document.getElementById('ds-body').style.display = 'none';
    }

    // --- 拖拽 ---
    const titleBar = document.getElementById('ds-titlebar');
    let dragInfo = null;

    titleBar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
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
      panelPos.top = rect.top;
      panelPos.left = rect.left;
      panelPos.right = null;
      savePanelPos(panelPos);
    });

    // --- 折叠/展开 ---
    const collapseBtn = document.getElementById('ds-collapse-btn');
    const bodyEl = document.getElementById('ds-body');

    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = panel.classList.toggle('ds-collapsed');
      bodyEl.style.display = collapsed ? 'none' : '';
      collapseBtn.textContent = collapsed ? '▶' : '▼';
      panelPos.collapsed = collapsed;
      savePanelPos(panelPos);
    });

    // --- 点击切换原始数字 ---
    panel.addEventListener('click', (e) => {
      const span = e.target.closest('[data-short]');
      if (!span) return;
      const showing = span.textContent === span.getAttribute('data-raw');
      span.textContent = showing
        ? span.getAttribute('data-short')
        : span.getAttribute('data-raw');
    });
  }

  // ============================================================
  // 更新面板数据
  // ============================================================

  function updatePanelData(payload) {
    if (!panelDataEl) {
      lastPayload = payload;
      return;
    }

    const noDataEl = document.getElementById('ds-no-data');
    if (!payload || !payload.timestamp) {
      if (noDataEl) noDataEl.style.display = '';
      panelDataEl.style.display = 'none';
      return;
    }

    if (noDataEl) noDataEl.style.display = 'none';
    panelDataEl.style.display = '';
    panelDataEl.innerHTML = '';

    const balance = payload.balance || {};
    const monthly = payload.monthly_consumption || {};
    const todayCost = payload.today_cost || {};
    const models = payload.models || {};
    const ts = payload.timestamp ? new Date(payload.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

    // 账户余额 标题行
    const titleRow = document.createElement('div');
    titleRow.className = 'ds-row';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'ds-section-title';
    titleSpan.style.cssText = 'border-bottom:none;margin:0;';
    titleSpan.textContent = '账户余额';
    const timeSpan = document.createElement('span');
    timeSpan.style.cssText = 'font-weight:normal;color:#666;font-size:10px;flex-shrink:0;';
    timeSpan.textContent = ts;
    titleRow.appendChild(titleSpan);
    titleRow.appendChild(timeSpan);
    panelDataEl.appendChild(titleRow);

    // 余额行
    panelDataEl.appendChild(makeLabelValueRow('充值余额', document.createTextNode(fmtMoney(balance.total))));
    panelDataEl.appendChild(makeLabelValueRow('本月消费', document.createTextNode(fmtMoney(monthly.amount))));
    panelDataEl.appendChild(makeLabelValueRow('今日消费', document.createTextNode(fmtMoney(todayCost.amount))));

    // 各模型
    const modelNames = Object.keys(models);
    if (modelNames.length > 0) {
      const hr = document.createElement('hr');
      hr.className = 'ds-divider';
      panelDataEl.appendChild(hr);

      for (const name of modelNames) {
        const m = models[name];
        const mLower = name.toLowerCase();
        let shortName = name;
        if (mLower.includes('flash')) shortName = 'deepseek-v4-Flash';
        else if (mLower.includes('pro')) shortName = 'deepseek-v4-pro';

        const block = document.createElement('div');
        block.className = 'ds-model-block';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'ds-model-name';
        nameDiv.textContent = shortName;
        block.appendChild(nameDiv);

        // 请求数
        block.appendChild(makeLabelValueRow('请求数', makeToggleValue(m.requests)));

        if (m.tokens) {
          block.appendChild(makeLabelValueRow('总Token', makeToggleValue(m.tokens.total)));
          block.appendChild(makeIndentRow('命中缓存', makeToggleValue(m.tokens.cached_input)));
          block.appendChild(makeIndentRow('未命中', makeToggleValue(m.tokens.uncached_input)));
          block.appendChild(makeIndentRow('输出', makeToggleValue(m.tokens.output)));
        }

        const hitVal = document.createElement('span');
        hitVal.className = 'ds-value';
        hitVal.textContent = fmtPercent(m.cache_hit_rate);
        block.appendChild(makeLabelValueRow('缓存命中率', hitVal));

        panelDataEl.appendChild(block);
      }
    }
  }

  function makeLabelValueRow(labelText, valueEl) {
    const row = document.createElement('div');
    row.className = 'ds-row';
    const lbl = document.createElement('span');
    lbl.className = 'ds-label';
    lbl.textContent = labelText;
    if (valueEl.className !== 'ds-value') valueEl.className = 'ds-value';
    row.appendChild(lbl);
    row.appendChild(valueEl);
    return row;
  }

  function makeIndentRow(labelText, valueEl) {
    const row = document.createElement('div');
    row.className = 'ds-row';
    const lbl = document.createElement('span');
    lbl.className = 'ds-label';
    lbl.style.cssText = 'padding-left:8px;color:#888;';
    lbl.textContent = labelText;
    if (valueEl.className === 'ds-value') valueEl.style.color = '#aaa';
    else { valueEl.className = 'ds-value'; valueEl.style.color = '#aaa'; }
    row.appendChild(lbl);
    row.appendChild(valueEl);
    return row;
  }

  function updateStatus(payload) {
    const el = document.getElementById('ds-statusbar');
    if (!el) return;
    const totalRequests = Object.values(payload.models || {}).reduce((s, m) => s + (m.requests || 0), 0);
    const totalTokens = Object.values(payload.models || {}).reduce((s, m) => s + (m.tokens ? m.tokens.total : 0), 0);

    el.innerHTML = '';
    const tokenLabel = document.createElement('span');
    tokenLabel.style.cssText = 'color:#aaa;';
    tokenLabel.textContent = '总Token:';
    el.appendChild(tokenLabel);
    el.appendChild(makeToggleValue(totalTokens));
    const sep = document.createElement('span');
    sep.style.cssText = 'color:#555;margin:0 6px;';
    sep.textContent = '|';
    el.appendChild(sep);
    const reqLabel = document.createElement('span');
    reqLabel.style.cssText = 'color:#aaa;';
    reqLabel.textContent = '总请求:';
    el.appendChild(reqLabel);
    const reqVal = document.createElement('span');
    reqVal.className = 'ds-value';
    reqVal.textContent = totalRequests.toLocaleString() + ' 次';
    el.appendChild(reqVal);
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek Usage Monitor 已加载（纯本地模式）');

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
