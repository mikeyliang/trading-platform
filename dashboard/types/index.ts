export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  change: number;
  change_pct: number;
  timestamp: string;
}

export interface WatchlistItem {
  symbol: string;
  sector: string;
  name: string;
  last?: number;
  change_pct?: number;
  volume?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  avg_price: number;
  current_price: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  side: "BUY" | "SELL";
  sector?: string;
  // Option-only metadata. When ``is_option`` is true the row should render
  // the option subtitle (expiry · strike + right) and route clicks to the
  // option analyzer with these fields prefilled.
  is_option?: boolean;
  strike?: number;
  expiry?: string; // YYYYMMDD
  right?: "C" | "P";
  multiplier?: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  pnl?: number;
  timestamp: string;
  strategy?: string;
}

export interface Order {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  status: "PENDING" | "FILLED" | "PARTIALLY_FILLED" | "CANCELLED" | "REJECTED";
  filled_qty: number;
  avg_fill_price?: number;
  timestamp: string;
  strategy?: string;
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  status: "running" | "stopped" | "error";
  symbols: string[];
  timeframe: string;
  pnl: number;
  trades: number;
  win_rate: number;
  params: Record<string, unknown>;
}

export interface BacktestRequest {
  strategy: string;
  symbol: string;
  timeframe: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  params: Record<string, unknown>;
}

export interface BacktestTrade {
  entry_time: string;
  exit_time?: string;
  side: "BUY" | "SELL";
  entry_price: number;
  exit_price?: number;
  quantity: number;
  pnl?: number;
  pnl_pct?: number;
}

export interface BacktestResult {
  id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  final_capital: number;
  total_return: number;
  total_return_pct: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  win_rate: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  trades: BacktestTrade[];
  equity_curve: { time: number; value: number }[];
  smi_data: { time: number; smi: number; signal: number }[];
  status: string;
  created_at: string;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  buying_power: number;
  unrealized_pnl: number;
  realized_pnl: number;
  total_trades: number;
  win_rate: number;
  mode: string;
}

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export interface WSMessage {
  type:
    | "connected"
    | "disconnected"
    | "quote"
    | "bar"
    | "signal"
    | "order"
    | "position"
    | "subscribed"
    | "monitor_alert"
    | "snapshot";
  symbol?: string;
  data?: unknown;
  [key: string]: unknown;
}
