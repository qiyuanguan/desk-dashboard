import { CONFIG, REASONS, ENTRY_PARTS, REASON_RULES, REASON_UNKNOWN } from './config.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => v != null && v !== '' && isFinite(v);            // null / '' / NaN / 字符串乱码 都算没有
export const num = v => fin(v) ? +v : null;
// 超大金额（> 1 万亿）用科学计数，免得撑破手机卡片（BUG-011）
export const usd = v => !fin(v) ? '–' : Math.abs(v) >= 1e12 ? (v < 0 ? '-$' : '$') + Math.abs(+v).toExponential(2)
  : (v < 0 ? '-$' : '$') + Math.abs(+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const sUsd = v => !fin(v) ? '–' : (v > 0 ? '+' : '') + usd(v);
const fx = (v, d) => Math.abs(v) >= 1e6 ? (+v).toExponential(2) : (+v).toFixed(d);
export const pct = (v, d = 1) => !fin(v) ? '–' : (v > 0 ? '+' : '') + fx(v, d) + '%';
export const plain = (v, d = 1) => !fin(v) ? '–' : fx(v, d) + '%';
export const cls = v => !fin(v) ? 'flat' : v > 0 ? 'up' : v < 0 ? 'dn' : 'flat';
// 原因代码 → 中文：精确表 → 策略入场 "S2:donchian12_vol2.3x" → 前缀规则 → 兜底“其他原因（代码）”（BUG-006）
export function reason(k) {
  if (k == null || k === '') return '';
  k = String(k).trim();
  if (REASONS[k]) return REASONS[k];
  const m = /^(S\w+):(.+)$/.exec(k);
  if (m) {
    const parts = m[2].split('_').map(p => { for (const [re, f] of ENTRY_PARTS) { const x = re.exec(p); if (x) return f(x); } return p; });
    return `${m[1]} 入场：${parts.join('，')}`;
  }
  for (const [re, f] of REASON_RULES) { const x = re.exec(k); if (x) return f(x, y => reasonKnown(y) ? reason(y) : y); }
  return REASON_UNKNOWN(k);
}
// 是否是认识的代码（check_reasons.mjs 用来列出没翻译的代码）
export const reasonKnown = k => !String(reason(k)).startsWith(REASON_UNKNOWN('').slice(0, 4));
// 颜色白名单：只认 #rgb / #rrggbb / #rrggbbaa 和纯数字的 rgb()/rgba()；其它一律不用（BUG-005：防止颜色字段注入样式/属性）
export const safeColor = c => typeof c === 'string' &&
  (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.test(c.trim()))
  ? c.trim() : null;
// 给 #rrggbb 加透明度（权益曲线回补段用）
export function alpha(c, a) {
  let h = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2})?$/i.exec(c || '')?.[1];
  if (!h) return c;
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  return '#' + h + Math.round(a * 255).toString(16).padStart(2, '0');
}
export const short = m => m && m.length > 12 ? m.slice(0, 4) + '…' + m.slice(-4) : (m || '');
// 区分同名币用的 mint 缩写：pump.fun 的 mint 都以 pump 结尾，取 pump 前面几位才分得开
export const shortId = m => !m || m.length <= 12 ? (m || '') : /pump$/.test(m) ? m.slice(0, 4) + '…' + m.slice(-8) : short(m);

// 小价格用下标零：0.0000123 → 0.0₄123
const SUB = '₀₁₂₃₄₅₆₇₈₉';
export function price(p) {
  if (!fin(p)) return '–';
  p = +p;
  if (p === 0) return '0';
  const sign = p < 0 ? '-' : '', a = Math.abs(p);
  if (a >= 1) return sign + a.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // 先四舍五入到 4 位有效数字，再拆成“前导零个数 + 有效数字”。
  // （旧写法是直接截断 toFixed(20) 的字符串，图表刻度的浮点误差 0.0000239999… 会显示成 0.0₄2399）
  const [mant, exp] = a.toExponential(3).split('e');           // "2.400", "-5"
  const e = +exp;
  if (e >= 0) return sign + a.toLocaleString('en-US', { maximumFractionDigits: 4 });   // 四舍五入后进位到 1
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0'; // "24"
  const zeros = -e - 1;                                          // 小数点后前导零个数
  if (zeros <= 2) return sign + (+a.toPrecision(4)).toString().replace(/(\.\d*?)0+$/, '$1');
  return sign + '0.0' + String(zeros).split('').map(d => SUB[d]).join('') + digits;
}
export const compact = v => !fin(v) ? '–' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : (+v).toFixed(0);

const dtf = new Intl.DateTimeFormat('zh-CN', { timeZone: CONFIG.TIMEZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const tf = new Intl.DateTimeFormat('zh-CN', { timeZone: CONFIG.TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat('zh-CN', { timeZone: CONFIG.TIMEZONE, month: 'numeric', day: 'numeric' });
const zf = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.TIMEZONE, timeZoneName: 'short' });
// 非法时间（null / NaN / 字符串乱码 / 超出 Date 范围）一律返回 '–'，不抛错（BUG-002）
const okT = t => fin(t) && Math.abs(t) < 8.64e12;
const parts = (f, t) => Object.fromEntries(f.formatToParts(new Date(t * 1000)).map(p => [p.type, p.value]));
export function dt(t) { if (!okT(t)) return '–'; const p = parts(dtf, t); return `${p.month}-${p.day} ${p.hour}:${p.minute}`; }
export function hm(t) { if (!okT(t)) return ''; const p = parts(tf, t); return `${p.hour}:${p.minute}`; }
export function md(t) { return okT(t) ? df.format(new Date(t * 1000)) : ''; }
// 时区缩写随日期变：冬令时 PST，夏令时 PDT（BUG-012）。t 省略=现在
export function tz(t) {
  const d = new Date(okT(t) ? t * 1000 : Date.now());
  return zf.formatToParts(d).find(p => p.type === 'timeZoneName')?.value || CONFIG.TZ_LABEL;
}
// 字符串时间（ISO）→ Unix 秒；解析不了返回 null
export const parseIso = s => { if (fin(s)) return +s > 1e12 ? Math.floor(s / 1000) : +s; const ms = Date.parse(s); return isNaN(ms) ? null : Math.floor(ms / 1000); };
