/* ============================================================
   全球城市数据看板 — app.js (ES module + Anime.js v4)
   数据层 / 地图层 / 图表层 / UI交互层 / 动画层
   ============================================================ */

import { animate, stagger, createTimeline } from 'https://esm.sh/animejs@4';

var STATE = {
  cities: [], filteredCities: [], activeCityId: null,
  mapInstance: null, mapTileLayer: null, markers: {},
  chartTreemap: null, chartSunburst: null, chartBar: null,
  chartGdpTrend: null, chartRadar: null,
  maxGdp: 0, logLines: [], libsReady: false,
  theme: 'light', particleColor: 'rgba(26,108,245,0.12)',
  compareMode: false, compareIds: [],
  highlightedIndex: -1,
  intervals: [], respTimers: [],
  _tileFallbackTriggered: false,
  _breathId: null,
};

// ============================================================
// === 工具函数 ===
// ============================================================

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function debounce(fn, ms) {
  var t; return function () { var ctx = this, args = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, args); }, ms); };
}

function addInterval(id) { STATE.intervals.push(id); return id; }

function clearAllIntervals() {
  STATE.intervals.forEach(function (id) { clearInterval(id); });
  STATE.intervals = [];
  if (STATE._breathId) { clearInterval(STATE._breathId); STATE._breathId = null; }
}

// ============================================================
// === 数据层 ===
// ============================================================

function fetchCityData() {
  return fetch('cities.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function (d) { console.log('[数据] fetch 成功 — '+d.length+' 城市'); applyCityData(d); return d; })
    .catch(function (e) {
      console.warn('[数据] fetch 失败，降级内嵌:', e.message);
      var el = document.getElementById('cities-embedded');
      if (el && el.textContent && el.textContent.trim().length > 10) {
        try { var d = JSON.parse(el.textContent.trim()); console.log('[数据] 内嵌加载 — '+d.length+' 城市'); applyCityData(d); return d; }
        catch (ex) { console.error('[数据] 内嵌解析失败:', ex); }
      }
      STATE.cities = []; STATE.filteredCities = []; return [];
    });
}

// 综合实力评分辅助函数
function scoreLivability(c) {
  var l = String(c.livability || '');
  if (l.indexOf('极高')!==-1 || l.indexOf('全球最')!==-1) return 95;
  if (l.indexOf('高')!==-1) return 78;
  if (l.indexOf('中高')!==-1) return 62;
  if (l.indexOf('中等')!==-1 || l.indexOf('受通胀')!==-1) return 48;
  if (l.indexOf('偏低')!==-1) return 35;
  if (l.indexOf('低')!==-1) return 22;
  return 50;
}
function scoreInfra(c) {
  var s = 40;
  var ship = String(c.shippingIndex || '');
  if (ship.indexOf('全球')!==-1 || ship.indexOf('顶级')!==-1) s += 35;
  else if (ship.indexOf('枢纽')!==-1 || ship.indexOf('前十')!==-1) s += 25;
  else if (ship.indexOf('沿海')!==-1 || ship.indexOf('港口')!==-1) s += 15;
  else if (ship.indexOf('内陆')!==-1) s += 5;
  if (c.stockExchange) s += 20;
  var fr = String(c.financeRating || '');
  if (fr.indexOf('全球')!==-1) s += 20;
  else if (fr.length > 2) s += 12;
  else if (fr.indexOf('新兴')!==-1) s += 6;
  return Math.min(s, 100);
}
function scoreIndustry(c) {
  var inds = c.industries || [];
  if (!inds.length) return 30;
  var total = 0;
  for (var i = 0; i < inds.length; i++) total += inds[i].value || 0;
  return Math.min(inds.length * 10 + total * 0.12, 100);
}

function applyCityData(data) {
  var maxGdp = 0, maxFin = 0, maxGrowth = 0, maxPc = 0, maxPop = 0;
  var maxInd = 0, maxLive = 0, maxInfra = 0;
  data.forEach(function (c) {
    var gRMB = (c.currency === 'USD') ? Math.round(c.gdp * 7.2) : c.gdp;
    c._gdpRMB = gRMB;
    c.gdpPerCapita = c.population > 0 ? (c.gdp / c.population).toFixed(1) : '--';
    c.gdpPerCapitaRMB = c.population > 0 ? (c._gdpRMB / c.population).toFixed(1) : '--';
    c._indScore = scoreIndustry(c);
    c._liveScore = scoreLivability(c);
    c._infraScore = scoreInfra(c);
    if (gRMB > maxGdp) maxGdp = gRMB;
    if (parseFloat(c.gdpPerCapitaRMB || 0) > maxPc) maxPc = parseFloat(c.gdpPerCapitaRMB || 0);
    if ((c.financeIndex || 0) > maxFin) maxFin = c.financeIndex || 0;
    if ((c.growthRate || 0) > maxGrowth) maxGrowth = Math.abs(c.growthRate || 0);
    if (c.population > maxPop) maxPop = c.population;
    if (c._indScore > maxInd) maxInd = c._indScore;
    if (c._liveScore > maxLive) maxLive = c._liveScore;
    if (c._infraScore > maxInfra) maxInfra = c._infraScore;
  });
  // 8-dimension weighted formula: GDP(25)+pc(15)+pop(8)+fin(15)+gr(8)+ind(12)+live(10)+infra(7)
  data.forEach(function (c) {
    var pc = parseFloat(c.gdpPerCapitaRMB || 0);
    var composite = 0;
    composite += (c._gdpRMB / Math.max(maxGdp, 1)) * 25;
    composite += (pc / Math.max(maxPc, 1)) * 15;
    composite += (c.population / Math.max(maxPop, 1)) * 8;
    composite += ((c.financeIndex || 0) / Math.max(maxFin, 1)) * 15;
    composite += (Math.abs(c.growthRate || 0) / Math.max(maxGrowth, 1)) * 8;
    composite += (c._indScore / Math.max(maxInd, 1)) * 12;
    composite += (c._liveScore / Math.max(maxLive, 1)) * 10;
    composite += (c._infraScore / Math.max(maxInfra, 1)) * 7;
    c.compositeScore = Math.round(composite * 10) / 10;
  });
  STATE.cities = data;
  STATE.filteredCities = data.slice();
  STATE.maxGdp = maxGdp;
  if (data.length > 0) STATE.activeCityId = data[0].id;
}

function getCityById(id) {
  for (var i = 0; i < STATE.cities.length; i++) { if (STATE.cities[i].id === id) return STATE.cities[i]; }
  return null;
}

function computeRankings() {
  return STATE.cities.slice().sort(function (a, b) { return b.compositeScore - a.compositeScore; });
}

// ============================================================
// === UI 交互层 ===
// ============================================================

function formatGDP(gdp, currency) {
  var sym = (currency === 'USD') ? '$' : '¥';
  if (gdp >= 10000) return sym + (gdp / 10000).toFixed(2) + '万亿';
  return sym + gdp.toFixed(0) + '亿';
}

// ---- 城市卡片内嵌抽屉 ----
function toggleCityDrawer(cityId, li) {
  var city = getCityById(cityId);
  if (!city) return;
  // Close any other open drawer
  var openDrawers = document.querySelectorAll('.city-card-drawer.open');
  openDrawers.forEach(function (d) {
    if (d.getAttribute('data-city-id') !== cityId) {
      d.classList.remove('open');
    }
  });
  // Toggle this one
  var drawer = document.querySelector('.city-card-drawer[data-city-id="' + cityId + '"]');
  if (!drawer) {
    // Create drawer
    drawer = document.createElement('div');
    drawer.className = 'city-card-drawer';
    drawer.setAttribute('data-city-id', cityId);
    var sym = city.currency === 'USD' ? '$' : '¥';
    var tags = (city.tags || []).slice(0, 3);
    var tagsHtml = '';
    var tc = ['tag-blue', 'tag-orange'];
    tags.forEach(function (t, i) { tagsHtml += '<span class="tag-capsule sm ' + tc[i % 2] + '">' + t + '</span>'; });
    drawer.innerHTML = '<div class="city-card-inner">'
      + '<div class="city-card-stats"><span>GDP: <b>' + formatGDP(city.gdp, city.currency) + '</b></span><span>人口: <b>' + city.population + '万</b></span><span>人均: <b>' + sym + (city.gdpPerCapita || '--') + '万</b></span></div>'
      + '<div class="city-card-tags">' + tagsHtml + '</div>'
      + '<button class="city-card-action">查看详情 →</button></div>';
    li.parentNode.insertBefore(drawer, li.nextSibling);
    // Click "查看详情" → actually select city
    drawer.querySelector('.city-card-action').addEventListener('click', function (e) {
      e.stopPropagation();
      drawer.classList.remove('open');
      onCitySelect(cityId, 'list');
    });
    // Prevent clicks inside drawer from closing it
    drawer.addEventListener('click', function (e) { e.stopPropagation(); });
    // Animate open
    requestAnimationFrame(function () { drawer.classList.add('open'); });
  } else {
    drawer.classList.toggle('open');
  }
}

function renderCityList() {
  var listEl = document.getElementById('cityList');
  var term = document.getElementById('citySearch').value.trim().toLowerCase();
  STATE.filteredCities = STATE.cities.filter(function (c) {
    if (!term) return true;
    return c.name.toLowerCase().indexOf(term) !== -1
      || c.id.toLowerCase().indexOf(term) !== -1
      || (c.ticker && c.ticker.toLowerCase().indexOf(term) !== -1)
      || (c.country && c.country.toLowerCase().indexOf(term) !== -1);
  });
  STATE.filteredCities.sort(function (a, b) { return b._gdpRMB - a._gdpRMB; });

  var maxG = STATE.filteredCities.length > 0 ? STATE.filteredCities[0]._gdpRMB : 1;
  var html = '';
  for (var i = 0; i < STATE.filteredCities.length; i++) {
    var city = STATE.filteredCities[i];
    var cls = city.id === STATE.activeCityId ? ' active' : '';
    cls += STATE.compareMode ? ' compare-visible' : '';
    if (STATE.compareMode && STATE.compareIds.length > 0 && STATE.compareIds.indexOf(city.id) === -1) cls += ' dimmed';
    var barW = ((city._gdpRMB || 0) / maxG * 100).toFixed(1);
    var checked = STATE.compareIds.indexOf(city.id) !== -1 ? ' checked' : '';
    html += '<li class="city-item' + cls + '" data-city-id="' + city.id + '">'
      + '<input type="checkbox" class="compare-cb"' + checked + ' data-city-id="' + city.id + '">'
      + '<span class="city-name">' + city.name + '</span>'
      + '<span class="city-ticker">' + (city.ticker || '--') + '</span>'
      + '<span class="city-gdp-wrap"><span class="city-gdp" id="gdp-' + city.id + '">' + formatGDP(city.gdp, city.currency) + '</span>'
      + '<span class="city-gdp-bar" style="width:' + barW + '%"></span></span>'
      + '</li>';
  }
  listEl.innerHTML = html;

  var items = listEl.querySelectorAll('.city-item');
  for (var j = 0; j < items.length; j++) {
    items[j].style.animationDelay = (j * 0.035) + 's';
    items[j].addEventListener('click', function (e) {
      if (e.target.classList.contains('compare-cb')) return;
      var cid = this.getAttribute('data-city-id');
      if (STATE.compareMode) {
        // In compare mode: toggle checkbox
        var cb = this.querySelector('.compare-cb');
        if (cb) { cb.checked = !cb.checked; handleCompareCheck(cid, cb.checked); }
      } else {
        toggleCityDrawer(cid, this);
      }
    });
  }

  // Compare checkboxes
  var cbs = listEl.querySelectorAll('.compare-cb');
  cbs.forEach(function (cb) {
    cb.addEventListener('click', function (e) {
      e.stopPropagation();
      handleCompareCheck(this.getAttribute('data-city-id'), this.checked);
    });
  });

  // Search result count
  var countEl = document.getElementById('searchCount');
  var iconEl = document.getElementById('searchIcon');
  if (term && countEl) {
    countEl.textContent = STATE.filteredCities.length;
    if (STATE.filteredCities.length === 0) countEl.classList.add('zero');
    else countEl.classList.remove('zero');
    countEl.style.display = '';
    if (iconEl) iconEl.style.display = 'none';
  } else if (countEl) {
    countEl.style.display = 'none';
    if (iconEl) iconEl.style.display = '';
  }

  document.getElementById('dataCount').textContent = STATE.cities.length + ' 城市';
  STATE.highlightedIndex = -1;
}

function handleCompareCheck(cityId, checked) {
  if (checked) {
    if (STATE.compareIds.length >= 4) { alert('最多对比 4 个城市'); return; }
    STATE.compareIds.push(cityId);
  } else {
    STATE.compareIds = STATE.compareIds.filter(function (id) { return id !== cityId; });
  }
  renderCityList();
  updateCompareRadar();
}

function updateCompareRadar() {
  if (!STATE.chartRadar) return;
  var cities = STATE.compareIds.map(function (id) { return getCityById(id); }).filter(Boolean);
  if (cities.length === 0) {
    // Fall back to single city with reference cities
    var ac = getCityById(STATE.activeCityId);
    if (ac) updateRadarChart(ac);
    return;
  }
  // Build radar for compared cities
  var maxVals = { gdp: 0, pop: 0, fin: 0, log: 0, live: 0 };
  cities.forEach(function (c) {
    if (c._gdpRMB > maxVals.gdp) maxVals.gdp = c._gdpRMB;
    if (c.population > maxVals.pop) maxVals.pop = c.population;
    if ((c.financeIndex || 0) > maxVals.fin) maxVals.fin = c.financeIndex || 0;
    maxVals.log = Math.max(maxVals.log, 100);
    maxVals.live = Math.max(maxVals.live, 100);
  });
  var radarData = [];
  var legendData = [];
  var PALETTE = ['#FF6B35','#1A6CF5','#34C759','#AF52DE'];
  cities.forEach(function (c, idx) {
    legendData.push(c.name);
    var sc = Math.min(c._gdpRMB / Math.max(maxVals.gdp, 1) * 100, 100);
    var sp = Math.min(c.population / Math.max(maxVals.pop, 1) * 100, 100);
    var sf = Math.min((c.financeIndex || 0) / Math.max(maxVals.fin, 1) * 100, 100);
    var sl = Math.min(((c.shippingIndex && c.shippingIndex !== '内陆城市' && c.shippingIndex !== '内陆高原城市') ? 80 : 40), 100);
    var sv = c.livability && c.livability.indexOf('高') !== -1 ? 80 : (c.livability && c.livability.indexOf('极') !== -1 ? 95 : 55);
    radarData.push({
      value: [sc, sp, sf, sl, sv], name: c.name,
      lineStyle: { color: PALETTE[idx], width: 2.5 },
      areaStyle: { color: PALETTE[idx], opacity: 0.08 },
      itemStyle: { color: PALETTE[idx] },
      symbol: 'circle', symbolSize: 6,
    });
  });
  STATE.chartRadar.setOption({
    animationDuration: 500, animationEasing: 'cubicOut',
    tooltip: { backgroundColor: cssVar('--bg-card'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text-primary'), fontFamily: 'PingFang SC,sans-serif' } },
    legend: { data: legendData, bottom: 0, textStyle: { color: cssVar('--text-secondary'), fontSize: 10, fontFamily: 'PingFang SC,sans-serif' } },
    radar: { center: ['50%','42%'], radius:'58%', indicator:[{name:'GDP',max:100},{name:'人口',max:100},{name:'金融',max:100},{name:'物流',max:100},{name:'宜居',max:100}], axisName:{color:cssVar('--text-secondary'),fontSize:9,fontFamily:'PingFang SC,sans-serif'}, splitArea:{areaStyle:{color:['#FAFAFA','#F5F5FA']}} },
    series: [{ type: 'radar', data: radarData }],
  }, true);
}

function onCitySelect(cityId, source) {
  if (STATE.activeCityId === cityId && source !== 'map') return;
  STATE.activeCityId = cityId;
  var city = getCityById(cityId);
  if (!city) return;

  var cp = document.querySelector('.center-panel');
  cp.classList.add('updating');
  setTimeout(function () {
    updateListHighlight(cityId);
    if (source === 'list' || source === 'ranking') highlightMapMarker(cityId);
    if (source === 'map') scrollToListCity(cityId);
    updateCityIntro(city);
    updateLivability(city);
    updateOppRisk(city);
    updateMetricGrid(city);
    updateGdpTrendChart(city);
    updateTagCloud(city);
    updateTreemapChart(city);
    updateSunburstChart(city);
    if (!STATE.compareMode) updateRadarChart(city);
    animatePanelTitles();
    resizeAllCharts();
    cp.classList.remove('updating');
  }, 40);
}

function updateListHighlight(cityId) {
  var items = document.querySelectorAll('.city-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', items[i].getAttribute('data-city-id') === cityId);
  }
}

function scrollToListCity(cityId) {
  var tgt = document.querySelector('.city-item[data-city-id="' + cityId + '"]');
  if (tgt) tgt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  updateListHighlight(cityId);
}

function initSearch() {
  document.getElementById('citySearch').addEventListener('input', renderCityList);
}

// ---- 面板标题 clip-path 展开 ----
function animatePanelTitles() {
  var titles = document.querySelectorAll('.center-panel .panel-title, .chart-card .panel-title');
  titles.forEach(function (t, i) {
    t.classList.remove('animate-in');
    void t.offsetWidth;
    t.style.animationDelay = (i * 0.05) + 's';
    t.classList.add('animate-in');
  });
}

function updateCityIntro(city) {
  var descEl = document.getElementById('cityDesc');
  var cultureEl = document.getElementById('cityCulture');
  if (!city) {
    if (descEl) descEl.textContent = '暂无数据';
    if (cultureEl) cultureEl.textContent = '';
    return;
  }
  var desc = city.cityDescription || city.culturalHumanity || '';
  var culture = city.culturalHumanity || '';
  // If cityDescription and culturalHumanity are the same or one is missing, just show one
  if (desc === culture || !culture) {
    if (descEl) descEl.textContent = desc;
    if (cultureEl) cultureEl.textContent = '';
  } else {
    if (descEl) descEl.textContent = desc;
    if (cultureEl) cultureEl.textContent = culture;
  }
}

function updateLivability(city) {
  var el = document.getElementById('detailLivability');
  el.innerHTML = '<div class="liv-item"><span class="liv-label">宜居评级</span><span class="liv-value">' + (city.livability || '--') + '</span></div>'
    + '<div class="liv-item"><span class="liv-label">薪资水平</span><span class="liv-value">' + (city.salary || '--') + '</span></div>'
    + '<div class="liv-item"><span class="liv-label">生活成本</span><span class="liv-value">' + (city.livingCost || '--') + '</span></div>'
    + '<div class="liv-item"><span class="liv-label">人口趋势</span><span class="liv-value">' + (city.populationTrend || '--') + '</span></div>'
    + '<div class="liv-item"><span class="liv-label">金融评级</span><span class="liv-value">' + (city.financeRating || '--') + '</span></div>'
    + '<div class="liv-item"><span class="liv-label">航运指数</span><span class="liv-value">' + (city.shippingIndex || '--') + '</span></div>';
}

function updateOppRisk(city) {
  var oppEl = document.getElementById('oppSection');
  var riskEl = document.getElementById('riskSection');
  var oppHtml = '<h4 class="opp-title">▲ 利好信号</h4>';
  var opps = city.opportunities || [];
  for (var i = 0; i < opps.length; i++) { oppHtml += '<div class="opp-item">' + opps[i] + '</div>'; }
  oppEl.innerHTML = oppHtml;

  var riskHtml = '<h4 class="risk-title">▼ 风险提示</h4>';
  var risks = city.risks || [];
  for (var j = 0; j < risks.length; j++) { riskHtml += '<div class="risk-item">' + risks[j] + '</div>'; }
  riskEl.innerHTML = riskHtml;
}

// ---- 翻牌数字动画 (slot machine) ----
function flipMetricValue(el, newText, sym) {
  // Build flip spans
  var digits = String(newText).split('');
  var html = '';
  digits.forEach(function (ch, i) {
    if (ch === '.' || ch === ',') { html += '<span class="flip-digit"><span class="flip-digit-inner">' + ch + '</span></span>'; return; }
    html += '<span class="flip-digit" style="animation-delay:' + (i * 0.03) + 's"><span class="flip-digit-inner">' + ch + '</span></span>';
  });
  el.innerHTML = html;
  // Anime.js v4 stagger
  var spans = el.querySelectorAll('.flip-digit-inner');
  animate(spans, {
    translateY: [12, 0],
    opacity: [0, 1],
    ease: 'outExpo',
    duration: 300,
    delay: stagger(30),
  });
  // Re-set final clean value after animation
  setTimeout(function () { el.innerHTML = newText; }, 350);
}

function updateMetricGrid(city) {
  if (!city) return;
  var grid = document.getElementById('metricGrid');
  var existing = grid.querySelectorAll('.metric-item');
  var sym = city.currency === 'USD' ? '$' : '¥';
  if (existing.length === 3) {
    var gdpEl = existing[0].querySelector('.metric-value');
    var popEl = existing[1].querySelector('.metric-value');
    var pcEl = existing[2].querySelector('.metric-value');
    var newGdp = formatGDP(city.gdp, city.currency);
    var newPop = city.population + '<small> 万</small>';
    var newPc = sym + (city.gdpPerCapita || '--') + '<small> 万</small>';
    gdpEl.setAttribute('data-raw', city.gdp);
    popEl.setAttribute('data-raw', city.population);
    pcEl.setAttribute('data-raw', city.gdpPerCapita || 0);
    flipMetricValue(gdpEl, newGdp.replace(/<[^>]*>/g,''), sym);
    flipMetricValue(popEl, String(city.population), '');
    flipMetricValue(pcEl, sym + (city.gdpPerCapita || '--'), sym);
    // Restore HTML after flip
    setTimeout(function () {
      gdpEl.innerHTML = newGdp;
      popEl.innerHTML = newPop;
      pcEl.innerHTML = newPc;
    }, 400);
  } else {
    var gdpV = formatGDP(city.gdp, city.currency);
    var pcS = city.currency === 'USD' ? '$' : '¥';
    grid.innerHTML = '<div class="metric-item"><div class="metric-label">GDP</div><div class="metric-value" data-raw="' + city.gdp + '">' + gdpV + '</div></div>'
      + '<div class="metric-item"><div class="metric-label">人口</div><div class="metric-value" data-raw="' + city.population + '">' + city.population + '<small> 万</small></div></div>'
      + '<div class="metric-item"><div class="metric-label">人均 GDP</div><div class="metric-value" data-raw="' + (city.gdpPerCapita || '0') + '">' + pcS + (city.gdpPerCapita || '--') + '<small> 万</small></div></div>';
  }
}

function updateTagCloud(city) {
  var c = document.getElementById('tagCloud');
  if (!c || !city) return;
  var tags = city.tags || [];
  if (!tags.length) { c.innerHTML = '<span style="color:var(--text-muted);font-size:10px">暂无标签</span>'; return; }
  var colors = ['tag-blue', 'tag-orange'];
  var h = '';
  for (var i = 0; i < tags.length; i++) { h += '<span class="tag-capsule ' + (i < 3 ? 'lg' : 'sm') + ' ' + colors[i % 2] + '">' + tags[i] + '</span>'; }
  c.innerHTML = h;
}

// ---- 排行榜（滑动入场） ----
function renderRanking() {
  var ranked = computeRankings();
  var tb = document.getElementById('rankingBody'), h = '';
  for (var i = 0; i < ranked.length; i++) {
    var c = ranked[i], rk = i + 1, rc = '';
    if (rk === 1) rc = ' rank-1'; else if (rk === 2) rc = ' rank-2'; else if (rk === 3) rc = ' rank-3';
    h += '<tr data-city-id="' + c.id + '"><td class="rank-col' + rc + '">' + rk + '</td><td>' + c.name + '</td><td>' + (c.country || '--') + '</td><td>¥' + formatGDP(c._gdpRMB, 'CNY').replace('¥', '') + '</td><td>' + c.population + '</td><td>¥' + (c.gdpPerCapitaRMB || '--') + '万</td></tr>';
  }
  tb.innerHTML = h;
  var rows = tb.querySelectorAll('tr');
  rows.forEach(function (row, idx) {
    row.style.animationDelay = (idx * 0.02) + 's';
    row.classList.add('slide-in');
    row.addEventListener('click', function () { onCitySelect(this.getAttribute('data-city-id'), 'ranking'); });
  });
}

function initRankingDrawer() {
  document.getElementById('rankingToggle').addEventListener('click', function () {
    document.getElementById('rankingDrawer').classList.toggle('collapsed');
  });
}

// ---- 跑马灯 ----
function initMarketStrip() {
  var el = document.getElementById('marketStrip');
  var indices = [
    { label: 'SSE', val: 3350 + Math.random() * 50 },
    { label: 'HSI', val: 19800 + Math.random() * 400 },
    { label: 'SPX', val: 5900 + Math.random() * 100 },
    { label: 'N225', val: 38500 + Math.random() * 500 },
    { label: 'UKX', val: 8200 + Math.random() * 100 },
    { label: 'DAX', val: 18800 + Math.random() * 200 },
  ];
  function render() {
    var h = '';
    for (var i = 0; i < indices.length; i++) {
      var idx = indices[i];
      var change = (Math.random() - 0.5) * idx.val * 0.001;
      idx.val += change;
      var cls = change >= 0 ? 'up' : 'down';
      var arrow = change >= 0 ? '▲' : '▼';
      h += '<span class="market-item"><b>' + idx.label + '</b> ' + idx.val.toFixed(0) + ' <span class="' + cls + '">' + arrow + Math.abs(change).toFixed(1) + '</span></span>';
    }
    // Duplicate for seamless marquee
    el.innerHTML = '<span class="market-strip-inner">' + h + h + '</span>';
  }
  render();
  // Check if marquee needed
  setTimeout(function () {
    if (el.scrollWidth > el.clientWidth) el.classList.add('marquee-active');
  }, 500);
  addInterval(setInterval(render, 3000));
}

function initGdpPulse() {
  addInterval(setInterval(function () {
    var city = getCityById(STATE.activeCityId);
    if (!city) return;
    var el = document.getElementById('gdp-' + city.id);
    if (el) { el.style.animation = 'none'; el.offsetHeight; el.style.animation = 'gdpPulse 0.4s ease'; }
  }, 4500 + Math.random() * 3000));
}

function updateClock() {
  document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8);
}

// ============================================================
// === 键盘导航 ===
// ============================================================

function initKeyboardNav() {
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    var items = document.querySelectorAll('.city-item');
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        STATE.highlightedIndex = Math.min(STATE.highlightedIndex + 1, items.length - 1);
        updateKbHighlight(items);
        break;
      case 'ArrowUp':
        e.preventDefault();
        STATE.highlightedIndex = Math.max(STATE.highlightedIndex - 1, 0);
        updateKbHighlight(items);
        break;
      case 'Enter':
        e.preventDefault();
        if (STATE.highlightedIndex >= 0 && items[STATE.highlightedIndex]) {
          var cid = items[STATE.highlightedIndex].getAttribute('data-city-id');
          if (cid) onCitySelect(cid, 'list');
        }
        break;
      case 'Escape':
        if (STATE.compareMode) { toggleCompareMode(); }
        // Close any open drawer
        document.querySelectorAll('.city-card-drawer.open').forEach(function (d) { d.classList.remove('open'); });
        break;
      case '/':
        e.preventDefault();
        var s = document.getElementById('citySearch');
        if (s) s.focus();
        break;
    }
  });
}

function updateKbHighlight(items) {
  items.forEach(function (item, i) {
    item.classList.toggle('kb-highlight', i === STATE.highlightedIndex);
    if (i === STATE.highlightedIndex) item.scrollIntoView({ block: 'nearest' });
  });
}

// ============================================================
// === Scroll parallax (IntersectionObserver) ===
// ============================================================

function initScrollParallax() {
  var listEl = document.getElementById('cityList');
  if (!listEl || !window.IntersectionObserver) return;
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var ratio = entry.intersectionRatio;
      var item = entry.target;
      if (item.classList.contains('city-item')) {
        var op = 0.6 + ratio * 0.4;
        if (ratio >= 1) op = 1;
        if (ratio <= 0) op = 0.6;
        item.style.opacity = op;
      }
    });
  }, { root: listEl, threshold: [0, 0.5, 1.0] });
  // Observe after render
  setTimeout(function () {
    var items = listEl.querySelectorAll('.city-item');
    items.forEach(function (item) { observer.observe(item); });
  }, 500);
}

// ============================================================
// === 主题切换 ===
// ============================================================

function getThemeChartColors() {
  var isDark = STATE.theme === 'dark';
  return {
    textColor: cssVar('--text-secondary'),
    textPrimary: cssVar('--text-primary'),
    bgColor: isDark ? 'rgba(44,44,46,0.96)' : 'rgba(255,255,255,0.96)',
    borderColor: cssVar('--border'),
    splitArea: isDark ? [['#2C2C2E', '#222224']] : [['#FAFAFA', '#F5F5FA']],
    axisLineColor: cssVar('--border-light'),
    splitLineColor: cssVar('--border'),
  };
}

function updateMapTile() {
  if (!STATE.mapTileLayer) return;
  var url = STATE.theme === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  STATE.mapTileLayer.setUrl(url);
  STATE._tileFallbackTriggered = false;
}

function updateAllChartTheme() {
  var tc = getThemeChartColors();
  var charts = ['chartTreemap','chartSunburst','chartRadar','chartGdpTrend'];
  var city = getCityById(STATE.activeCityId);
  charts.forEach(function (key) {
    var inst = STATE[key];
    if (!inst) return;
    var commonOpt = {
      tooltip: { backgroundColor: tc.bgColor, borderColor: tc.borderColor, textStyle: { color: tc.textPrimary, fontSize: 12, fontFamily: 'PingFang SC,sans-serif' } },
      legend: { textStyle: { color: tc.textColor, fontSize: 10, fontFamily: 'PingFang SC,sans-serif' } },
    };
    if (key === 'chartGdpTrend') {
      commonOpt.xAxis = { axisLine: { lineStyle: { color: tc.axisLineColor } }, axisLabel: { color: tc.textColor } };
      commonOpt.yAxis = { splitLine: { lineStyle: { color: tc.splitLineColor } }, axisLabel: { color: cssVar('--text-muted') } };
    }
    if (key === 'chartRadar') {
      commonOpt.radar = { splitArea: { areaStyle: { color: tc.splitArea[0] } }, axisName: { color: tc.textColor } };
    }
    inst.setOption(commonOpt, false);
  });
  if (STATE.chartBar) {
    STATE.chartBar.setOption({
      tooltip: { backgroundColor: tc.bgColor, borderColor: tc.borderColor, textStyle: { color: tc.textPrimary } },
      xAxis: { axisLine: { lineStyle: { color: tc.axisLineColor } }, axisLabel: { color: tc.textColor } },
      yAxis: { splitLine: { lineStyle: { color: tc.splitLineColor } } },
    }, false);
  }
  // Refresh data on theme-aware charts
  if (city) {
    if (STATE.chartTreemap) updateTreemapChart(city);
    if (STATE.chartSunburst) updateSunburstChart(city);
    if (STATE.chartRadar && !STATE.compareMode) updateRadarChart(city);
    if (STATE.chartGdpTrend) updateGdpTrendChart(city);
  }
  debouncedResize();
}

function doThemeSwitch() {
  STATE.theme = STATE.theme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', STATE.theme);
  try { localStorage.setItem('theme', STATE.theme); } catch (e) {}
  updateMapTile();
  updateAllChartTheme();
  updateParticleColor();
  var btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = STATE.theme === 'dark' ? '☀️' : '🌙';
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 600);
  }
}

function toggleTheme() {
  // Capture button position for circle-reveal origin
  var btn = document.getElementById('themeToggle');
  if (btn) {
    var rect = btn.getBoundingClientRect();
    var x = ((rect.left + rect.width / 2) / window.innerWidth * 100).toFixed(1);
    var y = ((rect.top + rect.height / 2) / window.innerHeight * 100).toFixed(1);
    document.documentElement.style.setProperty('--tx', x + '%');
    document.documentElement.style.setProperty('--ty', y + '%');
    // Set flash overlay color based on target theme
    var isDark = STATE.theme === 'dark'; // current theme before switch
    document.documentElement.style.setProperty('--flash-color',
      isDark ? 'rgba(26,108,245,0.15)' : 'rgba(64,156,255,0.15)');
  }

  // Show flash overlay briefly
  var flash = document.getElementById('themeFlashOverlay');
  if (!flash) {
    flash = document.createElement('div');
    flash.className = 'theme-flash-overlay';
    flash.id = 'themeFlashOverlay';
    document.body.appendChild(flash);
  }
  flash.classList.add('active');
  setTimeout(function () { flash.classList.remove('active'); }, 200);

  if (document.startViewTransition) {
    document.startViewTransition(function () { doThemeSwitch(); });
  } else {
    doThemeSwitch();
  }
}

function initTheme() {
  var saved;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  if (saved === 'dark' || saved === 'light') {
    STATE.theme = saved;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    STATE.theme = 'dark';
  }
  document.documentElement.setAttribute('data-theme', STATE.theme);
  var btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = STATE.theme === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', toggleTheme);
  }
  updateParticleColor();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!localStorage.getItem('theme')) {
        STATE.theme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', STATE.theme);
        updateMapTile();
        updateAllChartTheme();
        updateParticleColor();
        var b = document.getElementById('themeToggle');
        if (b) b.textContent = STATE.theme === 'dark' ? '☀️' : '🌙';
      }
    });
  }
}

// ============================================================
// === 对比模式 ===
// ============================================================

function toggleCompareMode() {
  STATE.compareMode = !STATE.compareMode;
  STATE.compareIds = [];
  var btn = document.getElementById('compareToggle');
  if (btn) btn.classList.toggle('active', STATE.compareMode);
  renderCityList();
  if (!STATE.compareMode) {
    var ac = getCityById(STATE.activeCityId);
    if (ac) updateRadarChart(ac);
  }
}

function initCompareMode() {
  var btn = document.getElementById('compareToggle');
  if (btn) btn.addEventListener('click', toggleCompareMode);
}

// ============================================================
// === 粒子背景 ===
// ============================================================

function updateParticleColor() {
  STATE.particleColor = STATE.theme === 'dark'
    ? 'rgba(64,156,255,0.18)' : 'rgba(26,108,245,0.10)';
}

function initParticles() {
  updateParticleColor();
  var canvas = document.getElementById('particleCanvas');
  var ctx = canvas.getContext('2d');
  var particles = [], COUNT = 35, CONNECT = 90;
  var mouse = { x: -1000, y: -1000 };
  function rs() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  rs(); window.addEventListener('resize', rs);
  canvas.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mouseleave', function () { mouse.x = -1000; mouse.y = -1000; });
  for (var i = 0; i < COUNT; i++) { particles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: Math.random() * 1.5 + 0.5 }); }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var particleFill = STATE.particleColor;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var mdx = p.x - mouse.x, mdy = p.y - mouse.y;
      var md = Math.sqrt(mdx * mdx + mdy * mdy);
      if (md < 100 && md > 0) { var f = (100 - md) / 100 * 1.3; p.vx += (mdx / md) * f * 0.02; p.vy += (mdy / md) * f * 0.02; }
      p.vx *= 0.998; p.vy *= 0.998;
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy); if (sp > 0.7) { p.vx = p.vx / sp * 0.7; p.vy = p.vy / sp * 0.7; }
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = particleFill; ctx.fill();
      for (var j = i + 1; j < particles.length; j++) {
        var q = particles[j], dx = p.x - q.x, dy = p.y - q.y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.strokeStyle = 'rgba(26,108,245,' + (0.05 * (1 - dist / CONNECT)).toFixed(3) + ')'; ctx.lineWidth = 0.4; ctx.stroke(); }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

// ============================================================
// === 地图层 ===
// ============================================================

function getMapTileUrl() {
  var isDark = STATE.theme === 'dark';
  var emptyTile = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  var primary = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  return { primary: primary, subdomains: isDark ? 'abcd' : 'abc', fallback: isDark ? primary : 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', errorTileUrl: emptyTile, maxZoom: 19, attribution: false, crossOrigin: true };
}

function initMap() {
  var root = document.getElementById('mapRoot');
  if (!window.L) { root.innerHTML = '<div style="padding:16px;color:#FF3B30">Leaflet 加载失败</div>'; return null; }
  var map = L.map(root, { center: [28, 20], zoom: 2, zoomControl: true, attributionControl: false });
  STATE.mapInstance = map;

  var tileOpts = getMapTileUrl();
  STATE.mapTileLayer = L.tileLayer(tileOpts.primary, {
    subdomains: tileOpts.subdomains, maxZoom: tileOpts.maxZoom,
    attribution: tileOpts.attribution, crossOrigin: tileOpts.crossOrigin,
    errorTileUrl: tileOpts.errorTileUrl,
  }).addTo(map);

  STATE.mapTileLayer.on('tileerror', function () {
    if (!STATE._tileFallbackTriggered) {
      STATE._tileFallbackTriggered = true;
      console.warn('[地图] 主 tile 源加载失败，切换备选源');
      STATE.mapTileLayer.setUrl(tileOpts.fallback);
    }
  });

  for (var i = 0; i < STATE.cities.length; i++) { addCityMarker(STATE.cities[i]); }
  window.addEventListener('resize', function () { setTimeout(function () { map.invalidateSize(); }, 150); });
  setTimeout(function () {
    if (STATE.cities.length > 0) {
      var bounds = [];
      for (var k = 0; k < STATE.cities.length; k++) { var c = STATE.cities[k]; if (c.lat && c.lng) bounds.push([c.lat, c.lng]); }
      if (bounds.length > 0) map.fitBounds(bounds, { padding: [15, 15] });
    }
  }, 500);

  // Start breathing animation for active marker
  initMarkerBreath();
  return map;
}

function addCityMarker(city) {
  var map = STATE.mapInstance; if (!map || !city.lat || !city.lng) return;
  var gRMB = city._gdpRMB || city.gdp, r = 5;
  if (gRMB > 50000) r = 8; else if (gRMB > 20000) r = 7; else if (gRMB > 8000) r = 6;
  var isA = city.id === STATE.activeCityId;
  var m = L.circleMarker([city.lat, city.lng], { radius: r, fillColor: isA ? '#FF6B35' : '#1A6CF5', color: '#fff', weight: 2, opacity: 0.9, fillOpacity: isA ? 0.95 : 0.7 });
  m.bindPopup('<div style="font-family:\'PingFang SC\',sans-serif;font-size:12px"><strong style="color:#FF6B35;font-size:14px">' + city.name + '</strong><br>' + (city.country || '') + ' / ' + (city.region || '') + '<br>GDP: <span style="color:#1A6CF5;font-weight:600">' + formatGDP(city.gdp, city.currency) + '</span><br>人口: ' + city.population + ' 万</div>');
  m.on('click', function () { onCitySelect(city.id, 'map'); });

  // Hover card
  var hcEl = document.getElementById('mapHoverCard');
  if (hcEl) {
    m.on('mouseover', function (ev) {
      hcEl.innerHTML = '<div class="hc-name">' + city.name + '</div><div class="hc-row"><span>GDP</span><span>' + formatGDP(city.gdp, city.currency) + '</span></div><div class="hc-row"><span>人口</span><span>' + city.population + ' 万</span></div>';
      hcEl.style.left = (ev.originalEvent.offsetX + 20) + 'px';
      hcEl.style.top = (ev.originalEvent.offsetY - 50) + 'px';
      hcEl.classList.add('visible');
    });
    m.on('mouseout', function () { hcEl.classList.remove('visible'); });
  }

  m.addTo(map);
  STATE.markers[city.id] = m;
}

function highlightMapMarker(cityId) {
  var map = STATE.mapInstance; if (!map) return;
  var ids = Object.keys(STATE.markers);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], m = STATE.markers[id], isT = id === cityId;
    var city = getCityById(id), gRMB = city ? (city._gdpRMB || city.gdp) : 0, r = 5;
    if (gRMB > 50000) r = 8; else if (gRMB > 20000) r = 7; else if (gRMB > 8000) r = 6;
    m.setStyle({ fillColor: isT ? '#FF6B35' : '#1A6CF5', fillOpacity: isT ? 0.95 : 0.7, radius: r });
    if (isT) { m.openPopup(); STATE._breathTarget = m; }
    else { if (STATE._breathTarget === m) STATE._breathTarget = null; }
  }
  var tgt = getCityById(cityId);
  if (tgt && tgt.lat && tgt.lng) map.setView([tgt.lat, tgt.lng], map.getZoom(), { animate: true });
}

// ---- 呼吸动画 ----
function initMarkerBreath() {
  if (STATE._breathId) clearInterval(STATE._breathId);
  var phase = 0;
  STATE._breathId = addInterval(setInterval(function () {
    var m = STATE._breathTarget;
    if (!m) return;
    phase += 0.12;
    var r = 7 + Math.sin(phase) * 1.5;
    var o = 0.7 + Math.sin(phase) * 0.3;
    try { m.setStyle({ radius: r, fillOpacity: o }); } catch (e) {}
  }, 50));
}

// ============================================================
// === 图表层 ===
// ============================================================

var COLORS = ['#1A6CF5','#FF6B35','#34C759','#FF3B30','#FFD60A','#AF52DE','#5AC8FA','#FF9F0A','#30D158','#8E8E93'];

// ---- Treemap ----
function initTreemapChart() {
  var d = document.getElementById('chartTreemap');
  if (d) { STATE.chartTreemap = echarts.init(d, null, { renderer: 'canvas' }); setTimeout(function () { if (STATE.chartTreemap) STATE.chartTreemap.resize(); }, 100); }
}

function updateTreemapChart(city) {
  if (!STATE.chartTreemap || !city || !city.industries) return;
  var data = [];
  for (var i = 0; i < city.industries.length; i++) {
    var ind = city.industries[i];
    var children = [];
    if (ind.sub) for (var j = 0; j < ind.sub.length; j++) {
      children.push({ name: ind.sub[j].name, value: ind.sub[j].value });
    }
    data.push({ name: ind.name, value: ind.value, children: children.length > 0 ? children : undefined });
  }
  var textColor = cssVar('--text-primary');
  STATE.chartTreemap.setOption({
    animationDuration: 600, animationEasing: 'cubicOut',
    tooltip: { backgroundColor: cssVar('--bg-card'), borderColor: cssVar('--border'), textStyle: { color: textColor, fontSize: 12, fontFamily: 'PingFang SC,sans-serif' }, formatter: function (p) { return '<b>' + p.name + '</b><br/>权重: ' + (p.value || 0); } },
    series: [{
      type: 'treemap', width: '100%', height: '100%', roam: false,
      leafDepth: 1,
      breadcrumb: { show: true, height: 22, bottom: 0, itemStyle: { color: cssVar('--bg-sunken'), borderColor: cssVar('--border'), textStyle: { color: textColor, fontSize: 9 } } },
      label: { show: true, fontSize: 10, fontFamily: 'PingFang SC,sans-serif', color: '#fff', formatter: function (p) { var v = p.value || ''; return p.name + String.fromCharCode(10) + v; } },
      itemStyle: { borderColor: cssVar('--bg-card'), borderWidth: 2, gapWidth: 1 },
      levels: [
        { colorMappingBy: 'index', color: COLORS.slice(0, 8), itemStyle: { borderWidth: 3, gapWidth: 3 }, label: { fontSize: 12, fontWeight: 'bold' } },
        { colorMappingBy: 'id', colorSaturation: [0.35, 0.6], itemStyle: { borderWidth: 2, gapWidth: 2 }, label: { fontSize: 9 } }
      ],
      data: data
    }]
  }, true);
}

// ---- Sunburst ----
function initSunburstChart() {
  var d = document.getElementById('chartSunburst');
  if (d) { STATE.chartSunburst = echarts.init(d, null, { renderer: 'canvas' }); setTimeout(function () { if (STATE.chartSunburst) STATE.chartSunburst.resize(); }, 100); }
}

function updateSunburstChart(city) {
  if (!STATE.chartSunburst || !city) return;
  var data = [];
  for (var i = 0; i < (city.industries || []).length; i++) {
    var ind = city.industries[i], color = COLORS[i % COLORS.length];
    var children = [];
    if (ind.sub) for (var j = 0; j < ind.sub.length; j++) children.push({ name: ind.sub[j].name, value: ind.sub[j].value, itemStyle: { color: color, opacity: 0.75 } });
    data.push({ name: ind.name, itemStyle: { color: color }, children: children });
  }
  var bgColor = cssVar('--bg-card');
  var borderColor = cssVar('--border');
  var textPrimary = cssVar('--text-primary');
  STATE.chartSunburst.setOption({
    animationDuration: 600, animationEasing: 'cubicOut',
    tooltip: { trigger: 'item', backgroundColor: bgColor, borderColor: borderColor, textStyle: { color: textPrimary, fontSize: 12, fontFamily: 'PingFang SC,sans-serif' }, formatter: function (p) { var path = []; if (p.treePathInfo) for (var i = 0; i < p.treePathInfo.length; i++) path.push(p.treePathInfo[i].name); return '<b>' + path.join(' > ') + '</b><br/>权重: ' + (p.value || '—'); } },
    series: [{ type: 'sunburst', data: data, radius: ['0%', '90%'], center: ['50%', '52%'], sort: 'desc', emphasis: { focus: 'ancestor' }, label: { show: true, rotate: 'radial', color: textPrimary, fontSize: 9, fontFamily: 'PingFang SC,sans-serif' }, itemStyle: { borderColor: '#fff', borderWidth: 1.5 }, levels: [{}, { r0: '15%', r: '52%', label: { fontSize: 10, fontWeight: 'bold' }, itemStyle: { borderWidth: 2 } }, { r0: '52%', r: '90%', label: { fontSize: 8 } }] }],
  }, true);
}

// ---- Chart linking: Treemap ↔ Sunburst ----
function initChartLinking() {
  if (!STATE.chartTreemap || !STATE.chartSunburst) return;
  STATE.chartTreemap.on('mouseover', function (params) {
    if (params.name && STATE.chartSunburst) {
      STATE.chartSunburst.dispatchAction({ type: 'highlight', name: params.name });
    }
  });
  STATE.chartTreemap.on('mouseout', function () {
    if (STATE.chartSunburst) {
      STATE.chartSunburst.dispatchAction({ type: 'downplay' });
    }
  });
}

// ---- Radar ----
function initRadarChart() { var d = document.getElementById('chartRadar'); if (d) STATE.chartRadar = echarts.init(d); }

function updateRadarChart(city) {
  if (!STATE.chartRadar || !city) return;
  if (STATE.compareMode && STATE.compareIds.length > 0) { updateCompareRadar(); return; }
  var REF_IDS = ['shanghai', 'beijing', 'new-york', 'london', 'tokyo'];
  var refCities = [];
  for (var i = 0; i < REF_IDS.length; i++) {
    var rc = getCityById(REF_IDS[i]);
    if (rc && rc.id !== city.id) refCities.push(rc);
  }
  if (refCities.length < REF_IDS.length) {
    var sorted = STATE.cities.slice().sort(function (a, b) { return b._gdpRMB - a._gdpRMB; });
    for (var j = 0; j < sorted.length && refCities.length < REF_IDS.length; j++) {
      if (sorted[j].id !== city.id && REF_IDS.indexOf(sorted[j].id) === -1) refCities.push(sorted[j]);
    }
  }
  var allPeers = [city].concat(refCities.slice(0, 4));
  var maxVals = { gdp: 0, pop: 0, fin: 0, log: 0, live: 0 };
  allPeers.forEach(function (c) {
    if (c._gdpRMB > maxVals.gdp) maxVals.gdp = c._gdpRMB;
    if (c.population > maxVals.pop) maxVals.pop = c.population;
    if ((c.financeIndex || 0) > maxVals.fin) maxVals.fin = c.financeIndex || 0;
    maxVals.log = Math.max(maxVals.log, 100);
    maxVals.live = Math.max(maxVals.live, 100);
  });
  var radarData = [];
  var legendData = [];
  allPeers.forEach(function (c) {
    legendData.push(c.name);
    var sc = Math.min(c._gdpRMB / Math.max(maxVals.gdp, 1) * 100, 100);
    var sp = Math.min(c.population / Math.max(maxVals.pop, 1) * 100, 100);
    var sf = Math.min((c.financeIndex || 0) / Math.max(maxVals.fin, 1) * 100, 100);
    var sl = Math.min(((c.shippingIndex && c.shippingIndex !== '内陆城市' && c.shippingIndex !== '内陆高原城市') ? 80 : 40), 100);
    var sv = c.livability && c.livability.indexOf('高') !== -1 ? 80 : (c.livability && c.livability.indexOf('极') !== -1 ? 95 : 55);
    var isActive = c.id === city.id;
    radarData.push({
      value: [sc, sp, sf, sl, sv], name: c.name,
      lineStyle: { color: isActive ? '#FF6B35' : '#AEAEB2', width: isActive ? 3 : 1.5, opacity: isActive ? 1 : 0.4 },
      areaStyle: isActive ? { color: '#FF6B35', opacity: 0.15 } : undefined,
      itemStyle: { color: isActive ? '#FF6B35' : '#AEAEB2', opacity: isActive ? 1 : 0.4 },
      symbol: 'circle', symbolSize: isActive ? 7 : 4,
    });
  });
  STATE.chartRadar.setOption({
    animationDuration: 600, animationEasing: 'cubicOut',
    tooltip: { backgroundColor: cssVar('--bg-card'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text-primary'), fontFamily: 'PingFang SC,sans-serif' } },
    legend: { data: legendData, bottom: 0, textStyle: { color: cssVar('--text-secondary'), fontSize: 10, fontFamily: 'PingFang SC,sans-serif' } },
    radar: { center: ['50%', '42%'], radius: '58%', indicator: [{ name: 'GDP', max: 100 }, { name: '人口', max: 100 }, { name: '金融', max: 100 }, { name: '物流', max: 100 }, { name: '宜居', max: 100 }], axisName: { color: cssVar('--text-secondary'), fontSize: 9, fontFamily: 'PingFang SC,sans-serif' }, splitArea: { areaStyle: { color: ['#FAFAFA', '#F5F5FA'] } } },
    series: [{ type: 'radar', data: radarData }],
  }, true);
}

// ---- GDP Trend (interactive tooltips) ----
function initGdpTrendChart() { var d = document.getElementById('chartGdpTrend'); if (d) STATE.chartGdpTrend = echarts.init(d); }

function updateGdpTrendChart(city) {
  if (!STATE.chartGdpTrend || !city) return;
  var trend = city.gdpTrend;
  if (!trend || trend.length < 5) { var r2 = (city.growthRate || 3) / 100; trend = []; for (var y = 4; y >= 1; y--) trend.push(Math.round(city.gdp / Math.pow(1 + r2, y))); trend.push(city.gdp); }
  var years = ['2021', '2022', '2023', '2024', '2025'];
  var sym = (city.currency === 'USD') ? '$' : '¥';
  var trendCopy = trend.slice();
  STATE.chartGdpTrend.setOption({
    animationDuration: 700, animationEasing: 'cubicOut',
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--bg-card'),
      borderColor: cssVar('--border'),
      textStyle: { color: cssVar('--text-primary'), fontSize: 11, fontFamily: 'PingFang SC,sans-serif' },
      formatter: function (params) {
        var idx = params[0].dataIndex;
        var val = params[0].value;
        var s = '<b>' + params[0].name + '</b><br/>GDP: ' + sym + val.toLocaleString() + '亿';
        if (idx > 0) {
          var prev = trendCopy[idx - 1];
          var diff = val - prev;
          var pct = prev > 0 ? ((diff / prev) * 100).toFixed(2) : 0;
          var color = diff >= 0 ? cssVar('--accent-green') || '#34C759' : cssVar('--accent-red') || '#FF3B30';
          var sign = diff >= 0 ? '+' : '';
          s += '<br/>环比: <span style="color:' + color + ';font-weight:700">' + sign + diff.toLocaleString() + '亿 (' + sign + pct + '%)</span>';
        }
        return s;
      },
    },
    grid: { left: '12%', right: '6%', top: '8%', bottom: '10%' },
    xAxis: { type: 'category', data: years, axisLine: { lineStyle: { color: cssVar('--border-light') } }, axisLabel: { color: cssVar('--text-secondary'), fontSize: 10, fontFamily: 'PingFang SC,sans-serif' }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: cssVar('--border'), type: 'dashed' } }, axisLabel: { color: cssVar('--text-muted'), fontSize: 9, fontFamily: 'SF Mono,Consolas,monospace', formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(1) + '万亿' : sym + v + '亿'; } } },
    series: [{ type: 'line', data: trend, smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: cssVar('--accent'), width: 2.5 }, itemStyle: { color: cssVar('--accent'), borderColor: '#fff', borderWidth: 2 }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(26,108,245,0.14)' }, { offset: 1, color: 'rgba(26,108,245,0.01)' }]) }, emphasis: { scale: 2 } }],
  }, true);
}

// ---- Bar Chart ----
function initBarChart() {
  var d = document.getElementById('chartBar'); if (!d) return;
  STATE.chartBar = echarts.init(d);
  var sorted = STATE.cities.slice().sort(function (a, b) { return b._gdpRMB - a._gdpRMB; });
  var names = [], gdps = [];
  for (var i = 0; i < sorted.length; i++) { names.push(sorted[i].name); gdps.push(sorted[i]._gdpRMB); }
  STATE.chartBar.setOption({
    animationDuration: 800, animationEasing: 'cubicOut',
    tooltip: { trigger: 'axis', backgroundColor: cssVar('--bg-card'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text-primary'), fontSize: 12, fontFamily: 'PingFang SC,sans-serif' }, formatter: function (p) { return '<b>' + p[0].name + '</b><br/>GDP: ¥' + formatGDP(p[0].value, 'CNY').replace('¥', ''); } },
    grid: { left: '3%', right: '4%', top: '8%', bottom: '8%', containLabel: true },
    xAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: cssVar('--border-light') } }, axisLabel: { color: cssVar('--text-secondary'), fontSize: 9, fontFamily: 'PingFang SC,sans-serif', rotate: 45 }, axisTick: { show: false } },
    yAxis: { type: 'value', name: 'GDP (万亿元 RMB)', nameTextStyle: { color: cssVar('--text-muted'), fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: cssVar('--border'), type: 'dashed' } }, axisLabel: { color: cssVar('--text-muted'), fontSize: 10, fontFamily: 'SF Mono,Consolas,monospace', formatter: function (v) { return (v / 10000).toFixed(0) + '万亿'; } } },
    series: [{ type: 'bar', barWidth: '60%', data: gdps.map(function (v, idx) { return { value: v, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: COLORS[idx % COLORS.length] }, { offset: 1, color: 'rgba(26,108,245,0.10)' }]), borderRadius: [6, 6, 0, 0] } }; }), emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(26,108,245,0.18)' } } }],
  });
}

function resizeAllCharts() {
  if (STATE.chartTreemap) STATE.chartTreemap.resize();
  if (STATE.chartSunburst) STATE.chartSunburst.resize();
  if (STATE.chartBar) STATE.chartBar.resize();
  if (STATE.chartGdpTrend) STATE.chartGdpTrend.resize();
  if (STATE.chartRadar) STATE.chartRadar.resize();
}

var debouncedResize = debounce(resizeAllCharts, 100);

// ============================================================
// === 初始化 ===
// ============================================================

function waitForLibs() {
  return new Promise(function (resolve) {
    function check() { if (typeof echarts !== 'undefined' && typeof L !== 'undefined') resolve(); else setTimeout(check, 40); }
    check();
  });
}

function bootstrap() {
  initTheme();
  waitForLibs().then(function () {
    STATE.libsReady = true;
    return fetchCityData();
  }).then(function () {
    initParticles();
    initMap();
    initTreemapChart();
    initSunburstChart();
    initRadarChart();
    initGdpTrendChart();
    initBarChart();
    renderCityList();
    renderRanking();
    initSearch();
    initRankingDrawer();
    initMarketStrip();
    initGdpPulse();
    initKeyboardNav();
    initCompareMode();
    initScrollParallax();

    // Wait for charts to be ready before linking
    setTimeout(initChartLinking, 800);

    var def = getCityById(STATE.activeCityId);
    if (def) {
      updateCityIntro(def); updateLivability(def); updateOppRisk(def);
      updateMetricGrid(def); updateGdpTrendChart(def); updateTagCloud(def);
      updateTreemapChart(def); updateSunburstChart(def); updateRadarChart(def);
    }

    window.addEventListener('resize', function () {
      debouncedResize();
      if (STATE.mapInstance) STATE.mapInstance.invalidateSize();
    });

    // Page unload cleanup
    window.addEventListener('beforeunload', clearAllIntervals);

    updateClock();
    addInterval(setInterval(updateClock, 1000));
    console.log('[Bootstrap] 就绪 — ' + STATE.cities.length + ' 城市 (Anime.js v4)');
  }).catch(function (err) { console.error('[Bootstrap] 失败:', err); });
}

bootstrap();
