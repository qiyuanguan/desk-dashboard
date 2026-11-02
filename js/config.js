// 仪表盘配置：数据地址、刷新频率、颜色、文案。改这里即可，不用动渲染代码。
export const CONFIG = {
  // 数据文件（相对 index.html）。后端导出的真实 data.json 放同一目录覆盖即可。
  DATA_URL: 'data.json',
  REFRESH_MS: 60_000,
  TIMEZONE: 'America/Los_Angeles',
  TZ_LABEL: 'PST',          // 仅作兜底；实际按日期自动显示 PST / PDT（见 fmt.js tz()）
  // data.json 的 generated_at 超过这么多分钟没更新 → 顶部标红“数据已过期”。
  // 导出建议每 5 分钟跑一次，默认 15 分钟（容忍漏 2 轮）；运维要更严可改成 10。上线说明见 RELEASE.md
  STALE_MIN: 15,
  PAGE_SIZE: 20,
  INTERVALS: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 },
  DEFAULT_INTERVAL: '5m',
  // 策略配色：避开纯红/纯绿，免得和涨跌色混淆
  STRATEGY_COLORS: ['#60a5fa', '#c084fc', '#fbbf24', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#94a3b8'],
  COLOR_MODES: {
    greenUp: { label: '绿涨红跌', up: '#22c55e', dn: '#ef4444' }, // 与现有仪表盘一致（默认）
    redUp:   { label: '红涨绿跌', up: '#ef4444', dn: '#22c55e' }, // A 股习惯
  },
};

// 原因代码 → 中文。代码来源：/workspace/desk 的 verify / grok / book / exits / scan / tasks（只读核对过）+ 策略交付文档。
// 先查精确表 REASONS，再按 REASON_RULES 的前缀/正则翻译，都不认识的显示“其他原因（原代码）”（见 fmt.js reason()）。
export const REASONS = {
  // 线索来源 / 扫描
  // 热修新增（测试员 BUG-H06）
  graduated:'已毕业（离开绑定曲线）', recheck:'重判', price_feed:'取价', hold:'取价失败，继续持有', recovered:'池子恢复',
  summary:'本轮扫描汇总', lead:'线索入队', ok:'正常', grok_cap:'当日 Grok 额度已用完', bad_json:'Grok 回答 JSON 格式错误', non_json:'Grok 返回的不是 JSON',
  paper_fill:'纸面成交', approval:'待人工批准', go:'放行', skip:'跳过', s0_skip:'S0 跳过', s0_error:'S0 出错（不影响正式策略）', error:'出错',
  dexscreener_new:'新币', aged_liquid:'老币有流动性', watchlist:'自选观察', bonding_curve:'还在 pump.fun 绑定曲线上（未毕业）',
  no_leads:'没有新线索', dexscreener_empty_or_unavailable:'DexScreener 没返回数据或暂时不可用', dexscreener_unavailable:'DexScreener 暂时不可用',
  time_budget:'本轮扫描超时，剩下的下轮再看', lock_busy:'上一轮还没跑完，本轮跳过',
  // 验证（verify hard_skip）
  thin_pool:'池子太浅', rugged:'跑路盘', authority_open:'权限未放弃（可增发/冻结）', lp_unlocked:'LP 未锁', dev_holds:'开发者持仓过高',
  dev_heavy:'开发者持仓过高', top10_heavy:'前十持仓过重', risk_score:'风险分过高', too_fresh:'太新', too_young:'太新', too_old:'太老',
  nobody_can_sell:'一小时零卖出（疑似蜜罐）',
  // Grok / X 舆情
  x_read:'X 舆情不通过', low_confidence:'X 置信度不足', x_not_go:'X 舆情未放行', grok_cap_hit:'当日 Grok 额度已用完',
  missing_xai_key:'没配置 Grok 密钥', xai_429:'Grok 限流（429）', xai_timeout:'Grok 超时', xai_non_json_body:'Grok 返回的不是 JSON',
  non_json_answer:'Grok 回答格式异常', bad_json_shape:'Grok 回答字段不对',
  // 下单 / 账本
  already_open:'已持仓', max_open:'持仓数已满', session_loss_halt:'会话熔断', cash_below_min_ticket:'现金不足最小单',
  entry:'买入（入场）', manual:'手动登记', exit:'离场', assumed_pass:'默认放行', ma_cross_up:'均线上穿', ma_cross_down:'均线下穿',
  // 离场
  hard_stop:'硬止损（跌到止损线）', trail:'移动止损', trailing_stop:'移动止损（从峰值回落）', time_stop:'时间止损（持仓到时仍没涨）', ladder:'阶梯止盈', liq_drop:'流动性骤降',
  pool_gone:'池子没了，按 0 清算', pool_missing:'价格源找不到池子（撤池观察）', liquidity_pulled:'流动性被撤',
  // S0 对照组（code/s0/，2026-11-02）
  s0_already_open:'S0 已持有这个币', s0_formal_holds:'正式策略已持有这个币', s0_max_open:'S0 持仓数已满', s0_cash_below_ticket:'S0 现金不够一笔 $5',
  s0_stop_loss:'S0 止损（−15%）', s0_max_hold:'S0 持有满 40 分钟强平',
  // 01-策略设计-交付.md 第 8 节接口里的离场代码
  tp1:'第一档止盈', tp2:'第二档止盈', time:'超时离场', liq_pulled:'流动性被抽走', breakout_fail:'突破失败', breaker:'熔断',
};
// missing_data:<字段> 里的字段名
export const FIELD_CN = {
  liq_usd:'流动性', price:'价格', bonding_curve:'绑定曲线', dex_status:'DEX 状态', lp_locked_pct:'LP 锁仓比例', top10_pct:'前十持仓占比',
  holders:'持币地址数', fdv:'市值', mcap:'市值', volume_h1:'1 小时成交量', txns_h1:'1 小时交易笔数', age_min:'上线时长', risk_score:'风险分',
  creator_pct:'开发者持仓', pair_created_at:'创建时间', sells_h1:'1 小时卖出笔数',
};
// Rugcheck danger:<名字>
export const DANGER_CN = {
  'Low Liquidity':'流动性低', 'Mutable metadata':'元数据可修改', 'Freeze Authority still enabled':'冻结权限未放弃',
  'Mint Authority still enabled':'增发权限未放弃', 'Single holder ownership':'单一地址持仓过高', 'High holder concentration':'持仓过于集中',
  'Top 10 holders high ownership':'前十持仓过高', 'Large Amount of LP Unlocked':'大量 LP 未锁', 'Low amount of LP Providers':'LP 提供者太少',
  'Copycat token':'仿冒币', 'Creator history of rugged tokens':'创建者有跑路前科', 'Rugged':'已跑路',
};
// 前缀/正则规则：[正则, 翻译函数]。fmt.reason() 依次尝试，命中第一个为止。
export const REASON_RULES = [
  [/^pairs_empty_or_no_liquidity\s+(\d+)\/(\d+)$/, m => `价格源查不到池子或没流动性（连续第 ${m[1]}/${m[2]} 次）`],
  // v0.4 文档 6b：take_profit_40 = 第 1 档，take_profit_100 = 第 2 档；N 跟着 config.EXIT ladder 变
  [/^take_profit_(\d+)$/, m => ({ 40: '第 1 档止盈（+40%）', 100: '第 2 档止盈（+100%）' })[m[1]] || `止盈 +${m[1]}%`],
  [/^all_(\d+)_already_judged_or_not_due$/, m => `本轮 ${m[1]} 个线索都已判过或还没到重判时间`],
  [/^\s*[{\[]/, () => '扫描汇总（原始 JSON，后端已截断，详见日志）'],
  [/^x_read:\s*(.*)$/s, m => 'X 舆情不通过' + (m[1] ? '：' + m[1] : '')],
  [/^xai_http_(\d+)$/, m => `Grok 接口出错（HTTP ${m[1]}）`],
  [/^xai_network:\s*(.*)$/s, m => 'Grok 网络错误' + (m[1] ? '：' + m[1] : '')],
  [/^xai_(.+)$/, m => `Grok 调用失败（${m[1]}）`],
  [/^missing_data:\s*(.+)$/, m => '缺数据：' + (FIELD_CN[m[1]] || m[1])],
  [/^danger:\s*(.+)$/, m => 'Rugcheck 风险：' + (DANGER_CN[m[1]] || m[1])],
  [/^error:\s*(.*)$/s, m => '出错' + (m[1] ? '：' + m[1] : '')],
  [/^limits:\s*(.+)$/, (m, tr) => '限额：' + tr(m[1])],
  [/^all_(\d+)_already_judged$/, m => `${m[1]} 个线索都已判断过`],
  [/^pool_missing[:_]?\s*(.*)$/s, m => '价格源找不到池子（撤池观察）' + (m[1] ? '：' + m[1] : '')],
  [/^gt_(.+)$/, m => `GeckoTerminal 线索（${m[1]}）`],
  [/^dexscreener_(.+)$/, m => `DexScreener：${m[1]}`],
];
// 显示原因时用的“未知代码”兜底文字
export const REASON_UNKNOWN = code => `其他原因（${code}）`;

// 入场原因形如 "S2:donchian12_vol2.3x"：按片段翻译，翻不了的保持原样
export const ENTRY_PARTS = [
  [/^donchian(\d+)$/, (m) => `突破前 ${m[1]} 根高点`],
  [/^vol([\d.]+)x$/, (m) => `放量 ${m[1]} 倍`],
  [/^grad(\d+)m$/, (m) => `毕业 ${m[1]} 分钟`],
  [/^buyers([\d.]+)x$/, (m) => `买/卖地址 ${m[1]} 倍`],
  [/^pullback(\d+)$/, (m) => `回撤 ${m[1]}%`],
  [/^rsi(\d+)$/, (m) => `RSI ${m[1]}`],
  [/^xGO$/, () => 'X 舆情放行'],
];

// 策略外观与说明（按 任务/01-策略设计-交付.md）。key = 策略 id，data.json 里同名字段（color/desc）优先。
// short 用在 K 线买卖点标记上；dashed=权益曲线用虚线（对照组）。
export const STRATEGY_META = {
  desk_v1:        { short: '原版', color: '#94a3b8',
                    tag: '现网 · 新币 + X 舆情 · ≤45 分钟',
                    desc: '现在 /workspace/desk 在跑的逻辑原样包装：DexScreener 新币 + X 舆情过滤。正式策略。' },
  // 对照组（2026-11-02 Bill 批准）：识别规则在 js/data.js 的 CONTROL
  S0:             { short: 'S0', color: '#f472b6', dashed: true, name: 'S0 对照组',
                    tag: '对照组 · Grok 判 SKIP 的币 · $5 纸面 · 单独记账',
                    desc: '正式流程里过了全部硬性检查、但 Grok 读 X 判 SKIP 的币，每笔 $5 纸面买入，独立 $50 虚拟资金；止盈同正式策略，另加 −15% 止损和 40 分钟强平。用来检验 X 舆情过滤有没有用。不计入正式策略合计。' },
  s1_graduation:  { short: 'S1', color: '#f59e0b',
                    tag: '事件驱动 · 1m · 持仓 5–30 分钟',
                    desc: '只做刚从 pump.fun 毕业的币，毕业后 5–30 分钟买家还在进场时追入；单笔 $8，止损 −15%，+30%/+70% 分批止盈，最长 40 分钟。成本按 3%/边。' },
  s2_momentum:    { short: 'S2', color: '#3b82f6',
                    tag: '趋势跟随 · 5m · 持仓 15–90 分钟',
                    desc: '热榜币 5m 收盘突破前 12 根高点且放量 ≥2 倍时追入；单笔 $10，+25%/+60% 分批止盈，回落 20% 移动止损，最长 6 小时。' },
  s2x_momentum_x: { short: 'S2x', color: '#93c5fd', dashed: true,
                    tag: 'S2 + 必须 X 舆情 GO · 单独记账',
                    desc: '和 S2 同一个信号，但还要 X 舆情给 GO 才买；单独记账，用来检验 X 读取到底有没有用。' },
  s3_pullback:    { short: 'S3', color: '#c084fc',
                    tag: '均值回归 · 15m/1h · 持仓 1–6 小时',
                    desc: '已经涨过一轮的强势币，从 24h 高点回撤 25–45%、15m RSI 超卖后出现确认阳线时买入；单笔 $12，+15% 卖一半，最长 6 小时。' },
};
export const STAGES = { scan: '扫描', verify: '验证', execute: '执行', exit: '离场' };
// 汇总行/全局行和 S0 的 action（热修 02a / code/s0）；不进“阶段”筛选，只用来显示
export const STAGES_EXTRA = { scan_summary: '扫描汇总', limits: '全局限额', price_feed: '取价', exit_check: '离场检查',
  s0_limits: 'S0 限额', s0_execute: 'S0 执行', s0_price_feed: 'S0 取价', s0_error: 'S0 出错' };
// scan_summary JSON 的字段（code/hotfix/desk/scan.py 末尾）
export const SUMMARY_FIELDS = [['raw', '线索'], ['queued', '入队'], ['verified', '验证'], ['fills', '成交'], ['gt_ok', 'GT 通过'],
  ['watch', '观察名单'], ['watch_added', '新入名单'], ['graduated', '毕业'], ['recheck', '重判'], ['not_due', '未到重判'],
  ['grok_calls', 'Grok 本轮'], ['grok_today', 'Grok 今天'], ['secs', '用时（秒）'], ['dex_checked', 'Dex 查过']];
// v0.5 events 的 queued 是按来源分的对象 {gt_trending_5m: 3, dexscreener_new: 22, …}
export const QUEUE_SRC = { gt_trending_5m: 'GT 5 分钟热门', gt_trending_1h: 'GT 1 小时热门', gt_trending_6h: 'GT 6 小时热门',
  gt_new_pools: 'GT 新池', dexscreener_new: 'Dex 新币', aged_liquid: '老币有流动性', graduated: '刚毕业', recheck: '重判' };
export const TOKEN_STATUS = { position: '持仓', candidate: '候选', closed: '已平仓' };
