// 图表封装（TradingView lightweight-charts v4，vendor/ 本地文件，无需 CDN）
import { CONFIG } from './config.js';
import { price, dt, hm, md, tz, alpha } from './fmt.js';

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
  const pf = { type: 'custom', formatter: v => '$' + v.toFixed(2), minMove: 0.01 };
  const baseSer = chart.addLineSeries({ color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false, priceFormat: pf });
  let baseLine = null;
  const api = {
    chart,
    setData(strategies, hidden) {
      for (const [id, s] of series) if (!strategies.find(x => x.id === id)) { chart.removeSeries(s.main); chart.removeSeries(s.bf); series.delete(id); }
      for (const s of strategies) {
        let ser = series.get(s.id);
        if (!ser) {
          ser = { bf: chart.addLineSeries({ lineWidth: 2, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf }),
                  main: chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: pf, title: '' }) };
          series.set(s.id, ser);
        }
        const pts = clean(s.equity_curve, ['value']);
        const lastBf = pts.reduce((r, p, i) => p.backfilled ? i : r, -1);
        // 回补段：从开头到最后一个回补点，再连到第一个正常点，两段首尾相接
        const bf = lastBf >= 0 ? pts.slice(0, Math.min(pts.length, lastBf + 2)) : [];
        const main = pts.filter(p => !p.backfilled);
        ser.bf.setData(bf.map(({ time, value }) => ({ time, value })));
        ser.main.setData(main.map(({ time, value }) => ({ time, value })));
        const vis = !hidden.has(s.id);
        ser.main.applyOptions({ visible: vis, color: s.color, lineStyle: s.dashed ? 2 : 0, title: s.role === 'control' ? '对照' : '' });  // 虚线；对照组在价格轴标签上写“对照”
        ser.bf.applyOptions({ visible: vis, color: alpha(s.color, 0.5), lineStyle: 1 });
      }
      // 起始资金基准线：取第一个有效的起始资金，横跨全部时间
      // 只看正式策略：对照组（S0）有自己的资金，不作为基准
      const start = strategies.filter(s => s.role !== 'control').map(s => s.start).find(v => Number.isFinite(v) && v > 0);
      const times = strategies.flatMap(s => s.equity_curve.map(p => p.time)).filter(Number.isFinite);
      if (start != null && times.length) {
        const t0 = Math.min(...times), t1 = Math.max(...times);
        baseSer.setData(t0 === t1 ? [{ time: t0, value: start }] : [{ time: t0, value: start }, { time: t1, value: start }]);
        if (!baseLine) baseLine = baseSer.createPriceLine({ price: start, color: '#475569', lineStyle: 1, lineWidth: 1, axisLabelVisible: true, title: '起始' });
        else baseLine.applyOptions({ price: start });
      } else { baseSer.setData([]); if (baseLine) { baseSer.removePriceLine(baseLine); baseLine = null; } }
    },
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
  const pf = { type: 'custom', formatter: price, minMove: 1e-12 };
  const candles = chart.addCandlestickSeries({ priceFormat: pf, borderVisible: false });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  let lines = [], data = [], colors = { up: '#22c55e', dn: '#ef4444' };
  chart.subscribeCrosshairMove(p => {
    const c = p?.time != null ? p.seriesData.get(candles) : null;
    const v = p?.time != null ? p.seriesData.get(volume) : null;
    onCrosshair(c ? { ...c, volume: v?.value } : (data.length ? data[data.length - 1] : null));
  });
  return {
    chart,
    setColors(c) {
      colors = c;
      candles.applyOptions({ upColor: c.up, downColor: c.dn, wickUpColor: c.up, wickDownColor: c.dn });
    },
    setData(bars, { keepRange } = {}) {
      bars = clean(bars, ['open', 'high', 'low', 'close']);
      data = bars;
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
