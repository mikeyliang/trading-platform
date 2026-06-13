import type {
  WatchlistItem, Position, Trade, Order, AccountInfo,
  StrategyInfo, BacktestRequest, BacktestResult, Bar, Quote, SubscriptionError,
} from "@/types";
import { resolveApiBase } from "./api-base";

// Resolve the API origin at call time (env override → Coder port-swap →
// same-origin). See lib/api-base.ts. No Next.js proxy involved.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, { method: "DELETE", cache: "no-store" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  health: () => get<{ status: string; ib_connected: boolean; mode: string; mock_mode: boolean }>("/health"),
  account: () => get<AccountInfo>("/api/account"),

  // market
  bars: (symbol: string, timeframe = "15m", days = 30) =>
    get<{
      symbol: string;
      timeframe: string;
      bars: Bar[];
      source: string;
      proxy_used?: string;
      subscription?: SubscriptionError;
    }>(`/api/market/bars/${symbol}?timeframe=${timeframe}&days=${days}`),
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

  // simulation (NautilusTrader)
  simPresets: () =>
    get<{ presets: SimPreset[]; default_params: Record<string, number | boolean> }>("/api/sim/presets"),
  simStart: (req: SimRunRequest) => post<SimRunSummary>("/api/sim/run", req),
  simRuns: () => get<SimRunSummary[]>("/api/sim/runs"),
  simRun: (id: string) => get<SimRunDetail>(`/api/sim/runs/${id}`),
  simChart: (id: string, symbol: string) =>
    get<SimChartPayload>(`/api/sim/runs/${id}/chart?symbol=${encodeURIComponent(symbol)}`),
  simDelete: (id: string) => del<{ status: string }>(`/api/sim/runs/${id}`),
  newsAnalyst: (symbol: string) =>
    get<NewsAnalystRead>(`/api/news-analyst/${encodeURIComponent(symbol)}`),

  // trading bot
  botStatus: () => get<BotSnapshot>("/api/bot/status"),
  botStart: (req: Partial<BotSnapshot["config"]> & { force?: boolean }) =>
    post<BotSnapshot>("/api/bot/start", req),
  botStop: () => post<BotSnapshot>("/api/bot/stop", {}),
  botReset: () => post<BotSnapshot>("/api/bot/reset", {}),
  botGate: (preset: string, timeframe: string) =>
    get<BotGate>(`/api/bot/gate?preset=${encodeURIComponent(preset)}&timeframe=${encodeURIComponent(timeframe)}`),

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
  // Next earnings date via IBKR WSH. Returns source="unavailable" (not an
  // error) when the account lacks the subscription or the symbol is an index.
  optionsEarnings: (symbol: string) =>
    get<EarningsInfo>(`/api/options/earnings/${symbol}`),
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

  // Insights — stored analysis over time.
  // Cross-contract AI agent verdicts, newest first.
  recentAgentRuns: (params: { symbol?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.symbol) q.set("symbol", params.symbol);
    if (params.limit) q.set("limit", String(params.limit));
    const s = q.toString();
    return get<RecentAgentRun[]>(`/api/options/agent-runs/recent${s ? "?" + s : ""}`);
  },
  // Portfolio-wide forecast track record (per-model accuracy + per-symbol).
  forecastTrackRecord: (horizon?: number) => {
    const q = horizon ? `?horizon=${horizon}` : "";
    return get<ForecastTrackRecord>(`/api/options/forecast/track-record${q}`);
  },
  forecastScoreNow: () =>
    post<{ scored: number }>("/api/options/forecast/score-now", {}),
  // Run the AI agent pipeline on every open option position now.
  analyzePositions: (force = false) =>
    post<{
      open_options: number;
      analysed: number;
      skipped: number;
      failed: number;
      runs: { contract: string; run_id: number | null }[];
    }>(`/api/options/analyze-positions${force ? "?force=true" : ""}`, {}),

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

  // trade history (paginated list + rolled-up stats)
  tradeHistory: (params: {
    symbol?: string;
    status?: string;
    side?: string;
    strategy?: string;
    agent_id?: string;
    start?: string;
    end?: string;
    asset_class?: "option" | "stock" | "future";
    account_id?: string;
    transaction_type?: string;
    has_note?: boolean;
    page?: number;
    page_size?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.symbol) q.set("symbol", params.symbol);
    if (params.status) q.set("status", params.status);
    if (params.side) q.set("side", params.side);
    if (params.strategy) q.set("strategy", params.strategy);
    if (params.agent_id) q.set("agent_id", params.agent_id);
    if (params.start) q.set("start", params.start);
    if (params.end) q.set("end", params.end);
    if (params.asset_class) q.set("asset_class", params.asset_class);
    if (params.account_id) q.set("account_id", params.account_id);
    if (params.transaction_type) q.set("transaction_type", params.transaction_type);
    if (params.has_note != null) q.set("has_note", String(params.has_note));
    if (params.page) q.set("page", String(params.page));
    if (params.page_size) q.set("page_size", String(params.page_size));
    const s = q.toString();
    return get<TradeHistoryListResponse>(`/api/trade-history/${s ? "?" + s : ""}`);
  },
  tradeHistoryStats: (params: {
    symbol?: string;
    strategy?: string;
    agent_id?: string;
    start?: string;
    end?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.symbol) q.set("symbol", params.symbol);
    if (params.strategy) q.set("strategy", params.strategy);
    if (params.agent_id) q.set("agent_id", params.agent_id);
    if (params.start) q.set("start", params.start);
    if (params.end) q.set("end", params.end);
    const s = q.toString();
    return get<TradeStats>(`/api/trade-history/stats${s ? "?" + s : ""}`);
  },
  tradeHistoryAnalysis: (params: {
    symbol?: string;
    strategy?: string;
    agent_id?: string;
    start?: string;
    end?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.symbol) q.set("symbol", params.symbol);
    if (params.strategy) q.set("strategy", params.strategy);
    if (params.agent_id) q.set("agent_id", params.agent_id);
    if (params.start) q.set("start", params.start);
    if (params.end) q.set("end", params.end);
    const s = q.toString();
    return get<TradeAnalysisResponse>(`/api/trade-history/analysis${s ? "?" + s : ""}`);
  },
  tradeHistoryCreate: (payload: TradeHistoryCreatePayload) =>
    post<TradeHistoryRecord>("/api/trade-history/", payload),
  tradeHistoryUpdate: (id: number, payload: TradeHistoryUpdatePayload) =>
    put<TradeHistoryRecord>(`/api/trade-history/${id}`, payload),
  tradeHistoryDelete: (id: number) => del<void>(`/api/trade-history/${id}`),

  // IBKR Flex backfill: pulls historical executions from IBKR's Flex Web
  // Service (separate from the live socket). Status endpoint is cheap;
  // the backfill endpoint runs N consecutive 365-day Flex requests.
  tradeHistoryFlexStatus: () =>
    get<FlexBackfillStatus>("/api/trade-history/backfill-flex/status"),
  tradeHistoryFlexBackfill: (params: {
    years_back?: number;
    from_date?: string;
    to_date?: string;
    include_eae?: boolean;
    refresh?: boolean;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.years_back) q.set("years_back", String(params.years_back));
    if (params.from_date) q.set("from_date", params.from_date);
    if (params.to_date) q.set("to_date", params.to_date);
    if (params.include_eae != null) q.set("include_eae", String(params.include_eae));
    if (params.refresh) q.set("refresh", "true");
    const s = q.toString();
    return post<FlexBackfillResult>(
      `/api/trade-history/backfill-flex${s ? "?" + s : ""}`,
      {},
    );
  },
  // Background variant: returns immediately with a job id; poll
  // tradeHistoryFlexJob(id) to get progress + result.
  tradeHistoryFlexBackfillBackground: (params: {
    years_back?: number;
    refresh?: boolean;
  } = {}) => {
    const q = new URLSearchParams();
    q.set("background", "true");
    if (params.years_back) q.set("years_back", String(params.years_back));
    if (params.refresh) q.set("refresh", "true");
    return post<FlexJobHandle>(
      `/api/trade-history/backfill-flex?${q.toString()}`,
      {},
    );
  },
  tradeHistoryFlexJob: (jobId: string) =>
    get<FlexJobState>(`/api/trade-history/backfill-flex/jobs/${jobId}`),

};

export type TradeSide = "BUY" | "SELL";
export type TradeStatus =
  | "PENDING"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "CLOSED";

export interface TradeHistoryRecord {
  id: number;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  order_type: string;
  strategy?: string | null;
  agent_id?: string | null;
  status: TradeStatus;
  pnl?: number | null;
  pnl_percentage?: number | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown> | null;
}

export interface TradeHistoryCreatePayload {
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  order_type?: string;
  strategy?: string | null;
  agent_id?: string | null;
  status?: TradeStatus;
  timestamp?: string;
  metadata?: Record<string, unknown> | null;
}

export interface TradeHistoryUpdatePayload {
  pnl?: number | null;
  pnl_percentage?: number | null;
  status?: TradeStatus;
  metadata?: Record<string, unknown> | null;
}

export interface TradeHistoryListResponse {
  trades: TradeHistoryRecord[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface TradeStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  profit_factor: number;
}

export interface FlexBackfillAccount {
  account_id: string;
  rows: number;
}

export interface FlexBackfillStatus {
  configured: boolean;
  cooldown_sec: number;
  query_id: string | null;
  total_rows: number;
  earliest: string | null;
  latest: string | null;
  accounts: FlexBackfillAccount[];
}

export interface FlexBackfillSliceLog {
  from?: string | null;
  to?: string | null;
  trades?: number;
  option_eae?: number;
  error?: string;
  code?: string | null;
  info?: string;
}

export interface FlexBackfillResult {
  fetched: number;
  trades: number;
  option_eae: number;
  accounts: string[];
  inserted: number;
  updated: number;
  skipped: number;
  refresh: boolean;
  slices: FlexBackfillSliceLog[];
}

export interface FlexJobHandle {
  job_id: string;
  status: "running" | "done" | "failed" | "cancelled";
  slice_count: number;
  years_back: number;
  refresh: boolean;
}

export interface FlexJobState {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  slice_count: number;
  current_slice: number;
  last_slice_info: FlexBackfillSliceLog | null;
  result: FlexBackfillResult | null;
  error: string | null;
  refresh: boolean;
  years_back: number;
}

export interface TradeAnalysisTrade {
  id: number;
  symbol?: string | null;
  side?: TradeSide | null;
  quantity?: number | null;
  price?: number | null;
  pnl?: number | null;
  pnl_percentage?: number | null;
  timestamp: string;
  strategy?: string | null;
}

export interface StrategyInsight {
  strategy: string;
  count: number;
  total_pnl: number;
  win_rate: number;
}

export interface TimeOfDayInsight {
  hour: number;
  count: number;
  total_pnl: number;
  avg_pnl: number;
  win_rate: number;
}

export interface TradeAnalysisResponse {
  best_trade: TradeAnalysisTrade | null;
  worst_trade: TradeAnalysisTrade | null;
  biggest_win: TradeAnalysisTrade | null;
  biggest_loss: TradeAnalysisTrade | null;
  avg_hold_time_seconds: number | null;
  common_strategies: StrategyInsight[];
  time_of_day_patterns: TimeOfDayInsight[];
}

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

export interface EarningsInfo {
  symbol: string;
  next_date: string | null; // YYYYMMDD
  source: "wsh" | "unavailable" | string;
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
    /** Concrete next step: ADD | HOLD | SPEC | TRIM | EXIT. */
    action?: string | null;
    /** Confidence in the verdict: low | medium | high. */
    conviction?: string | null;
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
    // iv = vol used to price every series (calibrated to the live mark when
    // one exists); market_iv = IBKR's reported model IV; iv_source explains
    // which path produced it.
    iv?: number | null;
    market_iv?: number | null;
    iv_source?: "calibrated_to_mark" | "ibkr_model" | "realized_vol" | "default";
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
  // ---- option-side chart: real IBKR option bars when available, else a
  // modeled Black-Scholes replay. `source` says which; `prices`+`times` are
  // canonical (synthetic_prices kept as a back-compat alias). ----
  option_chart: {
    timeframe: OptionAnalyzerTimeframe;
    source: "ibkr" | "modeled";
    bar_size: string;
    times: number[];
    prices: number[];
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

// ── Insights: stored analysis over time ──────────────────────────────
export interface RecentAgentRun {
  id: number;
  ran_at: string;
  symbol: string;
  strike: number;
  expiry: string;
  right: "C" | "P";
  quantity: number;
  is_long: boolean;
  spot_at_run: number | null;
  mid_at_run: number | null;
  duration_ms: number | null;
  verdict: string | null;
  rationale: string | null;
  failed_agents: number;
}

export interface ForecastModelStat {
  n: number;
  mae_pct: number | null;
  rmse_pct: number | null;
  sign_hit_rate: number | null;
}

export interface ForecastTrackRecord {
  available: boolean;
  horizon: number | null;
  horizons: number[];
  counts: { logged: number; scored: number; pending: number };
  models: Record<string, ForecastModelStat>;
  per_symbol: { symbol: string; n: number; mae_pct: number | null; hit_rate: number | null }[];
}

// ── Simulation (NautilusTrader) ──────────────────────────────────────

export interface SimPreset {
  id: string;
  name: string;
  description: string;
  params: Record<string, number | boolean>;
}

export interface SimRunRequest {
  symbols: string[];
  timeframe: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  preset: string;
  params?: Record<string, number | boolean>;
  label?: string;
}

export interface SimStats {
  initial_capital: number;
  final_capital: number;
  total_return: number;
  total_return_pct: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  win_rate: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  expectancy: number;
  avg_trade_hours: number | null;
  buy_hold_return_pct?: number;
}

export interface SimAggregate {
  symbols_ok: number;
  avg_return_pct: number;
  avg_sharpe: number;
  avg_max_drawdown_pct: number;
  total_trades: number;
  win_rate: number;
  profit_factor: number;
  best_symbol: { symbol: string; return_pct: number };
  worst_symbol: { symbol: string; return_pct: number };
}

export interface SimRunSummary {
  id: string;
  label: string;
  preset: string;
  symbols: string[];
  timeframe: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  params: Record<string, number | boolean>;
  status: "running" | "completed" | "error";
  progress: { done: number; total: number; current: string | null };
  error: string | null;
  created_at: string;
  finished_at: string | null;
  aggregate: SimAggregate | null;
}

export interface SimTrade {
  entry_time: string;
  exit_time: string | null;
  side: "BUY" | "SELL";
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  pnl: number | null;
  pnl_pct: number | null;
}

export interface SimSymbolResult {
  stats?: SimStats;
  trades?: SimTrade[];
  equity_curve?: { time: number; value: number }[];
  markers?: SimMarker[];
  error?: string;
}

export interface SimRunDetail extends SimRunSummary {
  results: Record<string, SimSymbolResult>;
}

export interface SimMarker {
  time: number;
  type: "entry" | "exit";
  side: "long" | "short";
  price: number;
  score?: number;
  reasons?: string[];
  stop?: number;
  target?: number;
  reason?: string;
}

export interface SimChartPayload {
  stats: SimStats;
  trades: SimTrade[];
  equity_curve: { time: number; value: number }[];
  chart: {
    candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
    overlays: Record<"vwap" | "ema_fast" | "ema_slow" | "ema_trend", (number | null)[]>;
    panes: Record<string, (number | null)[]>;
    structure: {
      choch: { time: number; dir: 1 | -1; price: number }[];
      bos: { time: number; dir: 1 | -1; price: number }[];
    };
    volume_profile: { bins: number[]; volumes: number[]; poc: number; vah: number; val: number };
    markers: SimMarker[];
    params: Record<string, number | boolean>;
  };
}

export interface NewsAnalystRead {
  symbol: string;
  verdict: "bullish" | "bearish" | "neutral" | "mixed";
  confidence: number;
  bias_score: number;
  summary: string;
  working_for: string[];
  working_against: string[];
  headlines: { title: string; source: string; published: string; link: string }[];
  model: string;
  as_of: string;
  cached: boolean;
}

// ── Trading bot ──────────────────────────────────────────────────────

export interface BotPosition {
  qty: number;
  entry_price: number;
  entry_time: string;
  stop: number;
  target: number;
  last_price: number;
  entry_score: number;
  entry_reasons: string[];
  news_bias: number | null;
  news_verdict: string;
}

export interface BotClosedTrade {
  symbol: string;
  entry_time: string;
  exit_time: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  pnl: number;
  pnl_pct: number;
  reason: string;
  entry_score: number | null;
  news_bias: number | null;
}

export interface BotDecision {
  time: string;
  kind: "entry" | "exit" | "blocked" | "news" | "data" | "error" | "lifecycle";
  symbol: string;
  message: string;
  score?: number;
  news_bias?: number | null;
  pnl?: number;
  qty?: number;
}

export interface BotSnapshot {
  status: "running" | "stopped";
  config: {
    symbols: string[];
    timeframe: string;
    preset: string;
    params: Record<string, number | boolean>;
    initial_capital: number;
    max_positions: number;
    news_gate: boolean;
    news_block_below: number;
  };
  validated_by: string | null;
  started_at: string | null;
  last_cycle_at: string | null;
  last_error: string | null;
  cash: number;
  equity: number;
  total_return_pct: number;
  positions: Record<string, BotPosition>;
  open_count: number;
  closed_trades: BotClosedTrade[];
  trade_count: number;
  win_rate: number;
  decisions: BotDecision[];
  equity_history: { time: number; value: number }[];
}

export interface BotGate {
  validated: boolean;
  run: { id: string; label: string; aggregate: SimAggregate; finished_at: string } | null;
  criteria: string;
}
