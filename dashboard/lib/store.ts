import { create } from "zustand";
import type {
  Quote,
  Position,
  WatchlistItem,
  StrategyInfo,
  AccountInfo,
  BacktestResult,
} from "@/types";

export interface PendingSuggestion {
  id: string;
  strategy: string;
  params: Record<string, unknown>;
  rationale?: string;
  source: "agent";
  timestamp: number;
  consumed?: boolean;
}

/** IBKR connection state machine — matches `ConnectionState` constants on
 *  the API side. Drives the colour-coded status pill in the UI. */
export type IbConnState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

interface LiveHealth {
  ib_connected: boolean;
  /** Fine-grained connection state pushed by the API supervisor. May be
   *  undefined for older payloads — fall back to ib_connected. */
  ib_state?: IbConnState;
  ib_error?: string | null;
  mode: string;
  mock_mode: boolean;
}

/** Snapshot of the IBKR connection supervisor (state, attempts, sticky subs). */
export interface IbStateSnapshot {
  state: IbConnState;
  connected: boolean;
  error: string | null;
  attempt: number;
  subscriptions: string[];
  host?: string;
  port?: number;
}

interface TradingStore {
  wsConnected: boolean;
  quotes: Record<string, Quote>;
  positions: Position[];
  watchlist: WatchlistItem[];
  strategies: StrategyInfo[];
  account: AccountInfo | null;
  liveHealth: LiveHealth | null;
  ibSnapshot: IbStateSnapshot | null;
  activeSymbol: string;
  activeTimeframe: string;

  // shared across chat/backtest — the model reads, BacktestPanel writes
  lastBacktest: BacktestResult | null;
  // agent → BacktestPanel handoff (chat writes, panel reads & marks consumed)
  pendingSuggestion: PendingSuggestion | null;

  setWsConnected: (v: boolean) => void;
  updateQuote: (q: Quote) => void;
  setPositions: (p: Position[]) => void;
  setWatchlist: (w: WatchlistItem[]) => void;
  setStrategies: (s: StrategyInfo[]) => void;
  setAccount: (a: AccountInfo) => void;
  setLiveHealth: (h: LiveHealth) => void;
  setIbSnapshot: (s: IbStateSnapshot) => void;
  setActiveSymbol: (s: string) => void;
  setActiveTimeframe: (tf: string) => void;
  setLastBacktest: (r: BacktestResult | null) => void;
  setPendingSuggestion: (s: PendingSuggestion | null) => void;
  consumePendingSuggestion: () => void;
}

export const useStore = create<TradingStore>((set) => ({
  wsConnected: false,
  quotes: {},
  positions: [],
  watchlist: [],
  strategies: [],
  account: null,
  liveHealth: null,
  ibSnapshot: null,
  activeSymbol: "AAPL",
  activeTimeframe: "15m",
  lastBacktest: null,
  pendingSuggestion: null,

  setWsConnected: (v) => set({ wsConnected: v }),
  updateQuote: (q) => set((s) => ({ quotes: { ...s.quotes, [q.symbol]: q } })),
  setPositions: (positions) => set({ positions }),
  setWatchlist: (watchlist) => set({ watchlist }),
  setStrategies: (strategies) => set({ strategies }),
  setAccount: (account) => set({ account }),
  setLiveHealth: (liveHealth) => set({ liveHealth }),
  setIbSnapshot: (ibSnapshot) => set({ ibSnapshot }),
  setActiveSymbol: (activeSymbol) => set({ activeSymbol }),
  setActiveTimeframe: (activeTimeframe) => set({ activeTimeframe }),
  setLastBacktest: (lastBacktest) => set({ lastBacktest }),
  setPendingSuggestion: (pendingSuggestion) => set({ pendingSuggestion }),
  consumePendingSuggestion: () =>
    set((s) =>
      s.pendingSuggestion
        ? { pendingSuggestion: { ...s.pendingSuggestion, consumed: true } }
        : {},
    ),
}));
