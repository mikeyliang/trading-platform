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

interface LiveHealth {
  ib_connected: boolean;
  mode: string;
  mock_mode: boolean;
}

interface TradingStore {
  wsConnected: boolean;
  quotes: Record<string, Quote>;
  positions: Position[];
  watchlist: WatchlistItem[];
  strategies: StrategyInfo[];
  account: AccountInfo | null;
  liveHealth: LiveHealth | null;
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
  activeSymbol: "AAPL",
  activeTimeframe: "15m",
  lastBacktest: null,
  pendingSuggestion: null,

  setWsConnected: (v) => set({ wsConnected: v }),
  updateQuote: (q) =>
    set((s) => ({ quotes: { ...s.quotes, [q.symbol]: q } })),
  setPositions: (positions) => set({ positions }),
  setWatchlist: (watchlist) => set({ watchlist }),
  setStrategies: (strategies) => set({ strategies }),
  setAccount: (account) => set({ account }),
  setLiveHealth: (liveHealth) => set({ liveHealth }),
  setActiveSymbol: (activeSymbol) => set({ activeSymbol }),
  setActiveTimeframe: (activeTimeframe) => set({ activeTimeframe }),
  setLastBacktest: (lastBacktest) => set({ lastBacktest }),
  setPendingSuggestion: (pendingSuggestion) => set({ pendingSuggestion }),
  consumePendingSuggestion: () =>
    set((s) =>
      s.pendingSuggestion ? { pendingSuggestion: { ...s.pendingSuggestion, consumed: true } } : {}
    ),
}));
