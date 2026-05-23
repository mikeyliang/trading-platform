"use client";

import {
  CandlestickData,
  ColorType,
  CrosshairMode,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  LineStyle,
  MouseEventParams,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type RuleOneCycle, type RuleOneHistoryCycle } from "@/lib/api";
import { ws } from "@/lib/ws";
import type { Bar, Quote, Timeframe, WSMessage } from "@/types";
import { cn, fmt, fmtCompact } from "@/lib/utils";
import { Activity, BarChart2, CalendarDays, Loader2, Ruler, TrendingUp, Waves, Layers, Search } from "lucide-react";
import { useSpreadOverlay, SUPPORTED_OVERLAY_SYMBOLS } from "./useSpreadOverlay";
import { useSpreadFinderOverlay } from "./useSpreadFinderOverlay";
import { usePinnedSpreadOverlay, type PinnedSpread } from "./usePinnedSpreadOverlay";
import { useSmiOverlay } from "./useSmiOverlay";
import { useMonthlyExpiryOverlay, MONTHLY_OPEX_SYMBOLS } from "./useMonthlyExpiryOverlay";
import { useFibLevelsOverlay, type FibRange } from "./useFibLevelsOverlay";
import { useCycleOverlay } from "./useCycleOverlay";
import { useShortStrikeOverlay } from "./useShortStrikeOverlay";
import { useHistoricalStrikesOverlay } from "./useHistoricalStrikesOverlay";
import { OverlaysMenu, type OverlayGroup } from "./OverlaysMenu";
import { STRATEGIES, type StrategyId, type StrategySpec } from "@/lib/ruleone";
import { RuleOneCycleCard } from "@/components/ruleone/RuleOneCycleCard";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

// Symbols where the Rule One cycle card + entry/expiry guide lines render.
// RUT/IWM run the RUT-family setups; SPX/SPY run Space.
const RULEONE_SYMBOLS = new Set(["RUT", "IWM", "SPX", "SPY"]);

const CHART_OPTS = {
  layout: {
    background: { type: ColorType.Solid, color: "#18181b" },
    textColor: "#71717a",
    fontSize: 11,
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  grid: {
    vertLines: { color: "#262629" },
    horzLines: { color: "#262629" },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: "#52525b", style: LineStyle.Dashed, width: 1 as 1 },
    horzLine: { color: "#52525b", style: LineStyle.Dashed, width: 1 as 1 },
  },
  rightPriceScale: {
    borderColor: "#38383f",
    scaleMargins: { top: 0.08, bottom: 0.22 },
  },
  timeScale: {
    borderColor: "#38383f",
    timeVisible: true,
    secondsVisible: false,
  },
  handleScroll: true,
  handleScale: true,
};

interface Props {
  symbol: string;
  initialTimeframe?: Timeframe;
  height?: number;
  showIndicators?: boolean;
  /**
   * When provided, render the pinned spread (short/long strikes + 2% exit) on
   * top of all other overlays in a highlighted color. Sourced from the Spread
   * Finder via URL query params at the page level.
   */
  pinnedSpread?: PinnedSpread | null;
}

export function TradingChart({ symbol, initialTimeframe = "15m", height, showIndicators = true, pinnedSpread = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaFastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSlowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Disposal sentinel — any callback that fires after unmount (rAF resize,
  // pending fetch resolution, late WS message) must skip chart ops to avoid
  // "Object is disposed" from lightweight-charts after `chart.remove()`.
  const disposedRef = useRef(false);

  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [loading, setLoading] = useState(true);
  const [emaOn, setEmaOn] = useState(showIndicators);
  const [vwapOn, setVwapOn] = useState(false);
  // Default the strategy overlay ON — it's a no-op when there are no spreads
  // or projection for the symbol, and the toggle is visible if anything renders.
  const [spreadsOn, setSpreadsOn] = useState(true);
  // Spread Finder overlay — calls the backend scanner and draws the top
  // candidate per trade type (RUT/Mars/MarsMax/Space). Off by default
  // because a fresh scan on the free Massive tier is rate-limited to
  // 5/min — full chain hydration takes ~5 minutes. User opts in via the
  // SCAN button. Once a scan runs, the result caches server-side for 10
  // min so repeat clicks are instant.
  const [scanOn, setScanOn] = useState(false);
  const [smiOn, setSmiOn] = useState(false);
  // 3rd-Friday monthly OPEX guide lines — default ON for the index/ETF
  // tickers where this is the trading frame (RUT/SPY/IWM/SPX/QQQ/NDX/DIA).
  const [opexOn, setOpexOn] = useState(() => MONTHLY_OPEX_SYMBOLS.has(symbol));
  // Fibonacci retracement levels — drawn from the loaded bars' high/low.
  // Each level is a "floor"; short-strike rule (RUT/Mars) is ≥ 2 floors below
  // the current money level.
  const [fibOn, setFibOn] = useState(() => MONTHLY_OPEX_SYMBOLS.has(symbol));
  // Fib lookback window. 9m matches the middle of Jamal's 6-12mo zone.
  const [fibRange, setFibRange] = useState<FibRange>("9m");
  // Selected Rule One strategy — drives Fib target styling and the info card.
  // Defaults to the first applicable strategy for the symbol.
  const applicableStrategies = useMemo<StrategySpec[]>(() => {
    if (symbol === "RUT" || symbol === "IWM") {
      return STRATEGIES.filter((s) => s.underlying === "RUT");
    }
    if (symbol === "SPX" || symbol === "SPY") {
      return STRATEGIES.filter((s) => s.underlying === "SPX");
    }
    return [];
  }, [symbol]);
  const [strategyId, setStrategyId] = useState<StrategyId | null>(
    applicableStrategies[0]?.id ?? null
  );
  const currentStrategy = useMemo(
    () => applicableStrategies.find((s) => s.id === strategyId) ?? applicableStrategies[0] ?? null,
    [applicableStrategies, strategyId]
  );
  useEffect(() => {
    setStrategyId(applicableStrategies[0]?.id ?? null);
  }, [applicableStrategies]);
  const [barsState, setBarsState] = useState<Bar[] | null>(null);
  const [ohlcv, setOhlcv] = useState<{ o: number; h: number; l: number; c: number; v: number; chg: number; chgPct: number } | null>(null);
  // Bar under the crosshair. When set, the header shows hovered OHLCV; when
  // null (cursor outside the canvas), the header falls back to the latest bar.
  const [hover, setHover] = useState<{
    time: number;
    o: number; h: number; l: number; c: number; v: number;
    chg: number; chgPct: number;
  } | null>(null);

  const smiContainerRef = useRef<HTMLDivElement>(null);

  const { openSpreads, projected } = useSpreadOverlay({
    candleSeries: candleRef,
    symbol,
    enabled: spreadsOn,
  });

  const { result: scanResult, loading: scanLoading } = useSpreadFinderOverlay({
    candleSeries: candleRef,
    symbol,
    enabled: scanOn,
  });

  usePinnedSpreadOverlay({ chart: chartRef, candleSeries: candleRef, pinned: pinnedSpread });

  // Daily bars: 10 years — enough for the 12-year Mars backtest reference and
  // multi-year fib views. Intraday timeframes are wider too now that we run
  // on IBKR + WS push (no rate-limit pressure on history).
  const daysForTimeframe =
    timeframe === "1d" ? 3650
    : timeframe === "4h" ? 730
    : timeframe === "1h" ? 180
    : timeframe === "30m" || timeframe === "15m" ? 60
    : 30;

  const { snapshot: smiSnap } = useSmiOverlay({
    mainChart: chartRef,
    candleSeries: candleRef,
    subpaneContainer: smiContainerRef,
    symbol,
    timeframe,
    days: daysForTimeframe,
    enabled: smiOn,
  });

  useMonthlyExpiryOverlay({
    chart: chartRef,
    container: containerRef,
    enabled: opexOn,
  });

  useFibLevelsOverlay({
    candleSeries: candleRef,
    bars: barsState,
    spot: ohlcv?.c ?? null,
    enabled: fibOn,
    floorRequired: currentStrategy?.floorRequired ?? true,
    strategyLabel: currentStrategy?.id ?? undefined,
    range: fibRange,
  });

  // Rule One cycle: only fetched for the four strategy symbols. Drives both
  // the floating card (top-left) and the entry/expiry vertical guide lines.
  const cycleSupported = RULEONE_SYMBOLS.has(symbol);
  const [cycle, setCycle] = useState<RuleOneCycle | null>(null);
  useEffect(() => {
    if (!cycleSupported) {
      setCycle(null);
      return;
    }
    let cancelled = false;
    api
      .ruleoneCycle(symbol)
      .then((r) => {
        if (!cancelled) setCycle(r);
      })
      .catch(() => {
        if (!cancelled) setCycle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, cycleSupported]);

  useCycleOverlay({
    chart: chartRef,
    container: containerRef,
    entryDate: cycle?.entry_date ?? null,
    expiryDate: cycle?.expiry_date ?? null,
    enabled: cycleSupported,
  });

  // Horizontal price lines at each strategy's short strike — the line
  // that matters for entry, breakeven, and the exit-delta trigger.
  useShortStrikeOverlay({
    candleSeries: candleRef,
    candidates: cycle?.candidates ?? [],
    enabled: cycleSupported,
  });

  // Historical short strikes: short segments at each past cycle's
  // short strike, bounded to that cycle's 25-day window so the chart
  // doesn't fill up with full-width lines.
  const [history, setHistory] = useState<RuleOneHistoryCycle[]>([]);
  useEffect(() => {
    if (!cycleSupported) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    api
      .ruleoneHistory(symbol, 12)
      .then((r) => {
        if (!cancelled) setHistory(r.cycles);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, cycleSupported]);

  useHistoricalStrikesOverlay({
    chart: chartRef,
    candleSeries: candleRef,
    container: containerRef,
    cycles: history,
    enabled: cycleSupported,
  });

  // When the symbol changes, re-default the overlays based on symbol type.
  // SCAN stays off across symbol changes — too expensive to fire automatically
  // on the free tier (see scanOn comment above).
  useEffect(() => {
    setOpexOn(MONTHLY_OPEX_SYMBOLS.has(symbol));
    setFibOn(MONTHLY_OPEX_SYMBOLS.has(symbol));
    setScanOn(false);
  }, [symbol]);

  const loadData = useCallback(async (tf: Timeframe) => {
    if (!containerRef.current) return;
    setLoading(true);
    try {
      const days = tf === "1d" ? 1825 : tf === "4h" ? 365 : tf === "1h" ? 90 : 30;
      // Fire both in parallel. Backend coalesces concurrent /bars requests
      // for the same key, so the second one rides the first's IBKR call.
      const barsPromise = api.bars(symbol, tf, days);
      const indPromise = api.indicators(symbol, tf, days).catch(() => null);

      // Render candles as soon as bars arrive — don't make the user wait
      // for SMI/RSI/MACD compute before they can see prices.
      const barsResp = await barsPromise;
      const bars = barsResp.bars;
      if (!bars.length) return;
      if (disposedRef.current) return;

      setBarsState(bars);

      try {
        candleRef.current?.setData(bars.map((b: Bar) => ({
          time: b.time as UTCTimestamp,
          open: b.open, high: b.high, low: b.low, close: b.close,
        })));
        volRef.current?.setData(bars.map((b: Bar) => ({
          time: b.time as UTCTimestamp,
          value: b.volume,
          color: b.close >= b.open ? "rgba(38,166,154,0.3)" : "rgba(239,83,80,0.3)",
        })));
        chartRef.current?.timeScale().fitContent();
      } catch {
        // Series got disposed mid-setData (rapid symbol switch). Safe to ignore.
      }

      const last = bars[bars.length - 1];
      const first = bars[0];
      const chg = last.close - first.open;
      const chgPct = (chg / first.open) * 100;
      setOhlcv({ o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume, chg, chgPct });

      // Drop the spinner now — the chart is interactive. Indicator overlays
      // arrive in a moment without holding up the user.
      setLoading(false);

      const indResp = await indPromise;
      if (disposedRef.current) return;

      try {
        if (indResp && emaOn) {
          emaFastRef.current?.setData(indResp.ema_fast.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
          emaSlowRef.current?.setData(indResp.ema_slow.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        } else {
          emaFastRef.current?.setData([]);
          emaSlowRef.current?.setData([]);
        }

        if (indResp && vwapOn && indResp.vwap) {
          vwapRef.current?.setData(
            indResp.vwap.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
          );
        } else {
          vwapRef.current?.setData([]);
        }
      } catch {
        // ignore late paint
      }
    } catch (e) {
      console.error("chart load error", e);
    } finally {
      setLoading(false);
    }
  }, [symbol, emaOn, vwapOn]);

  // init chart
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLDivElement>(".chart-main")!;

    disposedRef.current = false;
    const chart = createChart(el, { ...CHART_OPTS, width: el.clientWidth, height: el.clientHeight });
    chartRef.current = chart;

    candleRef.current = chart.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      priceLineColor: "#3f3f46",
      priceLineStyle: LineStyle.Dotted,
    });

    volRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    emaFastRef.current = chart.addLineSeries({
      color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    emaSlowRef.current = chart.addLineSeries({
      color: "#a78bfa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    vwapRef.current = chart.addLineSeries({
      color: "#facc15", lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      lineStyle: LineStyle.LargeDashed, title: "VWAP",
    });

    // ResizeObserver with rAF debounce + dimension-equality check to break
    // the feedback loop where applyOptions(width/height) triggers a sub-pixel
    // layout shift that re-fires the observer. That loop is what made the
    // chart "spasm" by 1-2px every time StatsBar / PositionsPanel polled
    // and re-rendered the surrounding flex layout.
    let rafId = 0;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (disposedRef.current) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        try {
          chart.applyOptions({ width: w, height: h });
        } catch {
          // chart disposed between rAF schedule + execute — safe to swallow.
        }
      });
    });
    ro.observe(containerRef.current);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      // Null the series refs *before* removing the chart so any in-flight
      // callbacks (WS ticks, loadData resolutions) skip their update calls.
      candleRef.current = null;
      volRef.current = null;
      emaFastRef.current = null;
      emaSlowRef.current = null;
      vwapRef.current = null;
      chartRef.current = null;
      try {
        chart.remove();
      } catch {
        // double-dispose race is harmless.
      }
    };
  }, []);

  useEffect(() => { loadData(timeframe); }, [symbol, timeframe, emaOn, loadData]);

  // Crosshair hover → live OHLCV readout. Re-binds when bars change so the
  // prior-bar lookup (for chg/chgPct) reflects the current dataset. Index by
  // time for O(1) lookup — param.seriesData is keyed by series ref.
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || !barsState || barsState.length === 0) return;

    // The old hover's timestamp may not exist in the new dataset (timeframe
    // or symbol switched) — clear so the header doesn't show stale numbers.
    setHover(null);

    const indexByTime = new Map<number, number>();
    for (let i = 0; i < barsState.length; i++) indexByTime.set(barsState[i].time, i);

    const handler = (param: MouseEventParams) => {
      if (param.time == null) {
        setHover(null);
        return;
      }
      const data = param.seriesData.get(candle) as CandlestickData | undefined;
      if (!data) {
        setHover(null);
        return;
      }
      const t = data.time as number;
      const idx = indexByTime.get(t);
      if (idx == null) return;
      const bar = barsState[idx];
      const prev = idx > 0 ? barsState[idx - 1] : null;
      const ref = prev ? prev.close : bar.open;
      const chg = bar.close - ref;
      const chgPct = ref !== 0 ? (chg / ref) * 100 : 0;
      setHover({
        time: t,
        o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume,
        chg, chgPct,
      });
    };

    chart.subscribeCrosshairMove(handler);
    return () => {
      try {
        chart.unsubscribeCrosshairMove(handler);
      } catch {
        // chart disposed — safe to swallow.
      }
    };
  }, [barsState]);

  // live tick updates
  useEffect(() => {
    ws.subscribe([symbol]);
    const unsub = ws.on((msg: WSMessage) => {
      if (disposedRef.current) return;
      if (msg.type === "quote" && msg.symbol === symbol && msg.data) {
        const q = msg.data as Quote;
        setOhlcv((prev) => prev ? { ...prev, c: q.last } : null);
      }
      if (msg.type === "bar" && msg.symbol === symbol && msg.data && candleRef.current) {
        const b = msg.data as Bar;
        try {
          candleRef.current.update({
            time: b.time as UTCTimestamp,
            open: b.open, high: b.high, low: b.low, close: b.close,
          });
        } catch {
          // series was just disposed — drop the tick.
        }
      }
    });
    return unsub;
  }, [symbol]);

  // While hovering, the header reads from the bar under the crosshair; on
  // pointer-leave we fall back to the latest bar.
  const display = hover ?? ohlcv;
  const positive = (display?.chg ?? 0) >= 0;

  return (
    <div className="flex flex-col w-full h-full bg-bg" style={height ? { height } : undefined}>
      {/* header strip */}
      <div className="flex items-center gap-3 md:gap-5 px-3 md:px-4 min-h-10 py-1 border-b border-border/60 bg-surface shrink-0 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm text-text-primary tracking-tight">{symbol}</span>
          {display && (
            <span className="text-base tabular font-medium text-text-primary">
              {fmt(display.c)}
            </span>
          )}
          {display && (
            <span
              className={cn(
                "text-[11px] tabular leading-none px-1.5 py-0.5 rounded",
                positive ? "text-up bg-up/10" : "text-down bg-down/10"
              )}
            >
              {positive ? "+" : ""}
              {fmt(display.chg)} · {display.chgPct >= 0 ? "+" : ""}{display.chgPct.toFixed(2)}%
            </span>
          )}
          {hover && (
            <span className="text-[10px] tabular text-text-muted ml-1">
              {formatHoverTime(hover.time, timeframe)}
            </span>
          )}
        </div>
        {display && (
          <div className="hidden md:flex items-center gap-3 text-[10px] uppercase tracking-wider text-text-muted">
            <span>O <Val n={display.o} /></span>
            <span>H <Val n={display.h} tone="up" /></span>
            <span>L <Val n={display.l} tone="down" /></span>
            <span>C <Val n={display.c} /></span>
            <span>V <Val n={display.v} compact /></span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button
            onClick={() => chartRef.current?.timeScale().resetTimeScale()}
            className="px-2 py-1 text-xs bg-gray-700 text-white rounded hover:bg-gray-600"
            title="Reset Zoom"
          >
            Reset Zoom
          </button>
          <OverlaysMenu groups={buildOverlayGroups({
            emaOn, setEmaOn, smiOn, setSmiOn, vwapOn, setVwapOn,
            opexOn, setOpexOn, fibOn, setFibOn,
            fibRange, setFibRange,
            applicableStrategies, currentStrategy, setStrategyId,
            spreadsOn, setSpreadsOn, openSpreads,
            scanOn, setScanOn, scanLoading, scanResult,
            projected, symbol,
          })} />

          <span className="w-px h-4 bg-border/60" />

          <div className="flex items-center gap-0.5">
            {TIMEFRAMES.map((tf) => (
              <ToolbarChip
                key={tf}
                active={timeframe === tf}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </ToolbarChip>
            ))}
          </div>
        </div>
      </div>

      {/* chart canvas */}
      <div ref={containerRef} className="relative flex-1 min-h-0">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center select-none">
          <span className="text-[88px] font-medium text-text-muted/[0.04] tracking-[0.2em]">{symbol}</span>
        </div>

        {/* Top-left overlay stack — cycle card on top, spread cards below. */}
        <div className="absolute top-4 left-4 z-20 flex flex-col gap-3 pointer-events-auto max-w-[300px]">
          <RuleOneCycleCard symbol={symbol} />
          {spreadsOn && openSpreads.map((s) => {
            const expLabel = `${s.expiry.slice(4, 6)}/${s.expiry.slice(6, 8)}`;
            const legs = (s.legs && s.legs.length > 0) ? s.legs : [
              { strike: s.short_strike, right: "P" as const, action: "SELL" as const, con_id: 0 },
              { strike: s.long_strike, right: "P" as const, action: "BUY" as const, con_id: 0 },
            ];
            return (
              <OverlayCard key={s.id}>
                <OverlayHeader
                  label={s.spread_type || "Spread"}
                  hint={`${expLabel} · ${s.quantity}x`}
                  trail={
                    <span className="text-up tabular">+${s.credit_received.toFixed(2)}</span>
                  }
                />
                <div className="flex flex-col gap-1 mt-1">
                  {legs.map((leg, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px] tabular">
                      <span className={cn(leg.action === "SELL" ? "text-down" : "text-up")}>
                        {leg.action === "SELL" ? "short" : "long"}
                      </span>
                      <span className="text-text-primary font-mono">
                        {leg.strike}{leg.right}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-border/40 text-[10px] text-text-muted tabular">
                  max {fmt(s.max_profit)} / {fmt(-Math.abs(s.max_loss))}
                </div>
              </OverlayCard>
            );
          })}
          {spreadsOn && projected && (
            <OverlayCard borderTone="warning">
              <OverlayHeader
                label="Projected entry"
                tone="warning"
                hint={`${projected.dte}d · ${projected.expiryLabel}`}
              />
              <div className="flex items-center gap-2 text-[11px] tabular mt-1">
                <span className="text-warning font-mono">{projected.shortStrike}P</span>
                <span className="text-text-muted">/</span>
                <span className="text-accent font-mono">{projected.longStrike}P</span>
                <span className="ml-auto text-text-muted">
                  Δ {Math.abs(projected.shortDelta).toFixed(2)}
                </span>
              </div>
              {projected.estCredit != null && (
                <div className="mt-1.5 text-[10px] text-text-muted tabular">
                  est credit <span className="text-up">${projected.estCredit.toFixed(2)}</span>
                  <span className="ml-2">
                    max loss ${((projected.shortStrike - projected.longStrike - projected.estCredit) * 100).toFixed(0)}
                  </span>
                </div>
              )}
            </OverlayCard>
          )}
        </div>

        {fibOn && currentStrategy && (
          <OverlayCard className="bottom-4 left-4 min-w-[200px]">
            <OverlayHeader
              label={currentStrategy.name}
              tone={currentStrategy.floorRequired ? "neutral" : "warning"}
              hint={currentStrategy.floorRequired ? "2 floors below money" : "floor optional"}
            />
            <OverlayGrid
              rows={[
                ["short Δ ≤", currentStrategy.maxDelta.toString()],
                ["adj OTM ≥", `${currentStrategy.minAdjOTM}%`],
                ["AROC tgt", `${currentStrategy.arocTarget}%`, "up"],
                ["exit Δ ≥", currentStrategy.exitDelta.toString(), "down"],
                ["Kelly ≥", `${currentStrategy.minKelly}%`],
              ]}
            />
          </OverlayCard>
        )}

        {smiOn && smiSnap && (
          <OverlayCard className="top-4 right-4">
            <OverlayHeader
              label="SMI"
              tone={smiSnap.zone === "overbought" ? "down" : smiSnap.zone === "oversold" ? "up" : "neutral"}
              hint={
                smiSnap.zone === "overbought"
                  ? "overbought"
                  : smiSnap.zone === "oversold"
                  ? "oversold"
                  : smiSnap.cross
                  ? smiSnap.cross
                  : undefined
              }
            />
            <OverlayGrid
              rows={[
                ["smi", smiSnap.smi != null ? smiSnap.smi.toFixed(2) : "—"],
                ["signal", smiSnap.signal != null ? smiSnap.signal.toFixed(2) : "—"],
                ...(smiSnap.lastSignal
                  ? [["last", smiSnap.lastSignal.type, smiSnap.lastSignal.type === "BUY" ? "up" : "down"] as const]
                  : []),
              ]}
            />
          </OverlayCard>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-bg/30 backdrop-blur-sm">
            <Loader2 size={16} className="animate-spin text-text-muted" />
          </div>
        )}
        <div className="chart-main absolute inset-0" />
      </div>

      {/* SMI subpane */}
      {smiOn && (
        <div className="border-t border-border bg-bg shrink-0" style={{ height: 140 }}>
          <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">SMI</span>
            <span className="text-[10px] tabular text-text-muted">13 · 25 · 2</span>
            <div className="ml-auto flex items-center gap-3 text-[10px] tabular text-text-muted">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-[#60a5fa]" /> smi
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-[#f59e0b]" /> signal
              </span>
            </div>
          </div>
          <div ref={smiContainerRef} className="w-full h-[114px]" />
        </div>
      )}
    </div>
  );
}

function Val({
  n,
  tone,
  compact,
}: {
  n: number;
  tone?: "up" | "down";
  compact?: boolean;
}) {
  const cls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-secondary";
  return (
    <span className={cn("normal-case tracking-normal text-[11px] tabular", cls)}>
      {compact ? fmtCompact(n) : fmt(n)}
    </span>
  );
}

function formatHoverTime(time: number, timeframe: Timeframe): string {
  const d = new Date(time * 1000);
  const intraday = timeframe !== "1d";
  if (intraday) {
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function ToolbarChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "h-6 px-2 text-[11px] tabular tracking-normal rounded-sm transition-colors",
        active
          ? "text-text-primary bg-surface-2"
          : "text-text-muted hover:text-text-secondary hover:bg-surface-2/60"
      )}
    >
      {children}
    </button>
  );
}

function OverlayCard({
  children,
  className,
  borderTone,
}: {
  children: React.ReactNode;
  className?: string;
  borderTone?: "warning";
}) {
  return (
    <div
      className={cn(
        // Match the chart canvas bg so info-cards look embedded, not floating.
        "absolute z-20 bg-bg/80 backdrop-blur-md rounded-md px-3.5 py-2.5 text-[11px] shadow-sm pointer-events-auto",
        "border",
        borderTone === "warning" ? "border-warning/30" : "border-border/40",
        className
      )}
    >
      {children}
    </div>
  );
}

function OverlayHeader({
  label,
  tone = "neutral",
  hint,
  trail,
}: {
  label: string;
  tone?: "neutral" | "up" | "down" | "warning";
  hint?: string;
  trail?: React.ReactNode;
}) {
  const dot = {
    neutral: "bg-text-muted",
    up: "bg-up",
    down: "bg-down",
    warning: "bg-warning",
  }[tone];
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("w-1 h-1 rounded-full translate-y-[-1px]", dot)} />
      <span className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</span>
      {hint && (
        <span className="text-[10px] text-text-muted">· {hint}</span>
      )}
      {trail && <span className="ml-auto text-[10px]">{trail}</span>}
    </div>
  );
}

function OverlayGrid({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, string] | readonly [string, string, "up" | "down" | "warning"]>;
}) {
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular">
      {rows.map(([k, v, tone], i) => (
        <span key={i} className="contents">
          <span className="text-text-muted">{k}</span>
          <span
            className={cn(
              "text-right",
              tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warning" ? "text-warning" : "text-text-primary"
            )}
          >
            {v}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Build the grouped toggle list rendered inside the Overlays dropdown.
 * Pulled out so the toolbar JSX stays readable.
 */
function buildOverlayGroups(args: {
  emaOn: boolean; setEmaOn: (fn: (v: boolean) => boolean) => void;
  smiOn: boolean; setSmiOn: (fn: (v: boolean) => boolean) => void;
  vwapOn: boolean; setVwapOn: (fn: (v: boolean) => boolean) => void;
  opexOn: boolean; setOpexOn: (fn: (v: boolean) => boolean) => void;
  fibOn: boolean; setFibOn: (fn: (v: boolean) => boolean) => void;
  fibRange: FibRange; setFibRange: (r: FibRange) => void;
  applicableStrategies: StrategySpec[]; currentStrategy: StrategySpec | null;
  setStrategyId: (id: StrategyId) => void;
  spreadsOn: boolean; setSpreadsOn: (fn: (v: boolean) => boolean) => void;
  openSpreads: { id: string }[];
  scanOn: boolean; setScanOn: (fn: (v: boolean) => boolean) => void;
  scanLoading: boolean;
  scanResult: { trade_types?: Record<string, { passes: Record<string, boolean> }[]> } | null;
  projected: unknown; symbol: string;
}): OverlayGroup[] {
  const groups: OverlayGroup[] = [];

  groups.push({
    title: "Indicators",
    toggles: [
      { id: "ema",  label: "EMA",  icon: TrendingUp,   hint: "9 / 21",  active: args.emaOn,  onToggle: () => args.setEmaOn((v) => !v),  title: "9/21 EMA pair" },
      { id: "smi",  label: "SMI",  icon: Waves,        hint: "subpane", active: args.smiOn,  onToggle: () => args.setSmiOn((v) => !v),  title: "Stochastic momentum index sub-pane" },
      { id: "vwap", label: "VWAP", icon: BarChart2,    hint: "intraday", active: args.vwapOn, onToggle: () => args.setVwapOn((v) => !v), title: "Volume-weighted average price (intraday daily-reset)" },
      { id: "opex", label: "OPEX", icon: CalendarDays, hint: "3rd Fri", active: args.opexOn, onToggle: () => args.setOpexOn((v) => !v), title: "Monthly OPEX guide lines (3rd Friday)" },
      { id: "fib",  label: "Fib floors", icon: Ruler,  active: args.fibOn,  onToggle: () => args.setFibOn((v) => !v),  title: "Fibonacci floors over loaded range" },
    ],
    extra: args.fibOn ? (
      <div className="flex flex-wrap gap-0.5 pt-1.5 pl-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted self-center pr-1">fib lookback</span>
        {(["3m", "6m", "9m", "12m", "all"] as FibRange[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => args.setFibRange(r)}
            className={cn(
              "h-5 px-1.5 text-[10px] tabular rounded-sm transition-colors",
              args.fibRange === r
                ? "text-text-primary bg-surface-2"
                : "text-text-muted hover:text-text-secondary hover:bg-surface-2/60",
            )}
          >
            {r}
          </button>
        ))}
      </div>
    ) : undefined,
  });

  if (args.applicableStrategies.length > 0) {
    groups.push({
      title: "Strategy",
      toggles: args.applicableStrategies.map((s) => ({
        id: s.id,
        label: s.name,
        icon: Activity,
        hint: `Δ≤${s.maxDelta} · ${s.arocTarget}%`,
        active: args.currentStrategy?.id === s.id,
        onToggle: () => args.setStrategyId(s.id),
        title: `${s.name} — Δ≤${s.maxDelta}, AROC ${s.arocTarget}%, exit Δ${s.exitDelta}`,
      })),
    });
  }

  const wantsStrats = args.openSpreads.length > 0 || (args.projected && SUPPORTED_OVERLAY_SYMBOLS.has(args.symbol));
  const wantsScan = SUPPORTED_OVERLAY_SYMBOLS.has(args.symbol);
  if (wantsStrats || wantsScan) {
    const toggles: OverlayToggle[] = [];
    if (wantsStrats) {
      toggles.push({
        id: "strats",
        label: "Open spreads",
        icon: Layers,
        hint: args.openSpreads.length > 0 ? `${args.openSpreads.length} live` : undefined,
        active: args.spreadsOn,
        onToggle: () => args.setSpreadsOn((v) => !v),
        title: "Show open spreads + 2% exit lines",
      });
    }
    if (wantsScan) {
      toggles.push({
        id: "scan",
        label: "Spread scan",
        icon: Search,
        hint: args.scanLoading
          ? "…"
          : args.scanResult
            ? `${countPassing(args.scanResult)} passing`
            : undefined,
        active: args.scanOn,
        onToggle: () => args.setScanOn((v) => !v),
        title: "Run Mars / Mars Max / Space / RUT scanner",
      });
    }
    groups.push({ title: "Spreads", toggles });
  }

  return groups;
}

type OverlayToggle = OverlayGroup["toggles"][number];

function strategyChipLabel(id: StrategyId): string {
  switch (id) {
    case "rut":
      return "RUT";
    case "mars":
      return "MARS";
    case "marsmax":
      return "MAX";
    case "space":
      return "SPACE";
  }
}

function countPassing(result: { trade_types?: Record<string, { passes: Record<string, boolean> }[]> }): number {
  if (!result.trade_types) return 0;
  let n = 0;
  for (const cands of Object.values(result.trade_types)) {
    if (cands.some((c) => Object.values(c.passes).every(Boolean))) n++;
  }
  return n;
}
