"use client";

import { chartChrome } from "@/lib/chartTheme";
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type RuleOneCycle, type RuleOneHistoryCycle } from "@/lib/api";
import { ws } from "@/lib/ws";
import type { Bar, Quote, SubscriptionError, Timeframe, WSMessage } from "@/types";
import { cn, fmt, fmtCompact } from "@/lib/utils";
import { RiPulseLine as Activity, RiBarChart2Line as BarChart2, RiBarChartBoxLine as BarChart3, RiCalendarLine as CalendarDays, RiDashboard3Line as Gauge, RiLoader4Line as Loader2, RiRulerLine as Ruler, RiStockLine as TrendingUp, RiSoundModuleLine as Waves, RiStackLine as Layers, RiSearchLine as Search } from "@remixicon/react";
import { useSpreadOverlay, SUPPORTED_OVERLAY_SYMBOLS } from "./useSpreadOverlay";
import { useSpreadFinderOverlay } from "./useSpreadFinderOverlay";
import { usePinnedSpreadOverlay, type PinnedSpread } from "./usePinnedSpreadOverlay";
import { useSmiOverlay } from "./useSmiOverlay";
import { useRsiOverlay } from "./useRsiOverlay";
import { useMacdOverlay } from "./useMacdOverlay";
import { useMonthlyExpiryOverlay, MONTHLY_OPEX_SYMBOLS } from "./useMonthlyExpiryOverlay";
import { useFibLevelsOverlay, type FibRange } from "./useFibLevelsOverlay";
import { useCycleOverlay } from "./useCycleOverlay";
import { useShortStrikeOverlay } from "./useShortStrikeOverlay";
import { useHistoricalStrikesOverlay } from "./useHistoricalStrikesOverlay";
import { useTradeMarkers } from "./useTradeMarkers";
import { TradeMarkerPopover } from "./TradeMarkerPopover";
import type { TradeHistoryRecord } from "@/lib/api";
import { OverlaysMenu, type OverlayGroup } from "./OverlaysMenu";
import { STRATEGIES, type StrategyId, type StrategySpec } from "@/lib/ruleone";
import { RuleOneCycleCard } from "@/components/ruleone/RuleOneCycleCard";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

// Symbols where the Rule One cycle card + entry/expiry guide lines render.
// RUT/IWM run the RUT-family setups; SPX/SPY run Space.
const RULEONE_SYMBOLS = new Set(["RUT", "IWM", "SPX", "SPY"]);

// Chart chrome follows the active theme (see lib/chartTheme.ts). Built at
// chart creation, so a theme toggle applies on the next mount.
const chartOpts = () => {
  const c = chartChrome();
  return {
    layout: {
      background: { type: ColorType.Solid, color: c.bg },
      textColor: c.axisText,
      fontSize: 11,
      fontFamily: "var(--tabular), ui-monospace, SFMono-Regular, monospace",
    },
    grid: {
      vertLines: { color: c.grid },
      horzLines: { color: c.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: c.crosshair, style: LineStyle.Dashed, width: 1 as 1 },
      horzLine: { color: c.crosshair, style: LineStyle.Dashed, width: 1 as 1 },
    },
    rightPriceScale: {
      borderColor: c.axis,
      scaleMargins: { top: 0.08, bottom: 0.22 },
    },
    timeScale: {
      borderColor: c.axis,
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: true,
    handleScale: true,
  };
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

function TradingChartImpl({ symbol, initialTimeframe = "15m", height, showIndicators = true, pinnedSpread = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaFastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSlowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Disposal sentinel, any callback that fires after unmount (rAF resize,
  // pending fetch resolution, late WS message) must skip chart ops to avoid
  // "Object is disposed" from lightweight-charts after `chart.remove()`.
  const disposedRef = useRef(false);

  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [loading, setLoading] = useState(true);
  const [emaOn, setEmaOn] = useState(showIndicators);
  const [vwapOn, setVwapOn] = useState(false);
  const [rsiOn, setRsiOn] = useState(false);
  const [macdOn, setMacdOn] = useState(false);
  // Volume bars at the bottom of the main pane, on by default since
  // the histogram is part of the chart's default visual frame.
  const [volumeOn, setVolumeOn] = useState(true);
  // Default the strategy overlay ON, it's a no-op when there are no spreads
  // or projection for the symbol, and the toggle is visible if anything renders.
  const [spreadsOn, setSpreadsOn] = useState(true);
  // Spread Finder overlay, calls the backend scanner and draws the top
  // candidate per trade type (RUT/Mars/MarsMax/Space). Off by default
  // because a fresh scan on the free Massive tier is rate-limited to
  // 5/min, full chain hydration takes ~5 minutes. User opts in via the
  // SCAN button. Once a scan runs, the result caches server-side for 10
  // min so repeat clicks are instant.
  const [scanOn, setScanOn] = useState(false);
  const [smiOn, setSmiOn] = useState(false);
  // 3rd-Friday monthly OPEX guide lines, default ON for the index/ETF
  // tickers where this is the trading frame (RUT/SPY/IWM/SPX/QQQ/NDX/DIA).
  const [opexOn, setOpexOn] = useState(() => MONTHLY_OPEX_SYMBOLS.has(symbol));
  // Fibonacci retracement levels, drawn from the loaded bars' high/low.
  // Each level is a "floor"; short-strike rule (RUT/Mars) is ≥ 2 floors below
  // the current money level.
  const [fibOn, setFibOn] = useState(() => MONTHLY_OPEX_SYMBOLS.has(symbol));
  // Fib lookback window. 9m matches the middle of Jamal's 6-12mo zone.
  const [fibRange, setFibRange] = useState<FibRange>("9m");
  // Trade markers, arrows on the candle series for executed trades on
  // this symbol, click-to-journal. Default ON so the visual is there
  // without users having to remember a toggle; cheap render when there
  // are no trades.
  const [tradesOn, setTradesOn] = useState(true);
  // The popover for the currently-clicked marker bucket. Anchored in
  // pixel coords inside the chart container.
  const [activePopover, setActivePopover] = useState<{
    trades: TradeHistoryRecord[];
    anchor: { x: number; y: number };
  } | null>(null);
  // Selected Rule One strategy, drives Fib target styling and the info card.
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
  // Why the chart is showing proxy/no data: missing IBKR entitlement +
  // which proxy (if any) we swapped in. Drives the banner below the toolbar.
  const [dataNotice, setDataNotice] = useState<
    { proxy?: string; subscription?: SubscriptionError } | null
  >(null);
  const [ohlcv, setOhlcv] = useState<{ o: number; h: number; l: number; c: number; v: number; chg: number; chgPct: number } | null>(null);
  // Bar under the crosshair. When set, the header shows hovered OHLCV; when
  // null (cursor outside the canvas), the header falls back to the latest bar.
  const [hover, setHover] = useState<{
    time: number;
    o: number; h: number; l: number; c: number; v: number;
    chg: number; chgPct: number;
  } | null>(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  // Trade marker(s) under the crosshair → compact read-only hover tooltip.
  // Click still opens the full journal popover. Kept separate from the OHLCV
  // `hover` state so both can render at once on a bar that has a fill.
  const [hoverBucket, setHoverBucket] = useState<{
    trades: TradeHistoryRecord[];
    x: number;
    y: number;
  } | null>(null);

  const smiContainerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);

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

  const tradeMarkers = useTradeMarkers({
    candleSeries: candleRef,
    symbol,
    enabled: tradesOn,
    bars: barsState,
  });

  // Daily bars: 10 years, enough for the 12-year Mars backtest reference and
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

  const { snapshot: rsiSnap } = useRsiOverlay({
    mainChart: chartRef,
    subpaneContainer: rsiContainerRef,
    symbol,
    timeframe,
    days: daysForTimeframe,
    enabled: rsiOn,
  });

  const { snapshot: macdSnap } = useMacdOverlay({
    mainChart: chartRef,
    subpaneContainer: macdContainerRef,
    symbol,
    timeframe,
    days: daysForTimeframe,
    enabled: macdOn,
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

  // Horizontal price lines at each strategy's short strike, the line
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
  // SCAN stays off across symbol changes, too expensive to fire automatically
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

      // Render candles as soon as bars arrive, don't make the user wait
      // for SMI/RSI/MACD compute before they can see prices.
      const barsResp = await barsPromise;
      const bars = barsResp.bars;
      // Surface entitlement / proxy state regardless of whether bars came
      // back (unavailable → empty bars but still a subscription reason).
      if (barsResp.proxy_used || barsResp.subscription) {
        setDataNotice({ proxy: barsResp.proxy_used, subscription: barsResp.subscription });
      } else {
        setDataNotice(null);
      }
      if (!bars.length) {
        setLoading(false);
        return;
      }
      if (disposedRef.current) return;

      setBarsState(bars);

      try {
        candleRef.current?.setData(bars.map((b: Bar) => ({
          time: b.time as UTCTimestamp,
          open: b.open, high: b.high, low: b.low, close: b.close,
        })));
        if (volumeOn) {
          const vc = chartChrome();
          volRef.current?.setData(bars.map((b: Bar) => ({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? vc.upSoft : vc.downSoft,
          })));
        } else {
          volRef.current?.setData([]);
        }
        chartRef.current?.timeScale().fitContent();
      } catch {
        // Series got disposed mid-setData (rapid symbol switch). Safe to ignore.
      }

      const last = bars[bars.length - 1];
      const first = bars[0];
      const chg = last.close - first.open;
      const chgPct = (chg / first.open) * 100;
      setOhlcv({ o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume, chg, chgPct });

      // Drop the spinner now, the chart is interactive. Indicator overlays
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
  }, [symbol, emaOn, vwapOn, volumeOn]);

  // init chart
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLDivElement>(".chart-main")!;

    disposedRef.current = false;
    const chart = createChart(el, { ...chartOpts(), width: el.clientWidth, height: el.clientHeight });
    chartRef.current = chart;

    const chrome = chartChrome();
    candleRef.current = chart.addCandlestickSeries({
      upColor: chrome.up, downColor: chrome.down,
      borderUpColor: chrome.up, borderDownColor: chrome.down,
      wickUpColor: chrome.up, wickDownColor: chrome.down,
      priceLineColor: chrome.crosshair,
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
          // chart disposed between rAF schedule + execute, safe to swallow.
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

  useEffect(() => { loadData(timeframe); }, [symbol, timeframe, emaOn, volumeOn, loadData]);

  // Crosshair hover → live OHLCV readout. Re-binds when bars change so the
  // prior-bar lookup (for chg/chgPct) reflects the current dataset. Index by
  // time for O(1) lookup, param.seriesData is keyed by series ref.
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || !barsState || barsState.length === 0) return;

    // The old hover's timestamp may not exist in the new dataset (timeframe
    // or symbol switched), clear so the header doesn't show stale numbers.
    setHover(null);

    const indexByTime = new Map<number, number>();
    for (let i = 0; i < barsState.length; i++) indexByTime.set(barsState[i].time, i);

    const handler = (param: MouseEventParams) => {
      if (param.time == null) {
        setHover(null);
        return;
      }
      // Update cursor position for tooltip
      if (param.point) {
        setCursorPos({ x: param.point.x, y: param.point.y });
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
        // chart disposed, safe to swallow.
      }
    };
  }, [barsState]);

  // Trade-marker click: map a chart click to the bucket of trades at
  // that bar, open a popover for journaling. Lightweight-charts doesn't
  // surface "did I click a marker", we look up the bar time the click
  // resolves to and check our bucket map.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!tradesOn) {
      setActivePopover(null);
      return;
    }
    const clickHandler = (param: MouseEventParams) => {
      if (param.time == null || !param.point) {
        return;
      }
      const bucket = tradeMarkers.bucketAt(param.time);
      if (!bucket) {
        setActivePopover(null);
        return;
      }
      setActivePopover({
        trades: bucket.trades,
        anchor: { x: param.point.x, y: param.point.y },
      });
    };
    chart.subscribeClick(clickHandler);
    return () => {
      try {
        chart.unsubscribeClick(clickHandler);
      } catch {
        // chart disposed, ignore.
      }
    };
  }, [tradesOn, tradeMarkers]);

  // Trade-marker hover: surface a compact read-only summary of the fill(s)
  // on the hovered bar. Lightweight-charts has no per-marker hover event, so
  // we reuse the crosshair-move time and look it up in the bucket map. The
  // click handler (above) still opens the full journaling popover.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!tradesOn) {
      setHoverBucket(null);
      return;
    }
    const handler = (param: MouseEventParams) => {
      if (param.time == null || !param.point) {
        setHoverBucket(null);
        return;
      }
      const bucket = tradeMarkers.bucketAt(param.time);
      if (!bucket) {
        setHoverBucket(null);
        return;
      }
      setHoverBucket({ trades: bucket.trades, x: param.point.x, y: param.point.y });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      try {
        chart.unsubscribeCrosshairMove(handler);
      } catch {
        // chart disposed, ignore.
      }
    };
  }, [tradesOn, tradeMarkers.bucketAt]);

  // Close the popover when the symbol changes, the trades it pointed at
  // are no longer relevant.
  useEffect(() => {
    setActivePopover(null);
    setHoverBucket(null);
  }, [symbol]);

  // live tick updates
  useEffect(() => {
    ws.subscribe([symbol]);
    const unsub = ws.on((msg: WSMessage) => {
      if (disposedRef.current) return;
      if (msg.type === "quote" && msg.symbol === symbol && msg.data) {
        const q = msg.data as Quote;
        if (q.last != null) {
          setOhlcv((prev) => prev ? { ...prev, c: q.last as number } : null);
        }
      }
      if (msg.type === "bar" && msg.symbol === symbol && msg.data && candleRef.current) {
        const b = msg.data as Bar;
        try {
          candleRef.current.update({
            time: b.time as UTCTimestamp,
            open: b.open, high: b.high, low: b.low, close: b.close,
          });
        } catch {
          // series was just disposed, drop the tick.
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
    <div className="flex flex-col w-full h-full bg-background-primary-default" style={height ? { height } : undefined}>
      {/* header strip */}
      <div className="flex items-center gap-4 px-4 h-11 border-b border-separator-border bg-background-primary-default shrink-0 overflow-hidden">
        <div className="flex items-baseline gap-2">
          <span className="tabular font-medium text-body-2-regular text-text-primary">{symbol}</span>
          {display && (
            <span className="text-title-3-regular tabular font-semibold text-text-primary leading-none">
              {fmt(display.c)}
            </span>
          )}
          {display && (
            <span
              className={cn(
                "text-caption-1-regular tabular leading-none px-1.5 py-0.5 rounded font-medium",
                positive ? "text-status-lime-text bg-status-lime-background" : "text-status-rose-text bg-status-rose-background"
              )}
            >
              {positive ? "+" : "−"}
              {fmt(Math.abs(display.chg))} ({display.chgPct >= 0 ? "+" : "−"}{Math.abs(display.chgPct).toFixed(2)}%)
            </span>
          )}
          {hover && (
            <span className="text-caption-2-regular tabular text-text-tertiary ml-1">
              {formatHoverTime(hover.time, timeframe)}
            </span>
          )}
        </div>
        {display && (
          <div className="hidden 2xl:flex items-center gap-3 text-caption-1-regular tabular text-text-tertiary">
            <span>O <Val n={display.o} /></span>
            <span>H <Val n={display.h} tone="up" /></span>
            <span>L <Val n={display.l} tone="down" /></span>
            <span>C <Val n={display.c} /></span>
            <span>V <Val n={display.v} compact /></span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => chartRef.current?.timeScale().resetTimeScale()}
            className="hidden xl:inline-flex h-7 px-2 items-center text-caption-1-medium rounded-lg text-text-secondary hover:text-text-primary hover:bg-background-secondary-hover transition-colors"
            title="Reset zoom"
          >
            Reset zoom
          </button>
          <OverlaysMenu groups={buildOverlayGroups({
            emaOn, setEmaOn, smiOn, setSmiOn, vwapOn, setVwapOn,
            rsiOn, setRsiOn, macdOn, setMacdOn, volumeOn, setVolumeOn,
            opexOn, setOpexOn, fibOn, setFibOn,
            fibRange, setFibRange,
            applicableStrategies, currentStrategy, setStrategyId,
            spreadsOn, setSpreadsOn, openSpreads,
            scanOn, setScanOn, scanLoading, scanResult,
            projected, symbol,
            tradesOn, setTradesOn, tradeCount: tradeMarkers.trades.length,
          })} />

          <span className="w-px h-4 bg-separator-border" />

          <div className="flex items-center gap-0.5 rounded-2lg bg-background-tertiary-default p-0.5">
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

          {/* Trade-marker visibility badge, zero-friction signal that
              tells you (without dev tools) how many of your trades are
              currently pinned on the chart. ?  on hover gives a quick
              breakdown of trades found vs markers rendered. */}
          {tradesOn && (
            <span
              className={cn(
                "hidden lg:inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-caption-1-medium tabular",
                tradeMarkers.renderedCount > 0
                  ? "bg-status-lime-background text-status-lime-text"
                  : tradeMarkers.trades.length > 0
                  ? "bg-status-yellow-background text-status-yellow-text"
                  : "bg-background-tertiary-default text-text-secondary",
              )}
              title={`Trades fetched for ${symbol}: ${tradeMarkers.trades.length}. Markers rendered: ${tradeMarkers.renderedCount}. If counts differ, marker times don't match any loaded bar, try a wider timeframe.`}
            >
              <Activity size={14} />
              {tradeMarkers.renderedCount > 0
                ? `${tradeMarkers.renderedCount} trades`
                : tradeMarkers.trades.length > 0
                ? `${tradeMarkers.trades.length} off-range`
                : "No trades"}
            </span>
          )}
        </div>
      </div>

      {/* market-data entitlement notice, names the missing IBKR
          subscription when the index can't be charted live. */}
      {dataNotice && (
        <div className="flex items-start gap-2 px-3 py-1 border-b border-separator-border bg-status-yellow-background text-caption-1-regular leading-tight text-status-yellow-text shrink-0">
          <span className="font-medium shrink-0">
            {dataNotice.proxy ? `Showing ${dataNotice.proxy} proxy` : "No live data"}
          </span>
          {dataNotice.subscription ? (
            <span className="text-text-secondary">
              {symbol} needs an IBKR market-data subscription
              {dataNotice.subscription.hint ? (
                <>: <span className="text-text-primary">{dataNotice.subscription.hint}</span></>
              ) : null}
              <span className="text-text-tertiary">
                {" "}(IBKR err {dataNotice.subscription.code}: {dataNotice.subscription.message})
              </span>
            </span>
          ) : (
            <span className="text-text-secondary">· {symbol} live index data isn&apos;t entitled on this IBKR account</span>
          )}
        </div>
      )}

      {/* chart canvas */}
      <div ref={containerRef} className="relative flex-1 min-h-0">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center select-none">
          <span className="text-[88px] tabular font-medium text-text-primary/[0.035]">{symbol}</span>
        </div>

        {/* Custom floating tooltip */}
        {hover && (
          <div 
            className="absolute z-30 bg-background-primary-default text-text-primary p-2 rounded-md text-caption-1-regular tabular shadow-dropdown pointer-events-none"
            style={{ 
              left: `${cursorPos.x + 10}px`, 
              top: `${cursorPos.y + 10}px`,
              transform: 'translate(-50%, -100%)'
            }}
          >
            <div className="font-semibold mb-1">{new Date(hover.time * 1000).toLocaleDateString()}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <span className="text-text-tertiary">Open:</span> <span>{hover.o.toFixed(2)}</span>
              <span className="text-text-tertiary">High:</span> <span className="text-status-lime-text">{hover.h.toFixed(2)}</span>
              <span className="text-text-tertiary">Low:</span> <span className="text-status-rose-text">{hover.l.toFixed(2)}</span>
              <span className="text-text-tertiary">Close:</span> <span>{hover.c.toFixed(2)}</span>
              <span className="text-text-tertiary">Volume:</span> <span>{hover.v.toLocaleString()}</span>
              <span className="text-text-tertiary">Change:</span> 
              <span className={hover.chg >= 0 ? 'text-status-lime-text' : 'text-status-rose-text'}>
                {hover.chg >= 0 ? '+' : ''}{hover.chg.toFixed(2)} ({hover.chgPct.toFixed(2)}%)
              </span>
            </div>
          </div>
        )}

        {/* Trade-marker hover tooltip, compact, read-only. Click a marker
            for the full detail + journal popover. */}
        {hoverBucket && hoverBucket.trades.length > 0 && (() => {
          // Header date, render in UTC so Flex's midnight-UTC fills don't
          // slip to the previous calendar day in western timezones.
          const d0 = new Date(hoverBucket.trades[0].timestamp);
          const dayLabel = Number.isNaN(d0.getTime())
            ? "Trades"
            : d0.toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
              });
          const n = hoverBucket.trades.length;
          return (
            <div
              className="absolute z-30 bg-background-primary-default text-text-primary rounded-md shadow-dropdown pointer-events-none overflow-hidden"
              style={{ left: `${hoverBucket.x + 16}px`, top: `${hoverBucket.y + 16}px`, width: 250 }}
            >
              <div className="px-3 py-1.5 bg-background-secondary-default flex items-center justify-between">
                <span className="text-caption-1-regular font-semibold">{dayLabel}</span>
                <span className="text-caption-2-regular text-text-tertiary">{n} {n === 1 ? "trade" : "trades"}</span>
              </div>
              <div className="divide-y divide-separator-border">
                {hoverBucket.trades.slice(0, 5).map((t) => {
                  const m = (t.metadata ?? {}) as Record<string, unknown>;
                  const isBuy = (t.side || "").toString().toUpperCase().startsWith("B");
                  const strike = typeof m.option_strike === "number" ? m.option_strike : null;
                  const right = m.option_right === "C" || m.option_right === "P" ? m.option_right : null;
                  const expiry = typeof m.option_expiry === "string" ? m.option_expiry : null;
                  const rightWord = right === "C" ? "Call" : right === "P" ? "Put" : "";
                  const detail = strike != null && right
                    ? `${t.symbol} $${fmt(strike, 0)} ${rightWord}${expiry ? ` · exp ${expiry.slice(4, 6)}/${expiry.slice(6, 8)}` : ""}`
                    : t.symbol;
                  return (
                    <div key={t.id} className="px-3 py-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-caption-1-regular">
                        <span className={cn("font-semibold shrink-0", isBuy ? "text-status-lime-text" : "text-status-rose-text")}>
                          {isBuy ? "Bought" : "Sold"} {fmt(t.quantity, 0)}
                        </span>
                        <span className="text-text-secondary shrink-0 tabular">@ ${fmt(t.price)}</span>
                      </div>
                      <div className="text-caption-2-regular text-text-tertiary truncate mt-0.5">{detail}</div>
                    </div>
                  );
                })}
              </div>
              {n > 5 && (
                <div className="px-3 py-1 text-caption-2-regular text-text-tertiary bg-background-secondary-default">+{n - 5} more</div>
              )}
              <div className="px-3 py-1 text-caption-2-regular text-text-tertiary bg-background-secondary-default border-t border-separator-border">
                click marker for details &amp; journal
              </div>
            </div>
          );
        })()}

        {/* Top-left overlay stack, cycle card on top, spread cards below. */}
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
                    <span className="text-status-lime-text tabular">+${s.credit_received.toFixed(2)}</span>
                  }
                />
                <div className="flex flex-col gap-1 mt-1">
                  {legs.map((leg, i) => (
                    <div key={i} className="flex items-center justify-between text-caption-1-regular tabular">
                      <span className={cn(leg.action === "SELL" ? "text-status-rose-text" : "text-status-lime-text")}>
                        {leg.action === "SELL" ? "short" : "long"}
                      </span>
                      <span className="text-text-primary tabular">
                        {leg.strike}{leg.right}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-separator-border text-caption-2-regular text-text-tertiary tabular">
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
              <div className="flex items-center gap-2 text-caption-1-regular tabular mt-1">
                <span className="text-status-yellow-text text-caption-1-regular">{projected.shortStrike}P</span>
                <span className="text-text-tertiary">/</span>
                <span className="text-accent-500 text-caption-1-regular">{projected.longStrike}P</span>
                <span className="ml-auto text-text-tertiary">
                  Δ {Math.abs(projected.shortDelta).toFixed(2)}
                </span>
              </div>
              {projected.estCredit != null && (
                <div className="mt-1.5 text-caption-2-regular text-text-tertiary tabular">
                  est credit <span className="text-status-lime-text">${projected.estCredit.toFixed(2)}</span>
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
                ["smi", smiSnap.smi != null ? smiSnap.smi.toFixed(2) : "n/a"],
                ["signal", smiSnap.signal != null ? smiSnap.signal.toFixed(2) : "n/a"],
                ...(smiSnap.lastSignal
                  ? [["last", smiSnap.lastSignal.type, smiSnap.lastSignal.type === "BUY" ? "up" : "down"] as const]
                  : []),
              ]}
            />
          </OverlayCard>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-background-full backdrop-blur-sm">
            <Loader2 size={16} className="animate-spin text-text-tertiary" />
          </div>
        )}
        <div className="chart-main absolute inset-0" />

        {/* Trade-marker popover (journal + detail). Pixel-positioned over
            the chart container; closes on chart-bg click or via the X button. */}
        {activePopover && containerRef.current && (
          <TradeMarkerPopover
            trades={activePopover.trades}
            anchor={activePopover.anchor}
            container={{
              width: containerRef.current.clientWidth,
              height: containerRef.current.clientHeight,
            }}
            onClose={() => setActivePopover(null)}
            onSaved={() => tradeMarkers.refresh()}
          />
        )}
      </div>

      {/* SMI subpane */}
      {smiOn && (
        <div className="border-t border-separator-border bg-background-full shrink-0" style={{ height: 140 }}>
          <div className="flex items-center gap-3 px-3 h-6 border-b border-separator-border">
            <span className="text-caption-2-regular text-text-tertiary">SMI</span>
            <span className="text-caption-2-regular tabular text-text-tertiary">13, 25, 2</span>
            <div className="ml-auto flex items-center gap-3 text-caption-2-regular tabular text-text-tertiary">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-chart-ema-fast" /> smi
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-chart-macd-signal" /> signal
              </span>
            </div>
          </div>
          <div ref={smiContainerRef} className="w-full h-[114px]" />
        </div>
      )}

      {/* RSI subpane */}
      {rsiOn && (
        <div className="border-t border-separator-border bg-background-full shrink-0" style={{ height: 120 }}>
          <div className="flex items-center gap-3 px-3 h-6 border-b border-separator-border">
            <span className="text-caption-2-regular text-text-tertiary">RSI</span>
            <span className="text-caption-2-regular tabular text-text-tertiary">14</span>
            {rsiSnap?.rsi != null && (
              <span className="text-caption-2-regular tabular text-text-secondary">
                {rsiSnap.rsi.toFixed(1)}
              </span>
            )}
            {rsiSnap?.zone === "overbought" && (
              <span className="text-caption-2-regular tabular text-status-rose-text">overbought</span>
            )}
            {rsiSnap?.zone === "oversold" && (
              <span className="text-caption-2-regular tabular text-status-lime-text">oversold</span>
            )}
            <div className="ml-auto flex items-center gap-3 text-caption-2-regular tabular text-text-tertiary">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-chart-ema-slow" /> rsi
              </span>
            </div>
          </div>
          <div ref={rsiContainerRef} className="w-full h-[94px]" />
        </div>
      )}

      {/* MACD subpane */}
      {macdOn && (
        <div className="border-t border-separator-border bg-background-full shrink-0" style={{ height: 140 }}>
          <div className="flex items-center gap-3 px-3 h-6 border-b border-separator-border">
            <span className="text-caption-2-regular text-text-tertiary">MACD</span>
            <span className="text-caption-2-regular tabular text-text-tertiary">12, 26, 9</span>
            {macdSnap?.cross === "bullish" && (
              <span className="text-caption-2-regular tabular text-status-lime-text">bullish</span>
            )}
            {macdSnap?.cross === "bearish" && (
              <span className="text-caption-2-regular tabular text-status-rose-text">bearish</span>
            )}
            <div className="ml-auto flex items-center gap-3 text-caption-2-regular tabular text-text-tertiary">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-chart-ema-fast" /> macd
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-chart-macd-signal" /> signal
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-status-lime-background" /> hist
              </span>
            </div>
          </div>
          <div ref={macdContainerRef} className="w-full h-[114px]" />
        </div>
      )}
    </div>
  );
}

// Skip re-renders triggered by parent state changes when the chart's own
// props are stable. The chart is one of the most expensive components in the
// dashboard (lightweight-charts series + multiple overlay hooks), so cutting
// no-op renders is a real win when the dashboard layout reflows around it.
export const TradingChart = memo(TradingChartImpl);

function Val({
  n,
  tone,
  compact,
}: {
  n: number;
  tone?: "up" | "down";
  compact?: boolean;
}) {
  const cls = tone === "up" ? "text-status-lime-text" : tone === "down" ? "text-status-rose-text" : "text-text-secondary";
  return (
    <span className={cn("text-caption-1-regular tabular", cls)}>
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
        "h-6 px-2 text-caption-1-medium tabular rounded-md transition-[background-color,color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        active ? "bg-segmented-control-selected-background text-text-primary shadow-2xs" : "text-text-secondary hover:text-text-primary"
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
        "absolute z-20 bg-background-primary-default backdrop-blur-md rounded-lg px-3.5 py-2.5 text-caption-1-regular shadow-dropdown pointer-events-auto",
        borderTone === "warning" && "ring-1 ring-warning/40",
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
    neutral: "bg-foreground-icon-quaternary",
    up: "bg-status-lime-text",
    down: "bg-status-rose-text",
    warning: "bg-status-yellow-text",
  }[tone];
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("w-1 h-1 rounded-full translate-y-[-1px]", dot)} />
      <span className="text-caption-2-regular font-medium text-text-secondary">{label}</span>
      {hint && (
        <span className="text-caption-2-regular text-text-tertiary">{hint}</span>
      )}
      {trail && <span className="ml-auto text-caption-2-regular">{trail}</span>}
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
          <span className="text-text-tertiary">{k}</span>
          <span
            className={cn(
              "text-right",
              tone === "up" ? "text-status-lime-text" : tone === "down" ? "text-status-rose-text" : tone === "warning" ? "text-status-yellow-text" : "text-text-primary"
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
  rsiOn: boolean; setRsiOn: (fn: (v: boolean) => boolean) => void;
  macdOn: boolean; setMacdOn: (fn: (v: boolean) => boolean) => void;
  volumeOn: boolean; setVolumeOn: (fn: (v: boolean) => boolean) => void;
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
  tradesOn: boolean; setTradesOn: (fn: (v: boolean) => boolean) => void;
  tradeCount: number;
}): OverlayGroup[] {
  const groups: OverlayGroup[] = [];

  groups.push({
    title: "Indicators",
    toggles: [
      { id: "ema",  label: "EMA",  icon: TrendingUp,   hint: "9 / 21",  active: args.emaOn,  onToggle: () => args.setEmaOn((v) => !v),  title: "9/21 EMA pair" },
      { id: "smi",  label: "SMI",  icon: Waves,        hint: "subpane", active: args.smiOn,  onToggle: () => args.setSmiOn((v) => !v),  title: "Stochastic momentum index sub-pane" },
      { id: "rsi",  label: "RSI",  icon: Gauge,        hint: "14",      active: args.rsiOn,  onToggle: () => args.setRsiOn((v) => !v),  title: "Relative strength index (14)" },
      { id: "macd", label: "MACD", icon: Activity,     hint: "12/26/9", active: args.macdOn, onToggle: () => args.setMacdOn((v) => !v), title: "Moving average convergence/divergence (12/26/9)" },
      { id: "volume", label: "Volume", icon: BarChart3, hint: "bars",   active: args.volumeOn, onToggle: () => args.setVolumeOn((v) => !v), title: "Volume bars at the bottom of the price pane" },
      { id: "vwap", label: "VWAP", icon: BarChart2,    hint: "intraday", active: args.vwapOn, onToggle: () => args.setVwapOn((v) => !v), title: "Volume-weighted average price (intraday daily-reset)" },
      { id: "opex", label: "OPEX", icon: CalendarDays, hint: "3rd Fri", active: args.opexOn, onToggle: () => args.setOpexOn((v) => !v), title: "Monthly OPEX guide lines (3rd Friday)" },
      { id: "fib",  label: "Fib floors", icon: Ruler,  active: args.fibOn,  onToggle: () => args.setFibOn((v) => !v),  title: "Fibonacci floors over loaded range" },
      {
        id: "trades",
        label: "My trades",
        icon: Activity,
        hint: args.tradeCount > 0 ? `${args.tradeCount} on ${args.symbol}` : "none",
        active: args.tradesOn,
        onToggle: () => args.setTradesOn((v) => !v),
        title: "Mark executed trades on the timeline. Click a marker to journal.",
      },
    ],
    extra: args.fibOn ? (
      <div className="flex flex-wrap gap-0.5 pt-1.5 pl-1.5">
        <span className="text-caption-2-regular text-text-tertiary self-center pr-1">fib lookback</span>
        {(["3m", "6m", "9m", "12m", "all"] as FibRange[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => args.setFibRange(r)}
            className={cn(
              "h-5 px-1.5 text-caption-2-regular tabular rounded-sm transition-colors",
              args.fibRange === r
                ? "text-text-primary bg-background-secondary-default"
                : "text-text-tertiary hover:text-text-secondary hover:bg-background-secondary-hover",
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
        title: `${s.name}, Δ≤${s.maxDelta}, AROC ${s.arocTarget}%, exit Δ${s.exitDelta}`,
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
