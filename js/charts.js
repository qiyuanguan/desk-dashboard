// 图表封装（TradingView lightweight-charts v4，vendor/ 本地文件，无需 CDN）
import { CONFIG } from './config.js?v=20261102-v5';
import { price, dt, hm, md, tz, alpha } from './fmt.js?v=20261102-v5';

const LC = window.LightweightCharts;

function baseOptions(el) {
  return {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b98a8', fontSize: 11,
      fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif' },
    grid: { vertLines: { color: 'rgba(35,45,58,.55)' }, horzLines: { color: 'rgba(35,45,58,.55)' } },
    rightPriceScale: { borderColor: '#232d3a' },
    timeScale: { borderColor: '#232d3a', timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (t, type) => (type <= 2 ? md(t) : hm(t)) },   // 0年 1月 2日 → 显示日期，否则时分
    localization: { locale: 'zh-CN', timeFormatter: t => dt(t) + ' ' + tz(t) },
    crosshair: { mode: 0, vertLine: { color: '#475569', labelBackgroundColor: '#334155' }, horzLine: { color: '#475569', labelBackgroundColor: '#334155' } },
    handleScale: { axisPressedMouseMove: true }, handleScroll: { vertTouchDrag: false },
  };
}
function autoResize(chart, el) {
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

// 喂给图表前的最后一道关：只留数值有限的点，时间严格递增（重复时间留最后一条）。BUG-004
export function clean(rows, keys) {
  const out = [];
  for (const r of rows || []) {
    if (r == null || !Number.isFinite(r.time) || !keys.every(k => Number.isFinite(r[k]))) continue;
    if (out.length && r.time < out[out.length - 1].time) continue;
    if (out.length && r.time === out[out.length - 1].time) out[out.length - 1] = r; else out.push(r);
  }
  return out;
}

// ---------- 权益曲线 ----------
// 每个策略两条线：实线/虚线 = 正常记录的权益；淡色点线 = v0.4 由 trades.csv 回补的已实现权益（backfilled）。
// 起始资金基准线挂在单独的一条透明“基准”序列上，隐藏任何策略都不影响它（BUG-013）。
export function createEquityChart(el) {
  const chart = LC.createChart(el, baseOptions(el));
  chart.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.08 } } });
  autoResize(chart, el);
  const series = new Map();   // id → { main, bf }
  const usdFmt = { type: 'custom', formatter: v => '$' + v.toFixed(2), minMove: 0.01 };
  const pctFmt = { type: 'custom', formatter: v => (v > 0 ? '+' : '') + v.toFixed(2) + '%', minMove: 0.01 };
  const pf = usdFmt;
  const baseSer = chart.addLineSeries({ color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false, priceFormat: pf });
  let baseLine = null, info = { mode: 'usd', base: null, starts: [], auxScaled: false };
  const keepScale = orig => orig();
  const noScale = () => null;     // V2-04：对照组/未分类不参与纵轴缩放
  const api = {
    chart,
    // opts.mode：'usd' 金额 | 'pct' 收益率（每个策略按自己的 start 换算）；opts.showAux：是否画对照组/未分类曲线
    setData(strategies, hidden, { mode = 'usd', showAux = true } = {}) {
      for (const [id, s] of series) if (!strategies.find(x => x.id === id)) { chart.removeSeries(s.main); chart.removeSeries(s.bf); series.delete(id); }
      const visFormal = strategies.filter(s => s.role === 'formal' && !hidden.has(s.id) && s.equity_curve.length);
      const fmt = mode === 'pct' ? pctFmt : usdFmt;
      // 正式曲线几乎是平的（波动 < 起点的 1%，例如刚上线还没成交）时没什么可“压扁”的，对照组 / 未分类照常参与缩放，免得它们整条被截出图外
      const fv = visFormal.flatMap(s => { const st = s.start > 0 ? s.start : null;
        return s.equity_curve.map(p => p.value).filter(Number.isFinite).map(v => mode === 'pct' ? (st ? (v / st - 1) * 100 : NaN) : v); }).filter(Number.isFinite);
      const fSpan = fv.length ? Math.max(...fv) - Math.min(...fv) : 0, fRef = mode === 'pct' ? 100 : Math.max(...fv.map(Math.abs), 0);
      const formalFlat = fv.length > 0 && fSpan < 0.01 * fRef;
      for (const s of strategies) {
        let ser = series.get(s.id);
        if (!ser) {
          ser = { bf: chart.addLineSeries({ lineWidth: 2, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf }),
                  main: chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: pf, title: '' }) };
          series.set(s.id, ser);
        }
        const st = Number.isFinite(s.start) && s.start > 0 ? s.start : null;
        const tf = mode === 'pct' ? (st ? v => (v / st - 1) * 100 : null) : v => v;
        const pts = tf ? clean(s.equity_curve, ['value']).map(p => ({ ...p, value: tf(p.value) })) : [];
        const lastBf = pts.reduce((r, p, i) => p.backfilled ? i : r, -1);
        // 回补段：从开头到最后一个回补点，再连到第一个正常点，两段首尾相接
        const bf = lastBf >= 0 ? pts.slice(0, Math.min(pts.length, lastBf + 2)) : [];
        const main = pts.filter(p => !p.backfilled);
        ser.bf.setData(bf.map(({ time, value }) => ({ time, value })));
        ser.main.setData(main.map(({ time, value }) => ({ time, value })));
        const aux = s.role !== 'formal';
        const vis = !hidden.has(s.id) && (!aux || showAux);
        // 纵轴以正式策略为主：有可见的正式曲线时，对照组/未分类曲线不参与自动缩放（V2-04）
        const asp = aux && visFormal.length && !formalFlat ? noScale : keepScale;
        ser.main.applyOptions({ visible: vis, color: s.color, lineStyle: s.dashed ? 2 : 0, priceFormat: fmt, autoscaleInfoProvider: asp,
          title: s.role === 'control' ? '对照' : s.role === 'other' ? '未分类' : '' });  // 虚线；对照组在价格轴标签上写“对照”
        ser.bf.applyOptions({ visible: vis, color: alpha(s.color, 0.5), lineStyle: 1, priceFormat: fmt, autoscaleInfoProvider: asp });
      }
      baseSer.applyOptions({ priceFormat: fmt });
      // 起始线（V2-04）：收益率模式 = 0%；金额模式只在【可见的正式策略】起始资金都相同时才画（各不相同时一条线没有意义）
      const starts = [...new Set(visFormal.map(s => s.start).filter(v => Number.isFinite(v) && v > 0))];
      const base = mode === 'pct' ? (visFormal.length ? 0 : null) : starts.length === 1 ? starts[0] : null;
      info = { mode, base, starts, auxScaled: !visFormal.length || formalFlat, formalFlat, hiddenAux: showAux ? 0 : strategies.filter(s => s.role !== 'formal').length };
      const times = visFormal.flatMap(s => s.equity_curve.map(p => p.time)).filter(Number.isFinite);
      if (base != null && times.length) {
        const t0 = Math.min(...times), t1 = Math.max(...times);
        baseSer.setData(t0 === t1 ? [{ time: t0, value: base }] : [{ time: t0, value: base }, { time: t1, value: base }]);
        const title = mode === 'pct' ? '起始 0%' : '起始';
        if (!baseLine) baseLine = baseSer.createPriceLine({ price: base, color: '#475569', lineStyle: 1, lineWidth: 1, axisLabelVisible: true, title });
        else baseLine.applyOptions({ price: base, title });
      } else { baseSer.setData([]); if (baseLine) { baseSer.removePriceLine(baseLine); baseLine = null; } }
    },
    info: () => ({ ...info, baseLine: !!baseLine && baseSer.data().length > 0 }),
    // 自测用：当前纵轴可见范围
    axisRange: () => { const h = el.clientHeight - 30; const a = [...series.values()][0]?.main; return a ? [a.coordinateToPrice(h), a.coordinateToPrice(0)] : null; },
    baseLineVisible: () => !!baseLine && baseSer.data().length > 0 && baseSer.options().visible !== false,
    backfillInfo: () => [...series.entries()].map(([id, s]) => ({ id, bf: s.bf.data().length, style: s.bf.options().lineStyle, color: s.bf.options().color, main: s.main.data().length })),
    setRange(days, strategies) {
      const all = strategies.flatMap(s => s.equity_curve);
      if (!all.length) return;
      const to = Math.max(...all.map(p => p.time)), from0 = Math.min(...all.map(p => p.time));
      if (!days) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: Math.max(from0, to - days * 86400), to });
    },
  };
  return api;
}

// ---------- K 线 ----------
export function createKline(el, onCrosshair) {
  const chart = LC.createChart(el, baseOptions(el));
  autoResize(chart, el);
  // SMK-03：价格轴跟着价格量级走 —— 刻度步长 minMove = 价格量级 × 1e-4；低于 0 的刻度（被成交量区挤出来的边距）不显示，
  // 接近 0 的浮点噪声（0.0₂₀5 这种）显示成 0；自动缩放下限不低于 0
  let mag = 1;
  const axisFmt = v => !Number.isFinite(v) ? '' : v < -mag * 1e-6 ? '' : Math.abs(v) < mag * 1e-6 ? '0' : price(v);
  const pfFor = m => ({ type: 'custom', formatter: axisFmt, minMove: Math.max(1e-15, 10 ** (Math.floor(Math.log10(m)) - 4)) });
  const candles = chart.addCandlestickSeries({ priceFormat: pfFor(1), borderVisible: false,
    autoscaleInfoProvider: orig => { const r = orig(); if (r?.priceRange) r.priceRange.minValue = Math.max(0, r.priceRange.minValue); return r; } });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  let lines = [], data = [], colors = { up: '#22c55e', dn: '#ef4444' };
  chart.subscribeCrosshairMove(p => {
    const c = p?.time != null ? p.seriesData.get(candles) : null;
    const v = p?.time != null ? p.seriesData.get(volume) : null;
    onCrosshair(c ? { ...c, volume: v?.value } : (data.length ? data[data.length - 1] : null), c ? { time: p.time, point: p.point } : null);
  });
  return {
    chart,
    // 自测用（SMK-03）：价格轴从上到下 12 个位置的价格和它们会显示成的刻度文字
    debugAxis() {
      const h = el.clientHeight - 30, ys = Array.from({ length: 12 }, (_, i) => Math.round(i * h / 11));
      const ps = ys.map(y => candles.coordinateToPrice(y)).filter(v => v != null);
      return { mag, minMove: candles.options().priceFormat.minMove, prices: ps, labels: ps.map(axisFmt) };
    },
    setColors(c) {
      colors = c;
      candles.applyOptions({ upColor: c.up, downColor: c.dn, wickUpColor: c.up, wickDownColor: c.dn });
    },
    setData(bars, { keepRange } = {}) {
      bars = clean(bars, ['open', 'high', 'low', 'close']);
      data = bars;
      const hi = bars.reduce((a, b) => Math.max(a, b.high), 0);
      if (hi > 0 && Math.abs(Math.log10(hi / mag)) > 0.5) { mag = hi; candles.applyOptions({ priceFormat: pfFor(hi) }); }
      const range = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
      candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      volume.setData(bars.map(b => ({ time: b.time, value: Number.isFinite(b.volume) ? b.volume : 0, color: (b.close >= b.open ? colors.up : colors.dn) + '66' })));
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else {
        const n = bars.length, show = Math.min(n, el.clientWidth < 600 ? 70 : 140);
        chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 3 });
      }
      onCrosshair(bars[bars.length - 1] || null);
      return bars;
    },
    setMarkers(markers) { candles.setMarkers(markers); },
    markers: () => candles.markers(),
    timeToX: t => chart.timeScale().timeToCoordinate(t),
    priceToY: v => candles.priceToCoordinate(v),
    setEntryLines(list) {
      lines.forEach(l => candles.removePriceLine(l));
      lines = list.filter(x => Number.isFinite(x.price) && x.price > 0).map(x => candles.createPriceLine({ price: x.price, color: x.color, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: x.title }));
    },
    focusTime(t, sec) {
      const i = data.findIndex(b => b.time + sec > t);
      if (i < 0) return;
      const half = el.clientWidth < 600 ? 30 : 60;
      chart.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
    },
  };
}
