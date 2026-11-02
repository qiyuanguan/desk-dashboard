import { CONFIG, STAGES, STAGES_EXTRA, TOKEN_STATUS, SUMMARY_FIELDS } from './config.js';
import { loadData, loadCandles, klineCached, intervalAvailable, hasKline, PATHS } from './data.js';
import { esc, usd, sUsd, pct, plain, cls, reason, short, price, dt, compact, tz, num, shortId } from './fmt.js';
import { createEquityChart, createKline } from './charts.js';

const $ = id => document.getElementById(id);
const S = {                       // 界面状态（刷新数据时保留）
  data: null, bars: [], klineReq: 0, hidden: new Set(), curveDays: 7, sortKey: 'pnl_pct', sortDir: -1,
  token: null, interval: CONFIG.DEFAULT_INTERVAL, markerStrategy: '',
  recTab: 'trades', page: 0, focusTrade: null, fetchedAt: 0, loadError: null, renderErrors: [],
  colorMode: localStorage.getItem('desk.colorMode') || 'greenUp',
};
const strat = id => S.data.strategies.find(s => s.id === id) || { id, name: id, color: '#94a3b8' };
const colors = () => CONFIG.COLOR_MODES[S.colorMode];

// ---------- 策略对比 ----------
function sparkline(curve, color) {
  const v = curve.map(p => p.value).filter(Number.isFinite);
  if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), w = 100, h = 26;
  const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y - mn) / (mx - mn || 1) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
// 正式策略和对照组（S0）分开：排名、合计、起始基准线只算正式策略；对照组识别见 js/data.js 的 CONTROL
const formal = () => S.data.strategies.filter(s => s.role !== 'control');
const controls = () => S.data.strategies.filter(s => s.role === 'control');
const byPnl = (a, b) => ((b.pnl_pct ?? -1e9) - (a.pnl_pct ?? -1e9));
function ranked() { return [...formal()].sort(byPnl); }
const CTRL_TIP = '对照组：单独记账（自己的虚拟资金），不参与排名，不计入正式策略合计';
const ctrlTag = (cls = 'tag ctrl') => `<span class="${cls}" title="${CTRL_TIP}">对照组</span>`;
const rankLabel = (s, rank) => s.role === 'control' ? '对照' : '#' + rank.get(s.id);
// v0.4：现金和持仓不在 state.json 里的策略，导出只按成交算统计
const LEDGER_TIP = '这个策略只有成交记录（ledger=trades_only）：胜率、笔数按成交算；起始资金、现金、权益、收益率、回撤暂缺，等它有自己的状态文件后补上';
const costNote = c => c == null ? '' : c > 0 ? ` · <span title="记账时每边按 ${c}% 模拟滑点+手续费，盈亏已扣除">成本每边 ${+c.toFixed(2)}%</span>` : ' · <span title="记账价就是报价，没有模拟成本">无模拟成本</span>';
function renderStrategies() {
  const list = ranked(), ctl = [...controls()].sort(byPnl);
  const rank = new Map(list.map((s, i) => [s.id, i + 1]));
  const tot = list.reduce((a, s) => a + (s.equity || 0), 0), start = list.reduce((a, s) => a + (s.start || 0), 0);
  const totPct = start > 0 ? (tot / start - 1) * 100 : null;   // 起始资金 0/缺失时不算收益率（BUG-010）
  $('strat-summary').innerHTML = `${list.length} 个正式策略 · 合计权益 ${usd(tot)} <span class="${cls(totPct)}" ${start > 0 ? '' : 'title="起始资金为 0 或缺失，无法计算合计收益率"'}>${pct(totPct, 2)}</span>` +
    (ctl.length ? ` <span class="ctrl-note" title="${CTRL_TIP}">· 另有对照组 ${ctl.length} 个（不计入）</span>` : '');
  const card = s => `
    <div class="scard ${s.role === 'control' ? 'ctrl' : ''} ${S.hidden.has(s.id) ? 'off' : ''}" style="--c:${s.color}" data-id="${esc(s.id)}" title="点击在权益曲线中显示/隐藏">
      <div class="nm"><span class="rk">${rankLabel(s, rank)}</span>${esc(s.name)}${s.role === 'control' ? ctrlTag() : ''}</div>
      ${s.ledger === 'trades_only' ? `<div class="tg"><span class="tag warn" title="${esc(LEDGER_TIP)}">仅成交记录</span></div>` : ''}
      ${s.tag ? `<div class="tg" title="${esc(s.desc)}">${esc(s.tag)}</div>` : ''}
      <div class="big ${cls(s.pnl_pct)}">${pct(s.pnl_pct, 2)}</div>
      <div class="kv"><span>权益 <b>${usd(s.equity)}</b></span><span>胜率 <b>${plain(s.win_rate)}</b></span>
        <span title="一买一卖算一笔">成交 <b>${s.closed_count ?? 0}</b> 笔</span><span>持仓 <b>${s.positions.length}</b></span></div>
      <div class="sub2">买 ${s.buy_count ?? 0} / 卖 ${s.sell_count ?? 0} 次 · ${s.wins ?? 0} 胜 ${s.losses ?? 0} 负${costNote(s.cost_pct_per_side)}</div>
      ${sparkline(s.equity_curve, s.color)}
    </div>`;
  $('strat-cards').innerHTML = list.map(card).join('') +
    (ctl.length ? `<div class="grp-head" title="${CTRL_TIP}"><b>对照组</b> · 单独记账、单独资金，不参与排名，不计入上面的合计</div>` + ctl.map(card).join('') : '');
  const anyBf = [...list, ...ctl].some(s => s.equity_curve.some(p => p.backfilled));
  const leg = s => `<span style="${S.hidden.has(s.id) ? 'opacity:.4' : ''}"><i style="${s.dashed ? `background:none;border-top:2px dashed ${s.color};height:0` : `background:${s.color}`}"></i>${esc(s.name)}</span>`;
  $('curve-legend').innerHTML = list.map(leg).join('') + (ctl.length ? `<span class="leg-sep">｜</span>${ctrlTag('tag ctrl sm')}` + ctl.map(leg).join('') : '') +
    (anyBf ? '<span class="bf-note" title="v0.4：这段没有逐时权益记录，是按 trades.csv 的已实现盈亏回补出来的（不含当时未平仓的浮动盈亏）"><i class="bf"></i>淡色点线 = 由成交回补的已实现权益</span>' : '');
  equity.setData(S.data.strategies, S.hidden);
  renderRank(rank);
  $('strat-desc-body').innerHTML = '<dl>' + [...list, ...ctl].map(s => `<div><dt><span class="dot" style="background:${s.color}"></span>${esc(s.name)}${s.role === 'control' ? ' ' + ctrlTag() : ''}${s.tag ? ` <span class="small muted">${esc(s.tag)}</span>` : ''}</dt><dd>${esc(s.desc || '（暂无说明）')}</dd></div>`).join('') + '</dl>';
}
function renderRank(rank) {
  const k = S.sortKey, d = S.sortDir;
  const srt = arr => [...arr].sort((a, b) => d * (((a[k] ?? -1e9)) - ((b[k] ?? -1e9))));
  const rows = srt(formal()), ctl = srt(controls());
  document.querySelectorAll('#rank-table th.sortable').forEach(th => {
    th.classList.toggle('sort-desc', th.dataset.k === k && d < 0); th.classList.toggle('sort-asc', th.dataset.k === k && d > 0);
  });
  const row = s => `<tr class="${s.role === 'control' ? 'ctrl' : ''}">
    <td class="muted">${s.role === 'control' ? '对照' : rank.get(s.id)}</td>
    <td><span class="dot" style="background:${s.color}"></span>${esc(s.name)}${s.role === 'control' ? ctrlTag('rank-tag ctrl') : ''}${s.tag ? `<span class="rank-tag">${esc(s.tag)}</span>` : ''}${s.ledger === 'trades_only' ? `<span class="rank-tag" title="${esc(LEDGER_TIP)}">仅成交记录</span>` : ''}</td>
    <td class="num ${cls(s.pnl_pct)}">${pct(s.pnl_pct, 2)}<div class="small ${cls(s.pnl)}">${sUsd(s.pnl)}</div></td>
    <td class="num">${plain(s.win_rate)}<div class="small muted">${s.wins ?? 0} 胜 / ${s.losses ?? 0} 负</div></td>
    <td class="num">${s.closed_count ?? 0}<div class="small muted">买 ${s.buy_count ?? 0} / 卖 ${s.sell_count ?? 0}</div></td>
    <td class="num ${s.max_drawdown_pct ? 'dn' : 'muted'}">${s.max_drawdown_pct == null ? '–' : s.max_drawdown_pct ? '-' + Math.abs(s.max_drawdown_pct).toFixed(1) + '%' : '0.0%'}</td>
    <td class="num">${usd(s.equity)}<div class="small muted">现金 ${usd(s.cash)}</div></td>
    <td class="num">${s.positions.length}</td></tr>`;
  $('rank-table').querySelector('tbody').innerHTML = rows.map(row).join('') +
    (ctl.length ? `<tr class="grp"><td colspan="8">对照组 · 单独记账，不参与排名、不计入合计</td></tr>` + ctl.map(row).join('') : '');
}

// ---------- 持仓 ----------
function allPositions() { return S.data.strategies.flatMap(s => s.positions); }
function renderPositions() {
  const P = allPositions().sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));
  $('pos-count').textContent = `${P.length} 个 · 市值 ${usd(P.reduce((a, p) => a + (p.value_usd || 0), 0))}`;
  $('positions').innerHTML = P.length ? P.map(p => {
    const s = strat(p.strategy);
    return `<div class="pos" data-mint="${esc(p.mint)}">
      <div><b>${esc(p.symbol)}</b> <span class="tag st" style="color:${s.color}">${esc(s.name)}</span>
        ${p.pool_missing ? '<span class="tag warn" title="pool_missing：价格源找不到池子，撤池观察中；市值按 0 计、盈亏按 -100% 计，权益里也按 0 算">撤池观察中 · 按 0 估值</span>' : ''}
        <div class="small muted">入场 ${priceCell(p.entry_price)} · 现价 ${p.pool_missing ? '<span title="撤池观察中，按 0 估值">0（撤池）</span>' : priceCell(p.last_price)} · ${dt(p.opened_at)}</div></div>
      <div class="r"><div>${usd(p.value_usd)}</div><div class="${cls(p.pnl_pct)}">${pct(p.pnl_pct)}</div></div></div>`;
  }).join('') : '<div class="empty">暂无持仓</div>';
}

// ---------- K 线 ----------
function tokenList() {
  const order = { position: 0, candidate: 1, closed: 2 };
  return [...S.data.tokens].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
}
// v0.4：pool_missing 的持仓 last_price=0，是约定值不是数据错误，不标 ⚠
const poolGone = t => !(t.last_price > 0) && allPositions().some(p => p.mint === t.mint && p.pool_missing);
function renderTokenBar() {
  const T = tokenList();
  if (!S.token || !T.find(t => t.mint === S.token)) S.token = (T.find(hasKline) || T[0])?.mint || null;   // 默认选第一个有 K 线的币
  $('token-bar').innerHTML = T.map(t => {
    // 价格/涨跌来自 data.json 的币列表（不用为了显示这一行去加载 K 线）；v0.4 可能为 null → 显示 –
    const ch = t.change_24h;
    return `<button class="tok ${t.mint === S.token ? 'on' : ''}" data-mint="${esc(t.mint)}" title="${esc(t.symbol)} ${esc(t.mint)}">
      <div class="s">${esc(symLabel(t.mint, t.symbol))}<span class="st">${esc(TOKEN_STATUS[t.status] || t.status || '')}</span></div>
      <div class="p">${hasKline(t) ? `${poolGone(t) ? '<span class="muted" title="持仓撤池观察中（pool_missing），现价按 0 计">撤池观察</span>' : priceCell(t.last_price)} <span class="${cls(ch)}" title="24 小时涨跌">${pct(ch)}</span>` : '<span class="muted">暂无 K 线</span>'}</div></button>`;
  }).join('') || '<div class="empty">data.json 里还没有币列表</div>';
}
function klineState(kind, msg = '', sub = '') {
  const el = $('kline-state');
  if (!kind) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false; el.className = 'kstate ' + kind;
  el.innerHTML = kind === 'loading'
    ? `<div class="spin"></div><div>${esc(msg || '正在加载 K 线…')}</div>`
    : `<div class="ic">${kind === 'error' ? '⚠️' : '📭'}</div><div>${esc(msg)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}` +
      (kind === 'error' ? '<button class="btn" id="kline-retry">重试</button>' : '');
}
// 切币/切周期时按需加载 K 线；silent=后台刷新，不闪“加载中”，保留当前视野
async function renderKline({ keepRange = false, silent = false } = {}) {
  const tok = S.data.tokens.find(t => t.mint === S.token);
  document.querySelectorAll('#intervals button').forEach(b => {
    b.classList.toggle('on', b.dataset.i === S.interval);
    b.disabled = !tok || !intervalAvailable(tok, b.dataset.i, S.data);
  });
  // 当前周期这个币没有（例如 v0.3 候选币没有 1m）：自动换到它有的最小周期，而不是显示空图
  if (tok && hasKline(tok) && !intervalAvailable(tok, S.interval, S.data)) {
    const alt = Object.keys(CONFIG.INTERVALS).find(iv => intervalAvailable(tok, iv, S.data));
    if (alt) { S.autoInterval = `${tok.symbol} 没有 ${S.interval} K 线，已切到 ${alt}`; S.interval = alt; return renderKline({ keepRange, silent }); }
  }
  const req = ++S.klineReq;
  if (!tok) { S.bars = []; kline.setData([]); kline.setMarkers([]); kline.setEntryLines([]); $('kline-foot').textContent = ''; klineState('empty', '还没有可看的币'); return; }
  if (!hasKline(tok)) {
    S.bars = []; kline.setData([]); kline.setMarkers([]); kline.setEntryLines([]); renderOhlc(null);
    klineState('empty', `${tok.symbol} 暂时没有 K 线数据`, '后端还没导出这个币的 K 线文件，等下一次数据更新后再看。');
    $('kline-foot').innerHTML = footHead(tok);
    return;
  }
  const slow = !silent && !klineCached(tok, S.interval, S.data);
  let timer = slow ? setTimeout(() => req === S.klineReq && klineState('loading', `正在加载 ${tok.symbol} ${S.interval} K 线…`), 120) : null;
  let res;
  try { res = await loadCandles(tok, S.interval, S.data); }
  catch (e) {
    clearTimeout(timer); if (req !== S.klineReq) return;
    if (silent && S.bars.length) return;   // 后台刷新失败：保留旧图
    S.bars = []; kline.setData([]); kline.setMarkers([]); kline.setEntryLines([]);
    klineState('error', `${tok.symbol} 的 K 线加载失败`, esc(e.message) + ' · 可能是网络问题');
    return;
  }
  clearTimeout(timer);
  if (req !== S.klineReq) return;          // 用户已经切到别的币/周期，丢弃旧结果
  if (res.missing) {
    S.bars = []; kline.setData([]); kline.setMarkers([]); kline.setEntryLines([]); renderOhlc(null);
    klineState('empty', `${tok.symbol} 的 ${S.interval} K 线文件还没有`,
      `找过：${res.tried.map(u => `<span class="mono">${esc(relPath(u))}</span>`).join('、') || '（无可用文件）'}<br>可以换个周期看看，或等后端导出。`);
    $('kline-foot').innerHTML = footHead(tok);
    return;
  }
  klineState(null);
  const derived = res.derived;
  const bars = S.bars = kline.setData(res.data, { keepRange });   // setData 内部会去重/去掉坏点，返回实际画出的 K 线
  const sec = CONFIG.INTERVALS[S.interval], c = colors();
  // 买卖点：成交时间落在哪根 K 线就标在哪根（bar.time <= t < bar.time + sec）
  const times = bars.map(b => b.time);
  const barOf = t => { let lo = 0, hi = times.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r >= 0 && t < times[r] + sec ? times[r] : null; };
  const tr = S.data.trades.filter(x => x.mint === tok.mint && (!S.markerStrategy || x.strategy === S.markerStrategy));
  const markers = [];
  for (const x of tr) {
    const bt = barOf(x.time); if (bt == null) continue;
    const s = strat(x.strategy), buy = x.action === 'buy', hl = S.focusTrade === x.id;
    markers.push({ time: bt, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
      color: hl ? '#ffffff' : (buy ? c.up : c.dn), size: hl ? 2 : 1,
      text: `${buy ? '买' : '卖'}·${s.short || s.name}${!buy && x.pnl_pct != null ? ' ' + pct(x.pnl_pct, 0) : ''}` });
  }
  markers.sort((a, b) => a.time - b.time);
  kline.setMarkers(markers);
  kline.setEntryLines(allPositions().filter(p => p.mint === tok.mint && (!S.markerStrategy || p.strategy === S.markerStrategy))
    .map(p => ({ price: p.entry_price, color: strat(p.strategy).color, title: '持仓成本·' + (strat(p.strategy).short || '') })));
  const outside = tr.length - markers.length, m = res.meta || {};
  const auto = S.autoInterval; S.autoInterval = null;
  const ft = S.focusTrade && tr.find(x => x.id === S.focusTrade);
  const ftNote = ft ? `<div class="note-inline">📍 ${esc(ft.id)} ${ft.action === 'buy' ? '买入' : '卖出'} · ${dt(ft.time)} ${tz(ft.time)} · 市价 ${priceCell(ft.market_price)}` +
    (ft.fill_price != null && ft.fill_price !== ft.market_price ? ` · 成交价 ${priceCell(ft.fill_price)}（含模拟成本）` : '') + '</div>' : '';
  $('kline-foot').innerHTML = (auto ? `<div class="note-inline">ℹ️ ${esc(auto)}</div>` : '') + ftNote + footHead(tok, m) +
    ` · ${markers.length} 个买卖点${outside ? `（另有 ${outside} 笔不在当前 K 线时间范围内）` : ''}` +
    (derived ? ` · ${S.interval} 由 ${derived} 聚合` : '') + ` · ▲ 买入 ▼ 卖出，虚线为持仓成本` +
    `<div class="kmeta">${klineMeta(m, bars, derived)}</div>`;
}
const SOURCES = { geckoterminal: 'GeckoTerminal', sample: '示例数据' };
const relPath = u => { try { const b = new URL('.', S.data.base).href; return u.startsWith(b) ? u.slice(b.length) : u; } catch { return u; } };
// 币名 + mint + 池子（v0.3 tokens[].pool，可点到 GeckoTerminal 看原始 K 线）
function footHead(tok, m = {}) {
  const pool = m.pool || tok.pool;
  const poolLink = pool && !/^SAMPLE/.test(pool)
    ? ` · 池子 <a href="https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pool)}" target="_blank" rel="noopener" class="mono">${esc(short(pool))}</a>`
    : pool ? ` · 池子 <span class="mono">${esc(short(pool))}</span>` : '';
  return `${esc(tok.symbol)} · ${esc(tok.name || '')} <span class="mono">${esc(short(tok.mint))}</span>${poolLink}`;
}
// K 线文件信息（v0.3：source / generated_at / filled + index.json 的 bars / bytes）
function klineMeta(m, bars, derived) {
  const parts = [];
  if (m.source) parts.push(`来源 ${esc(SOURCES[m.source] || m.source)}`);
  if (bars.length) parts.push(`${bars.length} 根 · ${dt(bars[0].time)} ~ ${dt(bars[bars.length - 1].time)} ${tz(bars[bars.length - 1].time)}`);
  if (m.generatedAt) { const t = Date.parse(m.generatedAt); if (!isNaN(t)) parts.push(`K 线更新于 ${dt(t / 1000)}`); }
  if (m.filled > 0) parts.push(`<span title="这段时间没有成交，导出时用前一根收盘价补成一字线、量记 0">补齐空 K 线 ${m.filled} 根${derived ? `（${derived}）` : ''}</span>`);
  if (m.bytes > 0) parts.push(`文件 ${(m.bytes / 1024).toFixed(1)} KB`);
  return parts.join(' · ');
}
function renderOhlc(b) {
  if (!b) { $('ohlc').innerHTML = ''; return; }
  const ch = b.open ? (b.close / b.open - 1) * 100 : null, k = cls(b.close - b.open);
  $('ohlc').innerHTML = `<span>${dt(b.time)}</span><span>开 <b class="${k}">${price(b.open)}</b></span><span>高 <b class="${k}">${price(b.high)}</b></span>` +
    `<span>低 <b class="${k}">${price(b.low)}</b></span><span>收 <b class="${k}">${price(b.close)}</b></span><span class="${k}">${pct(ch, 2)}</span>` +
    (b.volume != null ? `<span>量 <b>$${compact(b.volume)}</b></span>` : '');
}
function selectToken(mint, { scroll = false, time = null } = {}) {
  const tok = S.data.tokens.find(t => t.mint === mint);
  if (!tok) return false;
  S.token = mint; renderTokenBar();
  if (scroll) $('sec-kline').scrollIntoView({ behavior: 'smooth' });
  const req = S.klineReq + 1;
  renderKline().then(() => { if (time != null && req === S.klineReq && S.bars.length) kline.focusTime(time, CONFIG.INTERVALS[S.interval]); });
  return true;
}

// ---------- 成交与跳过 ----------
function fillSelect(el, opts, keep) {
  const v = el.value;
  el.innerHTML = opts.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join('');
  if (keep && opts.some(o => o[0] === v)) el.value = v;
}
function renderFilters() {
  const st = [['', '全部策略'], ...formal().map(s => [s.id, s.name]), ...controls().map(s => [s.id, s.name + '（对照组）'])];
  fillSelect($('f-strategy'), st, true); fillSelect($('marker-strategy'), st, true);
  const rows = recRows();
  // 按 mint 筛（BUG-015）：同名不同币分开列，标签带 mint 缩写
  const mints = [...new Map(rows.filter(r => r.mint).map(r => [r.mint, r.symbol])).entries()]
    .map(([m, sym]) => [m, symLabel(m, sym)]).sort((a, b) => a[1].localeCompare(b[1]));
  fillSelect($('f-token'), [['', '全部币'], ...mints], true);
  fillSelect($('f-action'), S.recTab === 'trades'
    ? [['', '买入和卖出'], ['buy', '只看买入'], ['sell', '只看卖出'], ['win', '盈利的卖出'], ['loss', '亏损的卖出']]
    : S.recTab === 'events' ? [['', '全部'], ['summary', '只看扫描汇总'], ['global', '只看全局记录']]
    : [['', '全部阶段'], ...Object.entries(STAGES)], true);
}
function filtered() {
  const fs = $('f-strategy').value, ft = $('f-token').value, fa = $('f-action').value, q = $('f-q').value.trim().toLowerCase();
  const rows = recRows();
  // 盈利/亏损只看有数值盈亏的卖出；pnl 为空的卖出两边都不算（BUG-014）
  return rows.filter(r => (!fs || r.strategy === fs) && (!ft || r.mint === ft) &&
    (!fa || (S.recTab === 'trades'
      ? (fa === 'win' ? r.action === 'sell' && Number.isFinite(r.pnl) && r.pnl > 0 : fa === 'loss' ? r.action === 'sell' && Number.isFinite(r.pnl) && r.pnl <= 0 : r.action === fa)
      : S.recTab === 'events' ? r.kind === fa : r.stage === fa)) &&
    (!q || [r.symbol, r.mint, r.reason, reason(r.reason)].some(v => String(v || '').toLowerCase().includes(q))));
}
function renderRecords() {
  const rows = filtered(), n = rows.length, pages = Math.max(1, Math.ceil(n / CONFIG.PAGE_SIZE));
  S.page = Math.min(S.page, pages - 1);
  const pg = rows.slice(S.page * CONFIG.PAGE_SIZE, (S.page + 1) * CONFIG.PAGE_SIZE);
  const total = recRows().length;
  $('rec-count').textContent = n === total ? `共 ${n} 条` : `筛选出 ${n} / ${total} 条`;
  const head = $('rec-table').querySelector('thead'), body = $('rec-table').querySelector('tbody');
  const hasK = new Set(S.data.tokens.filter(hasKline).map(t => t.mint));
  const sname = id => { const s = strat(id); return `<span class="dot" style="background:${s.color}"></span>${esc(s.name)}`; };
  if (S.recTab === 'trades') {
    $('rec-table').className = 'tbl tbl-records is-trades';
    head.innerHTML = '<tr><th>时间</th><th>方向</th><th>币</th><th>策略</th><th class="num" title="成交价（含模拟成本）；和市价不同时下面小字是市价">成交价</th><th class="num">金额</th><th class="num">盈亏</th><th>原因</th></tr>';
    body.innerHTML = pg.map(x => `<tr data-id="${esc(x.id)}" data-mint="${esc(x.mint)}" data-time="${+x.time}" class="${S.focusTrade === x.id ? 'hl' : ''}">
      <td class="c-time mono small" title="${esc(x.id)}">${dt(x.time)}</td>
      <td class="c-act"><span class="tag ${x.action === 'buy' ? 'buy' : 'sell'}">${x.action === 'buy' ? '买入' : '卖出'}</span></td>
      <td class="c-sym"><b>${esc(x.symbol || short(x.mint))}</b>${hasK.has(x.mint) ? ' <span class="small muted" title="有 K 线，点击定位">📈</span>' : ''}</td>
      <td class="c-st">${sname(x.strategy)}</td>
      <td class="c-price num mono">${priceCell(x.fill_price ?? x.market_price)}${x.fill_price != null && x.market_price != null && x.fill_price !== x.market_price ? `<div class="small muted" title="市价（不含模拟成本），K 线买卖点按它对照">市价 ${priceCell(x.market_price)}</div>` : ''}</td><td class="c-usd num">${usd(x.usd)}</td>
      <td class="c-pnl num ${cls(x.pnl)}">${x.action === 'sell' ? `${sUsd(x.pnl)} <span class="small">${pct(x.pnl_pct)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="c-reason muted" title="${esc(x.reason)}">${esc(reason(x.reason))}</td></tr>`).join('') || (S.data.trades.length ? '<tr><td colspan="8" class="empty">没有符合条件的成交</td></tr>' : '<tr><td colspan="8" class="empty"><b>还没有成交</b><br>策略还没有买过币。有成交后，这里会列出每一笔买入和卖出；K 线上也会标出买卖点。</td></tr>');
  } else if (S.recTab === 'events') {
    $('rec-table').className = 'tbl tbl-records is-events';
    head.innerHTML = '<tr><th>时间</th><th>类型</th><th>策略</th><th>内容</th></tr>';
    body.innerHTML = pg.map(x => `<tr>
      <td class="c-time mono small">${dt(x.time)}</td><td class="c-act"><span class="tag skip">${esc(stageName(x.stage) || (x.kind === 'summary' ? '扫描汇总' : '全局'))}</span></td>
      <td class="c-st">${x.strategy ? sname(x.strategy) : '<span class="muted">全局</span>'}</td>
      <td class="c-reason" title="${esc(x.reason)}">${eventText(x)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">没有扫描汇总或全局记录</td></tr>';
  } else {
    $('rec-table').className = 'tbl tbl-records is-skips';
    head.innerHTML = '<tr><th>时间</th><th>阶段</th><th>币</th><th>策略</th><th>跳过原因</th></tr>';
    body.innerHTML = pg.map(x => `<tr data-mint="${esc(x.mint)}">
      <td class="c-time mono small">${dt(x.time)}</td><td class="c-act"><span class="tag skip">${esc(stageName(x.stage))}</span></td>
      <td class="c-sym"><b>${esc(x.symbol || '')}</b> <span class="small muted mono">${esc(short(x.mint))}</span></td>
      <td class="c-st">${sname(x.strategy)}</td><td class="c-reason" title="${esc(x.reason)}">${esc(reason(x.reason))}</td></tr>`).join('') || (S.data.skips.length ? '<tr><td colspan="5" class="empty">没有符合条件的跳过记录</td></tr>' : '<tr><td colspan="5" class="empty"><b>还没有跳过记录</b></td></tr>');
  }
  $('pager').innerHTML = pages > 1 ? `<button id="pg-prev" ${S.page ? '' : 'disabled'}>上一页</button><span>${S.page + 1} / ${pages}</span><button id="pg-next" ${S.page < pages - 1 ? '' : 'disabled'}>下一页</button>` : '';
}

// 汇总行 / 全局行（热修 02a）：单独一个标签页，不计入成交和跳过的笔数
const recRows = () => S.recTab === 'trades' ? S.data.trades : S.recTab === 'events' ? S.data.events : S.data.skips;
const stageName = k => STAGES[k] || STAGES_EXTRA[k] || k || '';
function summaryText(sm) {
  if (!sm) return '';
  const d = sm.data, parts = SUMMARY_FIELDS.filter(([k]) => d[k] != null && typeof d[k] !== 'object').map(([k, cn]) => `${cn} ${esc(String(d[k]))}`);
  if (d.stop) parts.push(`提前结束：${esc(reason(d.stop))}`);
  if (d.grok_cap_hit === true && d.stop !== 'grok_cap_hit') parts.push(esc(reason('grok_cap_hit')));
  return parts.join(' · ') + (sm.truncated ? ' <span class="muted small" title="后端导出时把这行截到 140 字，后面的字段看不到">（原文被截断）</span>' : '');
}
const eventText = x => x.kind === 'summary'
  ? (summaryText(x.summary) || '<span class="muted">扫描汇总（内容无法解析）</span>')
  : esc(reason(x.reason) || reason(x.result));
function renderScanLine() {   // 成交区上方一行：最近一轮扫描汇总
  const e = S.data.events.find(x => x.kind === 'summary' && x.summary);
  $('scan-line').hidden = !e;
  if (e) $('scan-line').innerHTML = `<b>最近一轮扫描</b>（${dt(e.time)}）：${summaryText(e.summary)}`;
}

// ---------- 顶部 ----------
// 纸面标志由数据驱动（BUG-007）：paper=true 正常；false 红色警示 + 标题前缀；没标注时黄色提醒
function renderHeader() {
  // 上线横幅：常驻、不能关；示例数据时加“示例数据”
  $('preview-banner').textContent = '预览版 · 纸上模拟，不是真实收益' + (S.data.sample ? ' · 示例数据' : '');
  $('sample-banner').hidden = !S.data.sample;
  if (S.data.sample && S.data.sampleNote) $('sample-banner').textContent = '⚠ ' + S.data.sampleNote;
  const pb = $('paper-banner'), paper = S.data.paper;
  pb.className = 'paper-banner' + (paper === false ? ' danger' : paper == null ? ' warn' : '');
  pb.setAttribute('role', paper === true ? 'note' : 'alert');
  pb.textContent = paper === true ? '纸上交易 · 不涉及真实资金'
    : paper === false ? '⚠ 非纸面数据：data.json 标注 paper=false，可能涉及真实资金，请立即核实后端配置'
    : '⚠ data.json 没有标注 paper 字段，无法确认是纸上交易，请核实';
  document.title = (paper === false ? '⚠ 非纸面 · ' : '') + '纸上交易台 · 策略看板';
  stamp();
}
// 顶部时间：数据新鲜度按 data.json 的 generated_at 判断（BUG-001），检查时间只是附加信息
function stamp() {
  const el = $('updated'), d = S.data;
  const age = S.fetchedAt ? Math.round((Date.now() - S.fetchedAt) / 1000) : null;
  const checked = age == null ? '' : age < 60 ? '刚刚检查' : Math.floor(age / 60) + ' 分钟前检查';
  if (d) el.title = `数据文件 ${PATHS.DATA} · 格式 ${d.schemaVersion || '未标注'}` + (d.generatedAt ? ` · generated_at=${d.generatedAt}` : '');
  let line1, cls1 = '';
  if (!d) line1 = S.loadError ? '数据加载失败' : '加载中…', cls1 = S.loadError ? 'stale' : '';
  else if (d.generatedTs == null) { line1 = d.generatedAt ? '数据生成时间无法识别' : '数据没有标注生成时间'; cls1 = 'stale'; }
  else {
    const mins = Math.floor((Date.now() / 1000 - d.generatedTs) / 60);
    line1 = `数据生成于 ${dt(d.generatedTs)} ${tz(d.generatedTs)}`;
    if (mins >= CONFIG.STALE_MIN) {
      const h = mins >= 120 ? `${Math.floor(mins / 60)} 小时` : `${mins} 分钟`;
      line1 += `<br><span class="stale">⚠ 数据已过期 ${h} · 后端可能停了</span>`;
    }
  }
  const line2 = S.loadError && d ? `<span class="stale">⚠ 最近一次刷新失败，显示的是上次的数据</span>` : `<span class="muted">${checked}</span>`;
  el.innerHTML = (cls1 ? `<span class="${cls1}">${esc(line1)}</span>` : line1) + (d || S.loadError ? '<br>' + line2 : '');
  el.classList.toggle('is-stale', !!el.querySelector('.stale'));
}
// 页面顶部的错误条：加载失败 / 某区块显示出错 分开说（BUG-002 / BUG-003）
function showErrors() {
  const msgs = [];
  if (S.loadError) msgs.push(`数据加载失败（${PATHS.DATA}）：${S.loadError}` + (S.data ? '。页面保留上次成功加载的数据，' : '。') + '稍后自动重试');
  if (S.renderErrors.length) msgs.push('部分区块显示出错（数据可能有异常字段）：' + S.renderErrors.join('；'));
  const el = $('err'); el.hidden = !msgs.length; el.textContent = msgs.join('\n');
}
function applyColors() {
  const c = colors();
  document.documentElement.style.setProperty('--up', c.up); document.documentElement.style.setProperty('--dn', c.dn);
  $('color-mode').textContent = c.label;
  kline.setColors(c);
}
// 每个区块单独兜底：一个区块因为脏数据出错，不影响其它区块，也不会被说成“数据加载失败”
function safe(name, fn) {
  try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(e => { S.renderErrors.push(`${name}：${e.message}`); showErrors(); console.error(e); }); }
  catch (e) { S.renderErrors.push(`${name}：${e.message}`); console.error(e); }
}
function renderAll(keep = false) {
  S.renderErrors = [];
  safe('顶部', renderHeader); safe('策略对比', renderStrategies); safe('持仓', renderPositions); safe('币列表', renderTokenBar);
  safe('K 线', () => renderKline({ keepRange: keep, silent: keep })); safe('筛选', renderFilters); safe('成交与跳过', renderRecords); safe('扫描汇总', renderScanLine);
  safe('页脚', renderFooter);
}
function renderFooter() { $('footer-tz').textContent = `美西时间（现在是 ${tz()}）`; }
// 小工具
const priceCell = v => v != null && v <= 0 ? `<span class="bad-val" title="价格 ≤ 0，数据异常">⚠ ${esc(price(v))}</span>` : price(v);
function symLabel(mint, sym) {   // 同名不同币时带上 mint 缩写区分（BUG-015）
  if (S._symFor !== S.data) {      // 每份数据算一次：symbol → 出现过的 mint 集合
    S._symFor = S.data; S._sym = new Map();
    for (const r of [...S.data.tokens, ...S.data.trades, ...S.data.skips]) if (r.mint) (S._sym.get(r.symbol) || S._sym.set(r.symbol, new Set()).get(r.symbol)).add(r.mint);
  }
  return (sym || shortId(mint)) + ((S._sym.get(sym)?.size || 0) > 1 ? ' · ' + shortId(mint) : '');
}

// ---------- 启动 ----------
const equity = createEquityChart($('equity-chart'));
const kline = createKline($('kline-chart'), renderOhlc);
applyColors();

async function refresh(first) {
  let data;
  try { data = await loadData(); }
  catch (e) { S.loadError = e.message || String(e); console.error(e); stamp(); showErrors(); return; }
  S.data = data; S.fetchedAt = Date.now(); S.loadError = null;
  renderAll(!first);
  if (first) safe('权益曲线范围', () => equity.setRange(S.curveDays, S.data.strategies));
  stamp(); showErrors();
}
// 自测脚本用（tools/regress.mjs）：只读
window.__deskDebug = {
  baseLineVisible: () => equity.baseLineVisible(),
  v04: () => {
    const tok = S.data.tokens.find(t => t.mint === S.token), sec = CONFIG.INTERVALS[S.interval];
    const tr = S.data.trades.filter(x => x.mint === tok?.mint);
    const inBar = tr.map(x => { const b = S.bars.find(b => b.time <= x.time && x.time < b.time + sec); return b ? (x.market_price >= b.low * 0.999 && x.market_price <= b.high * 1.001) : null; }).filter(v => v != null);
    const bf = equity.backfillInfo();
    return { markers: kline.markers().length, checked: inBar.length, markersOk: inBar.length > 0 && inBar.every(Boolean),
      backfillStyled: bf.some(x => x.bf > 0 && x.style === 1 && /^#[0-9a-f]{6}80$/i.test(x.color)), bf };
  },
};

$('strat-cards').addEventListener('click', e => {
  const c = e.target.closest('.scard'); if (!c) return;
  S.hidden.has(c.dataset.id) ? S.hidden.delete(c.dataset.id) : S.hidden.add(c.dataset.id); renderStrategies();
});
$('curve-range').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.curveDays = +b.dataset.r; document.querySelectorAll('#curve-range button').forEach(x => x.classList.toggle('on', x === b));
  equity.setRange(S.curveDays, S.data.strategies);
});
$('rank-table').querySelector('thead').addEventListener('click', e => {
  const th = e.target.closest('th.sortable'); if (!th) return;
  S.sortDir = S.sortKey === th.dataset.k ? -S.sortDir : (th.dataset.k === 'max_drawdown_pct' ? 1 : -1); S.sortKey = th.dataset.k;
  renderRank(new Map(ranked().map((s, i) => [s.id, i + 1])));
});
$('intervals').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return; S.interval = b.dataset.i; renderKline();
});
$('token-bar').addEventListener('click', e => { const b = e.target.closest('.tok'); if (b) { S.focusTrade = null; selectToken(b.dataset.mint); } });
$('marker-strategy').addEventListener('change', e => { S.markerStrategy = e.target.value; renderKline({ keepRange: true }); });
$('positions').addEventListener('click', e => { const p = e.target.closest('.pos'); if (p) selectToken(p.dataset.mint, { scroll: true }); });
$('rec-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.recTab = b.dataset.t; S.page = 0; document.querySelectorAll('#rec-tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('f-action').value = ''; renderFilters(); renderRecords();
});
['f-strategy', 'f-token', 'f-action'].forEach(id => $(id).addEventListener('change', () => { S.page = 0; renderRecords(); }));
$('f-q').addEventListener('input', () => { S.page = 0; renderRecords(); });
$('pager').addEventListener('click', e => {
  if (e.target.id === 'pg-prev') S.page--; else if (e.target.id === 'pg-next') S.page++; else return; renderRecords();
});
$('rec-table').querySelector('tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-mint]'); if (!tr) return;
  S.focusTrade = tr.dataset.id || null;
  if (selectToken(tr.dataset.mint, { scroll: true, time: tr.dataset.time ? +tr.dataset.time : null })) renderRecords();
});
$('kline-state').addEventListener('click', e => { if (e.target.id === 'kline-retry') renderKline(); });
$('btn-colors').addEventListener('click', () => {
  S.colorMode = S.colorMode === 'greenUp' ? 'redUp' : 'greenUp'; localStorage.setItem('desk.colorMode', S.colorMode);
  applyColors(); if (S.data) { renderKline({ keepRange: true }); renderStrategies(); }
});
// 顶部导航高亮
const navLinks = [...document.querySelectorAll('#nav a')];
new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) navLinks.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id)); }),
  { rootMargin: '-40% 0px -55% 0px' }).observe($('sec-strategies'));
['sec-kline', 'sec-records'].forEach(id => document.querySelector('#nav') && new IntersectionObserver(es => es.forEach(en => {
  if (en.isIntersecting) navLinks.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + id));
}), { rootMargin: '-40% 0px -55% 0px' }).observe($(id)));

refresh(true);
setInterval(refresh, CONFIG.REFRESH_MS); setInterval(stamp, 15_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
