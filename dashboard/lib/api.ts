import type {
  WatchlistItem, Position, Trade, Order, AccountInfo,
  StrategyInfo, BacktestRequest, BacktestResult, Bar, Quote,
} from "@/types";

// Default to same-origin so the Next.js rewrite proxies everything through
// port 3000. Override with NEXT_PUBLIC_API_URL only for direct-CORS setups.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE", cache: "no-store" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  health: () => get<{ status: string; ib_connected: boolean; mode: string; mock_mode: boolean }>("/health"),
  account: () => get<AccountInfo>("/api/account"),

  // market
  bars: (symbol: string, timeframe = "15m", days = 30) =>
    get<{ symbol: string; timeframe: string; bars: Bar[]; source: string }>(
      `/api/market/bars/${symbol}?timeframe=${timeframe}&days=${days}`
    ),
  quote: (symbol: string) => get<Quote>(`/api/market/quote/${symbol}`),
  quotes: (symbols: string[]) =>
    get<Quote[]>(`/api/market/quotes?symbols=${symbols.join(",")}`),
  symbols: () => get<{ symbol: string; name: string; sector: string }[]>("/api/market/symbols"),
  sectors: () => get<Record<string, { symbol: string; name: string }[]>>("/api/market/sectors"),
  indicators: (symbol: string, timeframe = "15m", days = 30) =>
    get<{
      symbol: string;
      timeframe: string;
      smi: { time: number; value: number }[];
      smi_signal: { time: number; value: number }[];
      ema_fast: { time: number; value: number }[];
      ema_slow: { time: number; value: number }[];
      rsi?: { time: number; value: number }[];
      macd?: { time: number; value: number }[];
      macd_signal?: { time: number; value: number }[];
      macd_hist?: { time: number; value: number }[];
      vwap?: { time: number; value: number }[];
    }>(`/api/market/indicators/${symbol}?timeframe=${timeframe}&days=${days}`),

  // watchlist
  watchlist: () => get<WatchlistItem[]>("/api/watchlist"),
  watchlistAdd: (symbol: string, sector?: string) =>
    post<WatchlistItem>("/api/watchlist", { symbol, sector }),
  watchlistRemove: (symbol: string) => del<{ removed: string }>(`/api/watchlist/${symbol}`),

  // positions / orders / trades / spreads
  positions: () => get<Position[]>("/api/positions"),
  orders: () => get<Order[]>("/api/orders"),
  trades: () => get<Trade[]>("/api/trades"),
  spreads: () => get<Spread[]>("/api/spreads"),
  strategySnapshot: (id: string) => get<StrategySnapshot>(`/api/strategies/${id}/snapshot`),

  // strategies
  strategies: () => get<StrategyInfo[]>("/api/strategies"),
  strategyStart: (id: string, symbols: string[], timeframe: string, params = {}) =>
    post<StrategyInfo>(`/api/strategies/${id}/start`, { symbols, timeframe, params }),
  strategyStop: (id: string) =>
    post<StrategyInfo>(`/api/strategies/${id}/stop`, {}),
  strategySchema: (id: string) => get<StrategySchema>(`/api/strategies/${id}/schema`),

  // backtest
  runBacktest: (req: BacktestRequest) => post<BacktestResult>("/api/backtest/run", req),
  backtestResults: () => get<BacktestResult[]>("/api/backtest/results"),
  backtestResult: (id: string) => get<BacktestResult>(`/api/backtest/results/${id}`),

  // market microstructure: depth (Level 2), tape (T&S), volume profile
  depthSnapshot: (symbol: string, rows = 10) =>
    get<DepthSnapshot>(`/api/depth/${symbol}?rows=${rows}`),
  recentPrints: (symbol: string, n = 100) =>
    get<TapeSnapshot>(`/api/ticks/${symbol}?n=${n}`),
  volumeProfile: (symbol: string, timeframe = "15m", days = 20, bins = 40) =>
    get<VolumeProfile>(
      `/api/market/volume-profile/${symbol}?timeframe=${timeframe}&days=${days}&bins=${bins}`
    ),

  // options — IBKR is the sole chain source
  optionsChain: (symbol: string, expiration?: string) => {
    const params = new URLSearchParams();
    if (expiration) params.set("expiration", expiration);
    const q = params.toString() ? `?${params.toString()}` : "";
    return get<OptionsChain>(`/api/options/chain/${symbol}${q}`);
  },
  spreadScan: (symbol = "RUT", side: "put" | "call" | "both" = "put", tradeTypes?: string[], maxPerType = 5) => {
    const params = new URLSearchParams({ symbol, side, max_per_type: String(maxPerType) });
    (tradeTypes || []).forEach(t => params.append("trade_types", t));
    return get<SpreadScanResult>(`/api/options/spreads/scan?${params.toString()}`);
  },
  spreadSpecs: () => get<Record<string, SpreadSpec>>("/api/options/spreads/specs"),

  // Rule One monthly cycle: dates + best candidate per applicable strategy.
  ruleoneCycle: (symbol: string) =>
    get<RuleOneCycle>(`/api/ruleone/cycle?symbol=${encodeURIComponent(symbol)}`),

  // Historical short-strike picks (one per past 3rd-Friday × strategy).
  ruleoneHistory: (symbol: string, limit = 12) =>
    get<RuleOneHistory>(
      `/api/ruleone/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
    ),

  // single-option position analyzer
  analyzeOption: (params: {
    symbol: string;
    strike: number;
    expiry: string;
    right: "C" | "P";
    quantity?: number;
    entry_price?: number;
    timeframe?: OptionAnalyzerTimeframe;
  }) => {
    const q = new URLSearchParams({
      strike: String(params.strike),
      expiry: params.expiry,
      right: params.right,
      quantity: String(params.quantity ?? 1),
    });
    if (params.entry_price != null) q.set("entry_price", String(params.entry_price));
    if (params.timeframe) q.set("timeframe", params.timeframe);
    return get<OptionAnalyzeResult>(`/api/options/analyze/${params.symbol}?${q.toString()}`);
  },

  // Lightweight LLM read of the analyze payload — single OpenRouter call,
  // returns four short analyst paragraphs (underlying / option / position /
  // risk). 5-minute server-side cache per contract so repeat clicks don't
  // re-spend tokens.
  llmRead: (body: LlmReadRequest) =>
    post<LlmReadResponse>("/api/options/llm-read", body),

  // analyzer
  analyze: (symbol: string, timeframe = "1d", days = 60) =>
    get<AnalyzeResult>(`/api/analyze/${symbol}?timeframe=${timeframe}&days=${days}`),

  // fundamentals — IBKR-only build returns empty stubs; UI should handle null fields
  fundamentals: (symbol: string) => get<Fundamentals>(`/api/fundamentals/${symbol}`),
  fundamentalsBulk: (symbols: string[]) =>
    get<Fundamentals[]>(`/api/fundamentals?symbols=${symbols.join(",")}`),

  // OKW trade tracker
  okwTrades: (params: { status?: string; trade_type?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.trade_type) q.set("trade_type", params.trade_type);
    if (params.limit) q.set("limit", String(params.limit));
    const s = q.toString();
    return get<{ trades: OkwTrade[] }>(`/api/okw/trades${s ? "?" + s : ""}`);
  },
  okwCreate: (trade: OkwTradeCreate) => post<OkwTrade>("/api/okw/trades", trade),
  okwClose: (id: number, payload: { exit_reason: string; realized_pnl?: number | null }) =>
    post<OkwTrade>(`/api/okw/trades/${id}/close`, payload),
  okwDelete: (id: number) => del<{ ok: boolean }>(`/api/okw/trades/${id}`),
  okwSummary: () => get<OkwSummary>("/api/okw/summary"),

  // scan history
  scansLatest: (symbol?: string) => {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return get<ScanRecord>(`/api/scans/latest${q}`);
  },
  scansHistory: (params: { limit?: number; symbol?: string; trade_type?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.symbol) q.set("symbol", params.symbol);
    if (params.trade_type) q.set("trade_type", params.trade_type);
    const s = q.toString();
    return get<{ scans: ScanRecord[]; count: number }>(`/api/scans/history${s ? "?" + s : ""}`);
  },

  // exit monitor + monthly pre-flight
  monitorState: () => get<MonitorSnapshot>("/api/monitor/state"),
  monitorRefresh: () => post<MonitorSnapshot>("/api/monitor/refresh", {}),
  preflightState: () => get<PreflightSnapshot>("/api/monitor/preflight"),
  preflightRun: () => post<PreflightSnapshot>("/api/monitor/preflight/run", {}),
  scheduledJobs: () => get<{ jobs: ScheduledJob[] }>("/api/monitor/jobs"),

  // multi-agent debate (TradingAgents)
  agentsStatus: () => get<{ installed: boolean; has_openai_key: boolean; has_anthropic_key: boolean; has_google_key: boolean }>("/api/agents/status"),
  agentsAnalyze: (symbol: string, trade_date?: string) =>
    post<{ cached: boolean; symbol: string; trade_date: string; decision: string; final_state: Record<string, string> }>(
      "/api/agents/analyze", { symbol, trade_date }
    ),

};

export interface OkwTrade {
  id: number;
  placed_at: string;
  closed_at?: string | null;
  symbol: string;
  trade_type: string;
  side: "put" | "call";
  expiry: string;
  dte: number;
  short_strike: number;
  long_strike: number;
  width: number;
  contracts: number;
  credit: number;
  spot_at_open?: number | null;
  short_delta?: number | null;
  aroc_pct?: number | null;
  kelly_pct?: number | null;
  adj_distance_pct?: number | null;
  fib_floor1?: number | null;
  fib_floor2?: number | null;
  status: "open" | "closed" | "expired";
  exit_reason?: string | null;
  realized_pnl?: number | null;
  notes?: string | null;
}

export interface OkwTradeCreate {
  symbol: string;
  trade_type: string;
  side?: "put" | "call";
  expiry: string;
  dte: number;
  short_strike: number;
  long_strike: number;
  contracts?: number;
  credit: number;
  spot_at_open?: number | null;
  short_delta?: number | null;
  aroc_pct?: number | null;
  kelly_pct?: number | null;
  adj_distance_pct?: number | null;
  fib_floor1?: number | null;
  fib_floor2?: number | null;
  notes?: string | null;
}

export interface OkwSummary {
  total: number;
  open: number;
  closed: number;
  expired: number;
  wins: number;
  losses: number;
  realized_pnl: number;
}

export interface ScanRecord {
  id: number | null;
  ran_at: string | null;
  scope?: string;
  symbol?: string;
  recommendation?: string | null;
  payload: SpreadScanResult | null;
}

export interface MonitorEntry {
  spread_id: string;
  symbol: string;
  expiry: string;
  spread_type: string;
  short_strike: number;
  long_strike: number;
  quantity: number;
  exit_delta: number;
  current_delta: number | null;
  headroom: number | null;
  status: "safe" | "warning" | "trigger" | "unknown";
  updated_at: string;
  note?: string | null;
}

export interface MonitorSnapshot {
  entries: MonitorEntry[];
  last_run: string | null;
  last_error: string | null;
  running: boolean;
  count: number;
  triggered: number;
  warning: number;
}

export interface PreflightSnapshot {
  ran_at: string | null;
  scope?: "scheduled" | "manual";
  scan: SpreadScanResult | null;
  note?: string | null;
  error?: string | null;
}

export interface ScheduledJob {
  id: string;
  next_run_time: string | null;
  trigger: string;
}

export interface SpreadSpec {
  name: string;
  underlying: string;
  max_delta: number;
  min_adj_distance_pct: number;
  target_aroc_pct: number;
  min_kelly_pct: number;
  delta_exit: number;
  floor_required: boolean;
  description: string;
}

export interface SpreadCandidate {
  trade_type: string;
  side: "put" | "call";
  symbol: string;
  expiry: string;
  dte: number;
  short_strike: number;
  long_strike: number;
  short_delta: number;
  short_iv: number | null;
  credit: number;
  max_risk: number;
  wing_width: number;
  distance_pct: number;
  adj_distance_pct: number;
  aroc_pct: number;
  win_prob_pct: number;
  kelly_pct: number;
  underlying_price: number;
  passes: Record<string, boolean>;
}

export interface SpreadScanResult {
  symbol: string;
  underlying_price?: number;
  underlyings_scanned?: string[];
  underlying_prices?: Record<string, number | null>;
  expirations_scanned?: string[] | Record<string, string[]>;
  as_of?: string;
  error?: string;
  errors?: Record<string, string> | null;
  trade_types: Record<string, SpreadCandidate[]>;
  top_picks?: Record<string, SpreadCandidate | null>;
  recommendation?: {
    trade_type: string;
    candidate: SpreadCandidate;
    reason: string;
  } | null;
}

// Rule One monthly cycle: a single bull-put trade running ~25 DTE → 3rd
// Friday expiry. The dashboard surfaces today's status, the entry-day
// target, and the best candidate per applicable strategy.
export interface RuleOneCandidate {
  strategy_id: "rut" | "mars" | "marsmax" | "space";
  short_strike: number | null;
  long_strike: number | null;
  side: "put" | "call";
  credit: number | null;
  short_delta: number | null;
  aroc_pct: number | null;
  kelly_pct: number | null;
  adj_distance_pct: number | null;
  dte: number | null;
  passes: boolean;
  fail_reasons: string[];
}

export interface RuleOneCycle {
  symbol: string;
  underlying: "RUT" | "SPX" | null;
  cycle_label: string | null;        // e.g. "JUN '26"
  today: string;                     // YYYY-MM-DD
  entry_date: string | null;         // YYYY-MM-DD
  expiry_date: string | null;        // YYYY-MM-DD
  days_to_entry: number | null;
  days_to_expiry: number | null;
  refreshed_at: string;              // ISO
  candidates: RuleOneCandidate[];
  scanner_error: string | null;
  reason?: string;
}

export interface RuleOneHistoryCycle {
  expiry: string;          // YYYYMMDD
  strategy_id: "rut" | "mars" | "marsmax" | "space";
  short_strike: number;
  side: "put" | "call";
  ran_at: string;          // ISO timestamp of the scan that picked it
  dte_at_scan: number | null;
}

export interface RuleOneHistory {
  symbol: string;
  underlying: "RUT" | "SPX" | null;
  cycles: RuleOneHistoryCycle[];
}

export interface Fundamentals {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  country?: string;
  currency?: string;
  price?: number;
  market_cap?: number;
  market_cap_tier?: "mega" | "large" | "mid" | "small" | "micro";
  pe_trailing?: number;
  pe_forward?: number;
  eps_trailing?: number;
  dividend_yield?: number;
  beta?: number;
  profit_margin?: number;
  operating_margin?: number;
  roe?: number;
  revenue_growth?: number;
  earnings_growth?: number;
  debt_to_equity?: number;
  fifty_two_week_high?: number;
  fifty_two_week_low?: number;
  fifty_two_week_position?: number; // 0..1
  avg_volume?: number;
  shares_short?: number;
  short_ratio?: number;
  exchange?: string;
}

export interface AnalyzeSignal {
  name: string;
  score: number;
  detail: string;
}

export interface AnalyzeResult {
  symbol: string;
  timeframe: string;
  source?: string;
  as_of?: number;
  error?: string;
  price?: number;
  change_pct?: number;
  technicals?: {
    smi: number;
    smi_signal: number;
    rsi: number;
    macd: number;
    macd_signal: number;
    macd_hist: number;
    ema_fast: number;
    ema_slow: number;
    ema_200: number | null;
    vwap: number | null;
  };
  spread?: {
    id: string;
    spread_type: string;
    expiry: string;
    dte: number | null;
    short_strike: number;
    long_strike: number;
    credit_received: number;
    quantity: number;
    max_profit: number;
    max_loss: number;
    spot_to_short_pct: number | null;
  } | null;
  position?: {
    quantity: number;
    avg_price: number;
    current_price: number;
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    side: string;
  } | null;
  forecast?: {
    horizon: number;
    context_len: number;
    last_close: number;
    median: number[];
    p10: number[];
    p90: number[];
    expected_return_pct: number;
    band_pct: number;
  } | null;
  signals: AnalyzeSignal[];
  verdict: { score: number; label: string; reasons: string[] };
}

export interface OptionRow {
  strike: number;
  expiry: string;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  oi: number | null;
  vol: number | null;
}

export interface SpreadLeg {
  strike: number;
  right: "C" | "P";
  action: "BUY" | "SELL";
  con_id: number;
}

export interface Spread {
  id: string;
  symbol: string;
  expiry: string;
  spread_type: string;
  legs: SpreadLeg[];
  quantity: number;
  credit_received: number;
  opened_at: string;
  underlying_at_open: number;
  status: "open" | "closing" | "closed";
  short_strike: number;
  long_strike: number;
  width: number;
  max_loss: number;
  max_profit: number;
}

export interface StrategySnapshot {
  id: string;
  running: boolean;
  config: Record<string, unknown>;
  stats: {
    entries: number;
    exits_target: number;
    exits_stop: number;
    exits_time: number;
    realized_pnl: number;
    last_scan: string | null;
    last_error: string | null;
  };
  open_spreads: Spread[];
}

export interface StrategySchema {
  type?: string;
  properties?: Record<string, any>;
  defaults?: Record<string, unknown>;
  required?: string[];
  $defs?: Record<string, any>;
}

export interface OptionsChain {
  symbol: string;
  underlying_price: number | null;
  expirations: string[];
  strikes: number[];
  calls: OptionRow[];
  puts: OptionRow[];
}

// ---- market microstructure types --------------------------------------------

export interface DepthLevel {
  price: number;
  size: number;
  mm: string;
}

export interface DepthSnapshot {
  symbol: string;
  ts: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  bid_size_total: number;
  ask_size_total: number;
  imbalance: number | null;  // (bid - ask) / (bid + ask), in [-1, 1]
  available: boolean;
}

export interface TapePrint {
  ts: number;
  price: number;
  size: number;
  side: "buy" | "sell" | "mid";
  bid: number | null;
  ask: number | null;
  cond: string[];
}

export interface TapeSnapshot {
  symbol: string;
  prints: TapePrint[];
  available: boolean;
}

export interface VolumeProfileBin {
  price_low: number;
  price_high: number;
  price_mid: number;
  volume: number;
}

export interface VolumeProfile {
  symbol: string;
  timeframe: string;
  days: number;
  bins: VolumeProfileBin[];
  poc: number | null;
  value_area_low: number | null;
  value_area_high: number | null;
  total_volume: number;
}

export type OptionAnalyzerTimeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export interface ForecastHorizon {
  horizon: number;
  median: number[];
  p10: number[];
  p90: number[];
  expected_return_pct: number;
  band_pct: number;
  members_used?: string[];
}

export interface MultiTfSnapshot {
  available: boolean;
  spot?: number;
  rsi?: number | null;
  macd_hist?: number | null;
  macd_hist_prev?: number | null;
  smi?: number | null;
  smi_signal?: number | null;
  vwap?: number | null;
  vwap_diff_pct?: number | null;
  ema9?: number | null;
  ema21?: number | null;
  trend?: "bull" | "bear" | "neutral";
}

export interface LlmReadRequest {
  symbol: string;
  strike: number;
  expiry: string;
  right: string;
  quantity: number;
  is_long: boolean;
  dte: number;
  spot: number;
  breakeven: number;
  distance_pct: number;
  iv: number;
  mid?: number | null;
  entry_price: number;
  rsi?: number | null;
  macd_hist?: number | null;
  trend_score?: number | null;
  ema9?: number | null;
  ema21?: number | null;
  ema200?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rv30?: number | null;
  iv_to_rv_ratio?: number | null;
  spread_pct?: number | null;
  liquidity_grade?: string | null;
  pop?: number | null;
  prob_itm?: number | null;
  forecast_5d_return_pct?: number | null;
  forecast_5d_band_pct?: number | null;
  forecast_agreement?: number | null;
  advice_label?: string | null;
  advice_score?: number | null;
  advice_notes?: string[];
}

export interface LlmReadResponse {
  underlying: string;
  option: string;
  position: string;
  risk: string;
  model: string;
  cached: boolean;
}

export interface OptionAnalyzeResult {
  symbol: string;
  strike: number;
  expiry: string;
  right: "C" | "P";
  side: "call" | "put";
  quantity: number;
  is_long: boolean;
  dte: number;
  spot: number;
  distance_pct: number;
  underlying: {
    ema9: number | null;
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
    rsi: number;
    macd_hist: number;
    trend_score: number;
    history: { time: number; close: number }[];
    ema9_history: number[];
    ema21_history: number[];
  };
  option: {
    bid: number | null;
    ask: number | null;
    last: number | null;
    mid: number | null;
    iv: number;
    entry_price: number;
    synthetic_history: number[];
    synthetic_ema9: number[];
    synthetic_ema21: number[];
  };
  greeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
  };
  pnl_profile: {
    prices: number[];
    expiry: number[];
    today: number[];
    halfway: number[];
  };
  breakeven: number;
  max_profit: number | null;
  max_loss: number | null;
  advice: {
    score: number;
    label: string;
    notes: string[];
  };
  tradingagents_enabled: boolean;

  // ---- analytics block ----
  decay_profile: { days_remaining: number; pnl_flat: number; pnl_up_1s: number; pnl_dn_1s: number }[];
  sigma_ranges: {
    sigma1_low: number | null;
    sigma1_high: number | null;
    sigma2_low: number | null;
    sigma2_high: number | null;
    expected_move_abs: number | null;
    expected_move_pct: number | null;
  };
  probability: {
    pop: number | null;        // probability of profit at expiry
    prob_itm: number | null;   // probability of expiring ITM
    prob_touch: number | null; // probability of touching breakeven before expiry
  };
  liquidity: {
    bid: number | null;
    ask: number | null;
    last: number | null;
    spread: number | null;
    spread_pct: number | null;
    grade: "tight" | "normal" | "wide" | "poor";
    volume: number | null;
    open_interest: number | null;
  };
  vol_context: {
    realized_vol_30d: number | null;
    realized_vol_90d: number | null;
    iv_to_rv_ratio: number | null;
  };
  narrative: string;

  // ---- chart block (drives the underlying analysis card) ----
  chart: {
    timeframe: OptionAnalyzerTimeframe;
    supported_timeframes: OptionAnalyzerTimeframe[];
    bars: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[];
    rsi: number[];
    macd: number[];
    macd_signal: number[];
    macd_hist: number[];
    smi: number[];
    smi_signal: number[];
    vwap: number[];
    ema9: number[];
    ema21: number[];
  };
  // ---- option-side chart: synthetic-price replay + indicators on the option ----
  option_chart: {
    timeframe: OptionAnalyzerTimeframe;
    synthetic_prices: number[];
    rsi: number[];
    macd: number[];
    macd_signal: number[];
    macd_hist: number[];
    ema9: number[];
    ema21: number[];
    rv30: number[];
  };
  // ---- Multi-TF momentum snapshot. Each TF gets a `MultiTfSnapshot` row. ----
  multi_tf: Record<OptionAnalyzerTimeframe, MultiTfSnapshot>;
  recommended_chart_tf: OptionAnalyzerTimeframe;
  // ---- 5-bar headline forecast (back-compat). Same as ensemble.horizons["5"]. ----
  forecast: {
    horizon: number;
    context_len: number;
    last_close: number;
    median: number[];
    p10: number[];
    p90: number[];
    expected_return_pct: number;
    band_pct: number;
  } | null;
  // ---- Full ensemble: Chronos + momentum + mean-reversion + martingale ----
  forecast_ensemble: {
    last_close: number;
    ensemble: {
      horizons: Record<string, ForecastHorizon>;
      calibration?: {
        samples: number;
        scale_factor_per_h: Record<string, number>;
        coverage_observed_per_h: Record<string, number>;
      };
    };
    members: Record<string, { horizons: Record<string, ForecastHorizon>; model?: string }>;
    agreement: Record<string, number>;
  } | null;

  // ---- Inputs that fed the verdict (auditability) ----
  signal_inputs: {
    daily: {
      rsi: number;
      macd_hist: number | null;
      ema9: number | null;
      ema21: number | null;
      ema200: number | null;
      trend_score: number;
    };
    chart_tf: {
      timeframe: OptionAnalyzerTimeframe;
      rsi: number | null;
      macd_hist: number | null;
      macd_hist_prev: number | null;
      smi: number | null;
      smi_signal: number | null;
      vwap: number | null;
    };
    forecast_5d: {
      expected_return_pct: number;
      band_pct: number;
      model: string;
    } | null;
    iv: number;
    iv_rv_ratio: number | null;
    dte: number;
    abs_delta: number | null;
  };
}
