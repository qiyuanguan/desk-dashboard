// 数据加载层 —— 唯一需要跟后端格式对接的地方。格式按 v0.4（软件负责人 11-02 口径；code/数据格式.md 仍写 v0.3），兼容 0.3 / 0.2-draft。
//
// ┌ 目录结构（和后端 export/ 完全一样；示例数据也按这个生成，见 tools/make_sample_data.py）
// │ data.json                       主数据：策略、持仓、成交、跳过、币列表（不含 K 线）
// │ klines/index.json               K 线索引（data.json 的 kline_index 指过来，可选）：每币每周期的 file / bars / from / to / bytes
// │ klines/{mint}_{interval}.json   单币单周期 K 线 { mint, symbol, interval, pool, source, generated_at, filled, candles: [[t,o,h,l,c,v_usd]] }
// │                                 interval ∈ 1m | 5m | 15m | 1h；t 是该周期开盘时间（Unix 秒），升序
// │
// │ 数据从哪读：默认读 index.html 同目录的 data.json（部署时把 export/ 下的文件复制过来）。
// │ 也可以用地址参数指到别处：index.html?data=../export/data.json 。K 线和 index.json 的路径一律【相对 data.json 所在目录】解析，
// │ 所以 export/ 整个目录原样放哪都行，不用改代码。
// │
// │ K 线文件地址优先级：index.json 里的 file > tokens[].kline_files[周期] > tokens[].kline_file > data.json 的 kline_path > PATHS.KLINE
// │ 也支持“一币一个文件”：kline_path 写 'klines/{mint}.json'，文件里 candles 写成 { '1m': [...], '5m': [...] }。
// └ v0.4：已平仓/候选币导 5m/15m/1h，持仓币导 1m/5m/15m/1h；没 K 线的币 intervals: []。
//   某周期没文件时仍会用更小周期的文件在前端聚合——只为兼容旧导出，v0.4 正常不会走到。
//
// 界面内部模型：
// Model = {
//   sample, sampleNote, paper(true|false|null), schemaVersion, generatedAt, generatedTs, base(data.json 的绝对地址), klinePath, klineIndex,
//   strategies: [{ id, name, short, tag, desc, color, dashed, start, cash, equity, pnl, pnl_pct, realized_pnl, unrealized_pnl,
//                  closed_count,            // 成交笔数（主数字）：一买一卖算一笔 = 已完全平仓的仓位数
//                  wins, losses, breakeven (旧名 flats，页面内部仍叫 flats), win_rate,  // 一笔净盈亏 >0 胜、<0 负、=0 持平；v4：win_rate = wins ÷ (wins + losses)，持平不进分母；没有胜负时 null（显示「—」）
//                  buy_count, sell_count,   // 次要信息：买入/卖出次数（分批止盈时一笔会有多次卖出）
//                  max_drawdown_pct, equity_curve: [{time, value, backfilled}],
//                  positions: [{ position_id, mint, symbol, qty, entry_price, last_price, cost_usd, value_usd, pnl_pct, opened_at,
//                                pool_missing /* v0.3：撤池观察中，按 0 估值 */ }] }],
//   tokens: [{ mint, symbol, name, status, last_price|null, change_24h|null, pool, intervals: ['5m',...] | [] | null, inline }],
//   trades: [{ id, time, strategy, position_id, action:'buy'|'sell', mint, symbol, market_price, fill_price, price(=fill), cost_pct_per_side, agent, qty, usd, pnl|null, pnl_pct|null, reason }],
//   skips:  [{ time, strategy, mint, symbol, stage, reason }],              // 只含“某个币被跳过”的行
//   events: [{ time, kind:'summary'|'global', strategy, stage, result, reason, summary:{data,truncated}|null }],  // 汇总行/全局行，不计入统计
//   strategies[].role: 'formal' | 'control' | 'other'（正式 / 对照组 S0 / 未分类，见下面 roleOf）；roleRaw = 数据里的原值
// }
// 所有 time 都是 Unix 秒（UTC），界面显示为美西时间（PST/PDT 自动）。
import { CONFIG, STRATEGY_META } from './config.js?v=20261102-v5';
import { safeColor, num, parseIso } from './fmt.js?v=20261102-v5';

// ┌──────────────────────────────────────────────────────────────────────────────────────────────
// │ 对照组 S0 的识别（2026-11-02 Bill 批准新增；code/数据格式.md 还没写 S0 的正式格式，定稿后只改这一块）
// │ 依据：code/s0/ 里程序员正在写的版本 —— trades.csv/tasks.csv 的行 strategy="S0"、agent="S0"，tasks 的 action 都以 s0_ 开头；
// │       S0 自己的账本 state_s0.json（$50 虚拟资金，结构同 state.json），所以导出后它应该是一个完整的 strategies[] 项（不是 trades_only）。
// │ 判定顺序（任一命中即对照组）：
// │   1. strategies[].role === 'control'（或 group === 'control'、control === true）—— 建议程序员将来直接给这个字段
// │   2. strategies[].id 在 CONTROL.IDS 里，或匹配 CONTROL.ID_RE（S0 / s0 / s0_control / s0-xxx）
// │ 成交/跳过行：strategy 为空但 agent === 'S0' 也归到 S0（和 code/s0/desk/book.py 的 strategy_of 一致）。
// │ 对照组：卡片、排行、权益曲线单独成组并标“对照组”；顶部“合计权益/收益率”和起始基准线只算正式策略（role=formal）。
// └──────────────────────────────────────────────────────────────────────────────────────────────
export const CONTROL = {
  IDS: ['S0', 's0', 's0_control'],
  ID_RE: /^s0(?:[_-].*)?$/i,
  AGENT: 'S0',                 // 行上 strategy 为空时，用 agent 认 S0
  CANON_ID: 'S0',              // 用 agent 认出来的行归到这个 id
  START_USD: 50,               // 只用于说明文字；真实值以 data.json 的 start 为准
};
// v0.5 role 口径（程序员 2026-11-02 01:39 确认）：直接用数据里的 role ——
//   "main"    → 'formal'  正式策略，只有它计入合计、参与排名（以后 S1–S3 也会标 main）
//   "control" → 'control' 对照组（S0），不计入合计
//   "other"   → 'other'   未分类：导出认不出的策略（兜底值），单独列出、标“未分类”，不计入合计
// 只有缺 role 的旧数据（v0.4 及以前）才按旧规则推断（id / group / control → 对照组，其余正式）。
// role 写了但不是这三个值 → 当未分类（不让来路不明的策略混进合计）。
const legacyControl = s => s.group === 'control' || s.control === true || CONTROL.IDS.includes(String(s.id ?? '')) || CONTROL.ID_RE.test(String(s.id ?? ''));
export const roleOf = s => !s ? 'formal' : s.role === 'main' ? 'formal' : s.role === 'control' ? 'control' : s.role === 'other' ? 'other'
  : s.role == null || s.role === '' ? (legacyControl(s) ? 'control' : 'formal') : 'other';
export const isControl = s => !!s && roleOf(s) === 'control';
const rowStrategy = x => str(x.strategy) || (str(x.agent).trim() === CONTROL.AGENT ? CONTROL.CANON_ID : '');

// ┌ 汇总行 / 全局行（热修 02a，BUG-H06 / HF-GEN-08）：tasks.csv 里不属于某个币的行
// │   scan_summary：action=scan_summary、mint="-"、result=summary、reason=JSON（导出可能截到 140 字）
// │   全局限额：action=limits、mint="-"、result=skip（例如 session_loss_halt）；no_leads：action=scan、mint="-"
// │ 这些行不是成交也不是“某个币被跳过”：从 trades/skips 里拿出来放进 events，不计入任何笔数和筛选，单独显示。
// └
const NO_MINT = m => m === '' || m === '-';
export const isSummaryRow = x => /scan_summary$/.test(str(x.stage || x.action)) || str(x.result) === 'summary' || /^\s*[{[]/.test(str(x.reason));
export const isGlobalRow = x => isSummaryRow(x) || NO_MINT(str(x.mint).trim());
// 解析 scan_summary 的 JSON；被截断时尽量按 "key":value 抠出能读的部分
export function parseSummary(text) {
  const t = str(text).trim();
  try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return { data: o, truncated: false }; } catch { /* 截断 */ }
  const o = {};
  for (const m of t.matchAll(/"([a-z_0-9]+)"\s*:\s*("([^"]*)"|-?\d+(?:\.\d+)?|true|false|null)(?=\s*[,}])/gi))
    o[m[1]] = m[3] != null ? m[3] : m[2] === 'true' ? true : m[2] === 'false' ? false : m[2] === 'null' ? null : +m[2];
  return Object.keys(o).length ? { data: o, truncated: true } : null;
}

// ?data=… 只接受同站相对路径（不允许 http:// 或 // 开头，免得被拿去读别的站）
function dataUrlFromQuery() {
  try {
    const q = new URLSearchParams(location.search).get('data');
    if (q && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(q)) return q;
  } catch { /* 非浏览器环境 */ }
  return null;
}
export const PATHS = {
  DATA: dataUrlFromQuery() || CONFIG.DATA_URL,
  KLINE: 'klines/{mint}_{interval}.json',
};
const KLINE_TTL_MS = CONFIG.REFRESH_MS;   // K 线缓存多久后重新拉（和主数据刷新同步）

export async function loadData(url = PATHS.DATA) {
  const r = await fetch(bust(url), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return normalize(await r.json(), new URL(url, location.href).href);
}
const bust = url => url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / KLINE_TTL_MS);

export const toSec = t => {
  if (t == null) return null;
  if (typeof t === 'string' && /^\d+(\.\d+)?$/.test(t.trim())) t = +t;
  if (typeof t === 'number') return !isFinite(t) ? null : t > 1e12 ? Math.floor(t / 1000) : Math.floor(t); // 兼容毫秒
  if (typeof t !== 'string') return null;
  const ms = Date.parse(t); return isNaN(ms) ? null : Math.floor(ms / 1000);
};
const candle = c => Array.isArray(c)
  ? { time: toSec(c[0]), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +(c[5] ?? 0) }
  : { time: toSec(c.time ?? c.t), open: +(c.open ?? c.o), high: +(c.high ?? c.h), low: +(c.low ?? c.l), close: +(c.close ?? c.c), volume: +(c.volume ?? c.v ?? 0) };
// 同一时间戳只留最后一条（BUG-004：重复时间会让图表库报 “Value is null” 整张图空白）
export function dedupe(rows) {
  const out = [];
  for (const r of rows) { if (out.length && out[out.length - 1].time === r.time) out[out.length - 1] = r; else out.push(r); }
  return out;
}
const okBar = c => c.time != null && isFinite(c.time) && [c.open, c.high, c.low, c.close].every(v => isFinite(v) && v > 0);  // 负价/0 价丢掉（BUG-011）
const candles = arr => dedupe((arr || []).map(candle).filter(okBar).map(c => ({ ...c, volume: isFinite(c.volume) && c.volume > 0 ? c.volume : 0 }))
  .sort((a, b) => a.time - b.time));

// 按“一买一卖算一笔”从成交明细里算统计（后端没给这些字段时的兜底；后端给了就用后端的）
// 有 position_id 按它配对；没有时按 币+策略 分“轮”：数量卖到 ≈0 后的下一次买入算新一轮（数量缺失时：卖出之后的买入算新一轮）。
// 有未平仓持仓时，只把该 币+策略 的【最后一轮】当作未平仓，之前已平掉的轮照常计数（BUG-008）。
function countTrades(trades, openKeys) {
  const rounds = [], cur = new Map();
  let buys = 0, sells = 0;
  for (const x of [...trades].sort((a, b) => a.time - b.time)) {
    if (x.action === 'buy') buys++; else if (x.action === 'sell') sells++; else continue;
    const key = x.position_id ?? `${x.mint}|${x.strategy}`, byId = x.position_id != null;
    let r = cur.get(key);
    const qty = num(x.qty);
    if (x.action === 'buy' && r && !byId && r.sold && (r.qty == null || qty == null || r.qty <= Math.max(1e-9, r.bought * 1e-6))) r = null;
    if (!r) { r = { key, pnl: 0, sold: false, qty: 0, bought: 0 }; cur.set(key, r); rounds.push(r); }
    if (x.action === 'buy') { if (qty == null || r.qty == null) r.qty = null; else { r.qty += qty; r.bought += qty; } }
    else { r.pnl += num(x.pnl) ?? 0; r.sold = true; if (qty == null || r.qty == null) r.qty = null; else r.qty -= qty; }
  }
  const lastOf = new Map(rounds.map(r => [r.key, r]));     // 每个 key 的最后一轮
  const closed = rounds.filter(r => r.sold && !(openKeys.has(r.key) && lastOf.get(r.key) === r));
  // V2-06：净盈亏 > 0 胜，< 0 负，= 0 持平（持平不算负）。v4：胜率 = 胜 ÷（胜 + 负），持平不计入分母
  const wins = closed.filter(p => outcome(p.pnl) === 'win').length, losses = closed.filter(p => outcome(p.pnl) === 'loss').length;
  return { closed_count: closed.length, wins, losses, flats: closed.length - wins - losses,
    win_rate: winRate(wins, losses), buy_count: buys, sell_count: sells };
}
// v4 胜率口径（软件负责人 11-02 定）：胜 ÷（胜 + 负），持平不进分母；没有胜负（全是持平或还没平仓）时为 null，页面显示「—」
export const winRate = (w, l) => Number.isFinite(w) && Number.isFinite(l) && w + l > 0 ? +(w / (w + l) * 100).toFixed(1) : null;
// 一笔（或一个仓位）净盈亏的归类；|pnl| < 1e-9 视为 0（浮点噪声）
export const FLAT_EPS = 1e-9;
export const outcome = pnl => !Number.isFinite(pnl) ? null : pnl > FLAT_EPS ? 'win' : pnl < -FLAT_EPS ? 'loss' : 'flat';
const COUNT_KEYS = ['closed_count', 'wins', 'losses', 'buy_count', 'sell_count'];
const NUM_KEYS = ['start', 'cash', 'equity', 'pnl', 'pnl_pct', 'realized_pnl', 'unrealized_pnl', 'win_rate', 'max_drawdown_pct'];
const str = v => v == null ? '' : typeof v === 'object' ? '' : String(v);

// 胜 / 负 / 平 + v4 胜率（页面自己算，不用导出的 win_rate：导出现在是 wins ÷ closed_count 旧口径）
function wlOf(s, derived) {
  const closed = num(s.closed_count), lossesRaw = num(s.losses);
  if (derived.closed_count === (closed ?? derived.closed_count)) {
    const wins = num(s.wins) ?? derived.wins;
    return { wins, losses: derived.losses, flats: derived.flats, lossesRaw, win_rate: winRate(wins, derived.losses), wrSrc: 'trades' };
  }
  // v5：导出的持平字段正式名是 breakeven；旧数据只有 flats 时兜底
  const wins = num(s.wins), flats = num(s.breakeven) ?? num(s.flats);
  let losses = lossesRaw;
  if (flats != null && wins != null && closed != null && lossesRaw === closed - wins) losses = lossesRaw - flats;
  return { wins, losses, flats, lossesRaw, win_rate: winRate(wins, losses), wrSrc: flats == null && losses ? 'export-maybe-flats' : 'export' };
}

export function normalize(raw, base = (typeof location !== 'undefined' ? new URL(PATHS.DATA, location.href).href : PATHS.DATA)) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const arr = v => Array.isArray(v) ? v : [];
  // v0.4：成交带 market_price（不含成本，用来画买卖点）和 fill_price（含模拟成本）；旧数据只有 price → 两个都用它
  const events = [];
  // 一条扫描记录 → 界面模型。先读 v0.5 的 x.type 和 x.data（data 已经是对象）：
  //   data._parse_error === true → parseError，界面标「内容无法解析」并显示转义后的 data._raw；否则 summary = data 本身。
  // 没有 data 字段的老格式（tasks.csv 混进 trades/skips 的行，reason 里是 JSON 字符串）才用 parseSummary(x.reason) 兜底。
  const toEvent = (x, from) => {
    const type = str(x.type) || str(x.stage || x.action);
    const data = x.data && typeof x.data === 'object' && !Array.isArray(x.data) ? x.data : null;
    const isSum = /summary/.test(type) || isSummaryRow(x);
    const base = { time: toSec(x.time), from, strategy: rowStrategy(x), stage: type, result: str(x.result), reason: str(x.reason) };
    if (data) {
      const parseError = data._parse_error === true;
      return { ...base, kind: isSum || parseError ? 'summary' : 'global', parseError, raw: parseError ? str(data._raw) : '',
        summary: parseError ? null : { data, truncated: false }, reason: base.reason || (parseError ? str(data._raw) : JSON.stringify(data)) };
    }
    return { ...base, kind: isSum ? 'summary' : 'global', parseError: false, raw: '', summary: isSum ? parseSummary(x.reason) : null };
  };
  const trades = arr(raw.trades).filter(x => {
    // 只有 buy/sell 才是成交；汇总行等混进来的非买卖行挪到 events
    if (x && (x.action === 'buy' || x.action === 'sell')) return true;
    if (x && typeof x === 'object') events.push(toEvent(x, 'trades'));
    return false;
  }).map(x => {
    const market = num(x.market_price) ?? num(x.price), fill = num(x.fill_price) ?? num(x.price);
    return { ...x, id: str(x.id), strategy: rowStrategy(x), mint: str(x.mint), symbol: str(x.symbol), reason: str(x.reason),
      action: x.action === 'buy' || x.action === 'sell' ? x.action : str(x.action),
      time: toSec(x.time), price: fill ?? market, market_price: market, fill_price: fill,
      qty: num(x.qty), usd: num(x.usd), pnl: num(x.pnl), pnl_pct: num(x.pnl_pct), cost_pct_per_side: num(x.cost_pct_per_side), agent: str(x.agent) };
  }).filter(x => x.time != null).sort((a, b) => b.time - a.time);
  const strategies = arr(raw.strategies).map((s, i) => {
    const id = str(s.id) || `strategy_${i + 1}`;
    const meta = STRATEGY_META[id] || (isControl({ ...s, id }) ? STRATEGY_META.S0 : {}) || {};
    const positions = arr(s.positions).map(p => ({ ...p, strategy: id, mint: str(p.mint), symbol: str(p.symbol),
      opened_at: toSec(p.opened_at), entry_price: num(p.entry_price), last_price: num(p.last_price),
      value_usd: num(p.value_usd), cost_usd: num(p.cost_usd), pnl_pct: num(p.pnl_pct), qty: num(p.qty), pool_missing: p.pool_missing === true,
      price_source: str(p.price_source) || null }));   // v0.5：gt_close | last_trade
    const derived = countTrades(trades.filter(x => x.strategy === id),
      new Set(positions.map(p => p.position_id ?? `${p.mint}|${id}`)));
    const pick = k => { const v = num(s[k]); return v != null ? v : derived[k]; };
    const nums = Object.fromEntries(NUM_KEYS.map(k => [k, num(s[k])]));
    // 权益曲线：[t, v] / [t, v, {backfilled:true}]（v0.4 文档写法）/ [t, v, true] / {time, value, backfilled}；v0.4 backfilled=由 trades.csv 回补的已实现权益
    const curve = arr(s.equity_curve).map(p => Array.isArray(p)
      ? { time: toSec(p[0]), value: num(p[1]), backfilled: p[2] === true || p[2]?.backfilled === true }   // v0.4 正式写法 [t, v, {backfilled:true}]
      : p && typeof p === 'object' ? { time: toSec(p.time ?? p.t), value: num(p.value ?? p.v), backfilled: p.backfilled === true } : null)
      .filter(p => p && p.time != null && p.value != null).sort((a, b) => a.time - b.time);
    const name = str(s.name).trim() || meta.name || id;   // 缺 name 用 id 兜底（BUG-011）
    return {
      ...s, ...nums, id, name, role: roleOf({ ...s, id }), roleRaw: str(s.role) || null,
      short: str(s.short) || meta.short || name.replace(/（.*?）/g, '').slice(0, 3),
      tag: str(s.tag ?? meta.tag ?? ''), desc: str(s.desc ?? meta.desc ?? ''), dashed: s.dashed != null ? s.dashed === true : !!meta.dashed,
      // 颜色只认白名单格式，不合法的换成默认色（BUG-005）
      color: safeColor(s.color) || meta.color || CONFIG.STRATEGY_COLORS[i % CONFIG.STRATEGY_COLORS.length],
      ...Object.fromEntries(COUNT_KEYS.map(k => [k, pick(k)])),
      // V2-06：导出（export_klines.py）的 losses = closed_count − wins，把持平也算成了负（程序员会在 S0 小修复包里改）。
      // 成交明细能对上已平仓笔数时，胜/负/平按明细重算；对不上（成交早于导出范围）时用导出值：
      // 导出给了 flats 且 losses 是旧口径（= closed − wins）→ 负 = losses − flats；没给 flats → 持平记为未知（null），负场可能含持平
      ...wlOf(s, derived),
      equity_curve: dedupe(curve),
      positions,
      cost_pct_per_side: num(s.cost_pct_per_side),
      // v0.4：desk_v1 以外、现金和持仓不在 state.json 里的策略标 ledger="trades_only"，start/cash/equity/pnl 等为 null
      ledger: str(s.ledger) || null,
    };
  });
  const IV = Object.keys(CONFIG.INTERVALS);
  const tokens = arr(raw.tokens).map(t => {
    const inline = {};   // 兼容：旧版 data.json 里直接带 candles
    for (const [iv, rows] of Object.entries(t.candles || {})) if (Array.isArray(rows) && rows.length && IV.includes(iv)) inline[iv] = candles(rows);
    const files = t.kline_files ? Object.keys(t.kline_files) : null;
    const given = Array.isArray(t.intervals) ? t.intervals.filter(iv => IV.includes(iv)) : null;
    const intervals = given ?? files ?? (Object.keys(inline).length ? Object.keys(inline) : null); // null = 不知道，按需去试；[] = 明确没有 K 线
    const { candles: _drop, ...rest } = t;
    return { ...rest, mint: str(t.mint), symbol: str(t.symbol) || short6(t.mint), name: str(t.name), status: str(t.status), pool: str(t.pool) || null,
      last_price: num(t.last_price), change_24h: num(t.change_24h), intervals, inline };
  }).filter(t => t.mint);
  const skips = arr(raw.skips).filter(x => x && typeof x === 'object').filter(x => {
    if (isGlobalRow({ ...x, stage: str(x.stage || x.action) })) { events.push(toEvent(x, 'skips')); return false; }
    return true;
  }).map(x => ({ ...x, time: toSec(x.time), strategy: rowStrategy(x), mint: str(x.mint), symbol: str(x.symbol),
    stage: str(x.stage), reason: str(x.reason) })).filter(x => x.time != null).sort((a, b) => b.time - a.time);
  // 后端将来如果单独给 scan_summaries / events 数组，也收进来
  // v0.5：顶层 events = 最近约 48 条 scan_summary 对象（time 是 UTC epoch 秒）。字段可能直接平铺（raw/queued/…），
  // 也可能放在 summary/data 里，或者是 reason 里的 JSON 字符串 —— 三种都认；缺字段不报错
  const META_KEYS = new Set(['time', 't', 'ts', 'type', 'kind', 'action', 'stage', 'result', 'reason', 'strategy', 'agent', 'mint', 'symbol', 'summary', 'data']);
  for (const x of [...arr(raw.scan_summaries), ...arr(raw.events)]) {
    if (!x || typeof x !== 'object') continue;
    const type = str(x.type || x.kind || x.action || x.stage);
    if (type && !/summary/.test(type) && str(x.mint).trim() && !NO_MINT(str(x.mint).trim())) continue;   // 未知的非汇总事件先忽略
    // v0.5 正式写法 {time, type, agent, strategy, data:{…}} 直接交给 toEvent；早期草稿的 summary 对象 / 平铺字段转成 data 再交
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    const flat = Object.fromEntries(Object.entries(x).filter(([k, v]) => !META_KEYS.has(k) && (v == null || typeof v !== 'object')));
    const data = isObj(x.data) ? x.data : isObj(x.summary) ? x.summary : Object.keys(flat).length ? flat : undefined;
    const ev = toEvent({ type: 'scan_summary', ...x, data, time: x.time ?? x.t ?? x.ts }, 'events');
    ev.kind = 'summary';
    events.push(ev);
  }
  const evs = events.filter(e => e.time != null).sort((a, b) => b.time - a.time);
  const gen = typeof raw.generated_at === 'string' || typeof raw.generated_at === 'number' ? raw.generated_at : '';
  return {
    sample: raw.sample === true, sampleNote: str(raw.sample_note),
    paper: raw.paper === true ? true : raw.paper === false ? false : null,   // null = 没标注（BUG-007）
    schemaVersion: str(raw.schema_version), timeUnit: str(raw.time_unit), generatedAt: str(gen), generatedTs: gen === '' ? null : parseIso(gen), base,
    klinePath: typeof raw.kline_path === 'string' ? raw.kline_path : null, klineIndex: typeof raw.kline_index === 'string' ? raw.kline_index : null,
    strategies, tokens, trades, skips, events: evs,
  };
}
const short6 = m => m ? String(m).slice(0, 6) : '';

// ---------- K 线按需加载 ----------
const rel = (path, base) => { try { return new URL(path, base).href; } catch { return path; } };
export function klineUrl(token, interval, model, index) {
  const ent = index?.tokens?.[token.mint]?.intervals?.[interval];
  if (ent?.file) return rel(ent.file, index.url);                       // v0.3：index.json 里的 file，相对 index.json
  if (token.kline_files?.[interval]) return rel(token.kline_files[interval], model?.base);
  const tpl = token.kline_file || model?.klinePath || PATHS.KLINE;
  return rel(tpl.replaceAll('{mint}', encodeURIComponent(token.mint)).replaceAll('{symbol}', encodeURIComponent(token.symbol || ''))
    .replaceAll('{interval}', interval), model?.base);
}

// v0.3 klines/index.json：可选。拿到了就用它的 file 名和 bars/from/to/bytes，拿不到（404/出错）就只按 data.json 走。
export async function loadIndex(model) {
  if (!model?.klineIndex) return null;
  const url = rel(model.klineIndex, model.base);
  try {
    const j = await fetchFile(url);
    return j && typeof j === 'object' ? { url, tokens: j.tokens || {}, generatedAt: j.generated_at } : null;
  } catch { return null; }
}

const cache = new Map();   // url → { at, promise }；404 也缓存（结果为 null），网络错误不缓存
function fetchFile(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < KLINE_TTL_MS) return hit.promise;
  const promise = fetch(bust(url), { cache: 'no-store' }).then(async r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  const entry = { at: Date.now(), promise };
  cache.set(url, entry);
  promise.catch(() => { if (cache.get(url) === entry) cache.delete(url); });
  return promise;
}
// 某个 K 线文件是否已在缓存里（已加载完/正在加载），界面据此决定要不要显示“加载中”
export const klineCached = (token, interval, model) => {
  if (model?.klineIndex && !cache.has(rel(model.klineIndex, model.base))) return false;
  const idx = model?.klineIndex ? model._index : null;
  return cache.has(klineUrl(token, interval, model, idx));
};
export function clearKlineCache() { cache.clear(); }

// 读一个 K 线文件里指定周期的数据（兼容单周期文件和一币一文件两种写法）
function readKlineFile(json, interval) {
  if (!json) return null;
  if (Array.isArray(json)) return candles(json);
  const c = json.candles ?? json.klines ?? json.data;
  if (Array.isArray(c)) return !json.interval || json.interval === interval ? candles(c) : null;
  if (c && typeof c === 'object') return c[interval]?.length ? candles(c[interval]) : null;
  return null;
}

// 周期是否“可能有数据”：直接有，或有能整除它的更小周期（可聚合）。intervals 未知时一律当作可能有。
export function intervalAvailable(token, interval, model) {
  if (!token) return false;
  const ivs = token.intervals ?? (model?._index?.tokens?.[token.mint] ? Object.keys(model._index.tokens[token.mint].intervals || {}) : null);
  if (!ivs) return true;
  const sec = CONFIG.INTERVALS[interval];
  return ivs.some(iv => CONFIG.INTERVALS[iv] && CONFIG.INTERVALS[iv] <= sec && sec % CONFIG.INTERVALS[iv] === 0);
}
export const hasKline = token => !!token && (token.intervals == null || token.intervals.length > 0);

/** 取某币某周期 K 线。
 *  返回 { data, derived:false|源周期, url, missing:boolean, tried:[url], meta }；网络/解析错误会抛出。
 *  meta（v0.3）= { pool, source, filled, generatedAt, bars, from, to, bytes }，取自 K 线文件头和 index.json，缺的为 undefined。 */
export async function loadCandles(token, interval, model) {
  const index = await loadIndex(model);
  if (model) model._index = index;
  const ient = index?.tokens?.[token.mint];
  // data.json 没写 intervals 时，用 index.json 的（v0.3 说两者一致）
  const known = token.intervals ?? (ient ? Object.keys(ient.intervals || {}) : null);
  const sec = CONFIG.INTERVALS[interval];
  const order = [interval, ...Object.keys(CONFIG.INTERVALS)
    .filter(iv => CONFIG.INTERVALS[iv] < sec && sec % CONFIG.INTERVALS[iv] === 0)
    .sort((a, b) => CONFIG.INTERVALS[b] - CONFIG.INTERVALS[a])];
  const tried = [];
  for (const iv of order) {
    if (token.inline[iv]?.length) return done(token.inline[iv], iv, interval, null, tried);
    if (known && !known.includes(iv)) continue;   // 明确没有这个周期的文件，不去请求
    const url = klineUrl(token, iv, model, index);
    tried.push(url);
    const json = await fetchFile(url);
    const rows = readKlineFile(json, iv);
    if (rows?.length) {
      const h = json && !Array.isArray(json) ? json : {}, m = ient?.intervals?.[iv] || {};
      // 文件头里的字段都当不可信数据：数字转数字，字符串转字符串（BUG-005）
      const meta = { pool: str(h.pool ?? ient?.pool ?? token.pool) || null, source: str(h.source), filled: num(h.filled), generatedAt: str(h.generated_at),
                     bars: num(m.bars) ?? rows.length, from: m.from, to: m.to, bytes: num(m.bytes) };
      return done(rows, iv, interval, url, tried, meta);
    }
  }
  return { data: [], derived: false, url: null, missing: true, tried, meta: null };
}
function done(rows, src, interval, url, tried, meta = {}) {
  if (src === interval) return { data: rows, derived: false, url, missing: false, tried, meta };
  return { data: aggregate(rows, CONFIG.INTERVALS[interval]), derived: src, url, missing: false, tried, meta };
}
export function aggregate(rows, sec) {
  const out = [];
  for (const c of rows) {
    const b = c.time - (c.time % sec), last = out[out.length - 1];
    if (last && last.time === b) {
      last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume;
    } else out.push({ ...c, time: b });
  }
  return out;
}
