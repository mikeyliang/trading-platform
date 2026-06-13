"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickData,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  LineStyle,
  LogicalRange,
  MouseEventParams,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { cn, fmt, fmtCompact } from "@/lib/utils";
import { CHART, baseChartOptions } from "@/lib/chartTheme";
import type { OptionAnalyzeResult, OptionAnalyzerTimeframe, TradeHistoryRecord } from "@/lib/api";
import { useTradeMarkers } from "@/components/chart/useTradeMarkers";
import { TradeMarkerPopover } from "@/components/chart/TradeMarkerPopover";

interface Props {
  result: OptionAnalyzeResult;
  timeframe: OptionAnalyzerTimeframe;
  onTimeframeChange: (tf: OptionAnalyzerTimeframe) => void;
  loading?: boolean;
}

// Forecast members. Order is the legend order on screen.
const MEMBER_KEYS = ["chronos", "momentum", "mean_reversion", "martingale"] as const;
type MemberKey = (typeof MEMBER_KEYS)[number];
const MEMBER_LABELS: Record<MemberKey, string> = {
  chronos: "Chronos",
  momentum: "Momentum",
  mean_reversion: "Mean rev",
  martingale: "No-info",
};
const MEMBER_COLORS: Record<MemberKey, string> = {
  chronos: CHART.forecast.chronos,
  momentum: CHART.forecast.momentum,
  mean_reversion: CHART.forecast.meanrev,
  martingale: CHART.forecast.martingale,
};

// Bars to keep on screen by default. User can scroll back for more.
// Reduced from 90 so candles stay readable on full-width displays
// instead of compressing into hair-thin lines.
const VISIBLE_BARS_DEFAULT = 60;

/**
 * Multi-pane underlying analysis card, built on lightweight-charts to mirror
 * the look of the main TradingChart used on the dashboard and chart pages:
 *
 *  - Top OHLCV strip with hover-driven values + colored change pill
 *  - Price pane with candles, EMA9 / EMA21 / VWAP, volume histogram (bottom
 *    18%), forecast cone band (SVG overlay) + per-member median lines, and
 *    reference price lines for strike / BE / ±1σ
 *  - Stacked RSI / MACD / SMI sub-panes, each with its own header strip
 *    (uppercase label · parameter · color-legend), synced time scale and
 *    crosshair with the price pane
 *  - Bottom forecast readout only when the crosshair is in the projection
 *    band (otherwise the top strip carries all needed info)
 */
export function UnderlyingAnalysisCard({
  result,
  timeframe,
  onTimeframeChange,
  loading,
}: Props) {
  const chart = result.chart;
  if (!chart) {
    return (
      <div className="rounded-md border border-border bg-bg overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60 bg-surface">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Underlying analysis
          </span>
        </div>
        <div className="h-[200px] flex items-center justify-center text-[11px] text-text-muted">
          Indicator data unavailable — backend may need a restart.
        </div>
      </div>
    );
  }
  const tfs = chart.supported_timeframes;

  // Forecast horizon picker — drives the projection cone.
  const fe = result.forecast_ensemble;
  const availableHorizons = useMemo(
    () =>
      fe
        ? Object.keys(fe.ensemble.horizons)
            .map((s) => Number(s))
            .sort((a, b) => a - b)
        : [],
    [fe],
  );
  const [coneHorizon, setConeHorizon] = useState<number>(5);
  useEffect(() => {
    if (availableHorizons.length > 0 && !availableHorizons.includes(coneHorizon)) {
      setConeHorizon(availableHorizons[Math.min(1, availableHorizons.length - 1)]);
    }
  }, [availableHorizons, coneHorizon]);

  const activeEnsemble = fe?.ensemble.horizons[String(coneHorizon)] ?? null;
  const fc = activeEnsemble ?? result.forecast;

  // Hover state lifted up so the top OHLCV strip and bottom forecast readout
  // can both read the same crosshair-driven index.
  const [hover, setHover] = useState<HoverState | null>(null);

  // Header display: hovered bar OHLCV when crosshair is in history, else
  // the last bar. Computed from the underlying-chart bars, not the analyzer
  // page's `spot` (which can lag the candle close by a tick).
  const lastBar = chart.bars[chart.bars.length - 1];
  const headerDisplay = useMemo(() => {
    if (!lastBar) return null;
    const idx = hover?.barIdx ?? chart.bars.length - 1;
    const b = chart.bars[idx];
    if (!b) return null;
    const prev = idx > 0 ? chart.bars[idx - 1] : null;
    const ref = prev ? prev.close : b.open;
    const chg = b.close - ref;
    const chgPct = ref !== 0 ? (chg / ref) * 100 : 0;
    return {
      time: b.time,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
      chg,
      chgPct,
    };
  }, [hover, chart.bars, lastBar]);

  const positive = (headerDisplay?.chg ?? 0) >= 0;
  const symbolLabel = result.symbol;

  return (
    <div
      className="flex flex-col rounded-md border border-border bg-surface overflow-hidden shrink-0"
      style={{ minHeight: 760 }}
    >
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60 bg-surface">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Underlying
        </span>
        <span className="ml-auto flex items-center gap-3">
          <ControlGroup label="TF">
            <TimeframePills
              value={timeframe}
              options={tfs}
              onChange={onTimeframeChange}
              disabled={loading}
            />
          </ControlGroup>
          {fe && availableHorizons.length > 0 && (
            <ControlGroup label="Forecast">
              <ForecastHorizonPicker
                horizons={availableHorizons}
                selected={coneHorizon}
                onSelect={setConeHorizon}
                data={fe.ensemble.horizons}
                agreement={fe.agreement}
              />
            </ControlGroup>
          )}
        </span>
      </div>

      {chart.bars.length < 5 ? (
        <div className="h-[300px] flex items-center justify-center text-[11px] text-text-muted">
          Not enough data for {timeframe} bars yet.
        </div>
      ) : (
        <>
          {/* TradingChart-style OHLCV header strip. Hover-driven; falls
              back to the last bar on pointer-leave. */}
          <div className="flex items-center gap-3 md:gap-5 px-3 min-h-10 py-1 border-b border-border/60 bg-surface shrink-0 flex-wrap">
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-sm text-text-primary tracking-tight">
                {symbolLabel}
              </span>
              {headerDisplay && (
                <span className="text-base tabular font-medium text-text-primary">
                  {fmt(headerDisplay.c)}
                </span>
              )}
              {headerDisplay && (
                <span
                  className={cn(
                    "text-[11px] tabular leading-none px-1.5 py-0.5 rounded",
                    positive ? "text-up bg-up/10" : "text-down bg-down/10",
                  )}
                >
                  {positive ? "+" : ""}
                  {fmt(headerDisplay.chg)} ·{" "}
                  {headerDisplay.chgPct >= 0 ? "+" : ""}
                  {headerDisplay.chgPct.toFixed(2)}%
                </span>
              )}
              {hover?.barIdx != null && headerDisplay && (
                <span className="text-[10px] tabular text-text-muted ml-1">
                  {formatBarTime(headerDisplay.time, timeframe)}
                </span>
              )}
            </div>
            {headerDisplay && (
              <div className="hidden md:flex items-center gap-3 text-[10px] uppercase tracking-wider text-text-muted">
                <span>O <OhlcVal n={headerDisplay.o} /></span>
                <span>H <OhlcVal n={headerDisplay.h} tone="up" /></span>
                <span>L <OhlcVal n={headerDisplay.l} tone="down" /></span>
                <span>C <OhlcVal n={headerDisplay.c} /></span>
                <span>V <OhlcVal n={headerDisplay.v} compact /></span>
              </div>
            )}
          </div>

          <PaneStack
            chart={chart}
            forecast={fc}
            ensemble={fe}
            coneHorizon={coneHorizon}
            strike={result.strike}
            breakeven={result.breakeven}
            sigma1Low={result.sigma_ranges.sigma1_low}
            sigma1High={result.sigma_ranges.sigma1_high}
            chartTimeframe={timeframe}
            onHoverChange={setHover}
            hover={hover}
            spot={result.spot}
            symbolWatermark={symbolLabel}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaneStack — the four stacked lightweight-charts panes + the forecast cone
// SVG band + the synced hover readout.
// ---------------------------------------------------------------------------

interface PaneStackProps {
  chart: OptionAnalyzeResult["chart"];
  forecast: {
    median: number[];
    p10: number[];
    p90: number[];
    expected_return_pct: number;
    band_pct: number;
  } | null;
  ensemble: OptionAnalyzeResult["forecast_ensemble"];
  coneHorizon: number;
  strike: number;
  breakeven: number;
  sigma1Low: number | null;
  sigma1High: number | null;
  chartTimeframe: OptionAnalyzerTimeframe;
  spot: number;
  onHoverChange: (h: HoverState | null) => void;
  hover: HoverState | null;
  symbolWatermark: string;
}

interface HoverState {
  time: number;
  barIdx: number | null;
  fcStep: number | null;
}

function PaneStack({
  chart,
  forecast,
  ensemble,
  coneHorizon,
  strike,
  breakeven,
  sigma1Low,
  sigma1High,
  chartTimeframe,
  spot,
  onHoverChange,
  hover,
  symbolWatermark,
}: PaneStackProps) {
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);
  const smiContainerRef = useRef<HTMLDivElement>(null);
  const coneOverlayRef = useRef<HTMLDivElement>(null);

  const priceChartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  const smiChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const memberSeriesRef = useRef<Record<MemberKey, ISeriesApi<"Line"> | null>>({
    chronos: null,
    momentum: null,
    mean_reversion: null,
    martingale: null,
  });
  const refLinesRef = useRef<IPriceLine[]>([]);

  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const smiLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const smiSignalRef = useRef<ISeriesApi<"Line"> | null>(null);

  const disposedRef = useRef(false);
  // Surface lightweight-charts init failures so the user doesn't see
  // a silent empty 560px area when something goes wrong on mount.
  const [initError, setInitError] = useState<string | null>(null);

  // Executed trades for this underlying, rendered as arrow markers on the
  // candle series — same hook + popover the main TradingChart uses, so
  // option/stock trades on `symbolWatermark` (the underlying ticker) line
  // up on the analyzer's price pane too. Click a marker to journal it.
  const tradeMarkers = useTradeMarkers({
    candleSeries: candleSeriesRef,
    symbol: symbolWatermark,
    enabled: true,
    bars: chart.bars,
  });
  const [activePopover, setActivePopover] = useState<{
    trades: TradeHistoryRecord[];
    anchor: { x: number; y: number };
  } | null>(null);

  const barIndexByTime = useMemo(() => {
    const m = new Map<number, number>();
    chart.bars.forEach((b, i) => m.set(b.time, i));
    return m;
  }, [chart.bars]);

  const futureTimes = useMemo(() => {
    if (!forecast || forecast.median.length === 0 || chart.bars.length === 0) return [];
    const last = chart.bars[chart.bars.length - 1].time;
    const out: number[] = [];
    let cursor = last;
    const stepSec = inferBarStepSeconds(chart.bars, chartTimeframe);
    for (let i = 0; i < forecast.median.length; i++) {
      if (chartTimeframe === "1d") {
        const d = new Date((cursor + 86400) * 1000);
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
          d.setUTCDate(d.getUTCDate() + 1);
        }
        cursor = Math.floor(d.getTime() / 1000);
      } else {
        cursor = cursor + stepSec;
      }
      out.push(cursor);
    }
    return out;
  }, [forecast, chart.bars, chartTimeframe]);

  // ── init charts on mount ────────────────────────────────────────────────
  useEffect(() => {
    disposedRef.current = false;
    const priceEl = priceContainerRef.current;
    const rsiEl = rsiContainerRef.current;
    const macdEl = macdContainerRef.current;
    const smiEl = smiContainerRef.current;
    if (!priceEl || !rsiEl || !macdEl || !smiEl) {
      setInitError("chart container refs not mounted");
      return;
    }
    // The price pane now has `shrink-0 style={height:400}` so the
    // container is guaranteed to be 400×W at mount. ResizeObserver
    // below catches subsequent dimension changes (window resize, sidebar
    // toggle, etc.) and updates chart dimensions via applyOptions.
    setInitError(null);

    try {

    const baseOpts = baseChartOptions();
    const subpaneOpts = {
      ...baseOpts,
      rightPriceScale: {
        ...baseOpts.rightPriceScale,
        scaleMargins: { top: 0.18, bottom: 0.12 },
      },
    };

    const priceChart = createChart(priceEl, {
      ...baseOpts,
      width: priceEl.clientWidth,
      height: priceEl.clientHeight,
      rightPriceScale: {
        ...baseOpts.rightPriceScale,
        // Leave bottom 18% for the volume histogram on its own scale.
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
    });
    priceChartRef.current = priceChart;

    const rsiChart = createChart(rsiEl, {
      ...subpaneOpts,
      width: rsiEl.clientWidth,
      height: rsiEl.clientHeight,
      timeScale: { ...subpaneOpts.timeScale, visible: false },
    });
    rsiChartRef.current = rsiChart;

    const macdChart = createChart(macdEl, {
      ...subpaneOpts,
      width: macdEl.clientWidth,
      height: macdEl.clientHeight,
      timeScale: { ...subpaneOpts.timeScale, visible: false },
    });
    macdChartRef.current = macdChart;

    const smiChart = createChart(smiEl, {
      ...subpaneOpts,
      width: smiEl.clientWidth,
      height: smiEl.clientHeight,
    });
    smiChartRef.current = smiChart;

    // ── price-pane series ────────────────────────────────────────────────
    candleSeriesRef.current = priceChart.addCandlestickSeries({
      upColor: CHART.candle.up,
      downColor: CHART.candle.down,
      borderUpColor: CHART.candle.up,
      borderDownColor: CHART.candle.down,
      wickUpColor: CHART.candle.up,
      wickDownColor: CHART.candle.down,
      priceLineColor: CHART.axis,
      priceLineStyle: LineStyle.Dotted,
    });

    // Volume histogram on its own scale, parked at the bottom of the pane.
    volSeriesRef.current = priceChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    priceChart
      .priceScale("volume")
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    ema9SeriesRef.current = priceChart.addLineSeries({
      color: CHART.ema.fast,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ema21SeriesRef.current = priceChart.addLineSeries({
      color: CHART.ema.slow,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    vwapSeriesRef.current = priceChart.addLineSeries({
      color: CHART.vwap,
      lineWidth: 1,
      lineStyle: LineStyle.LargeDashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // ── forecast series ──────────────────────────────────────────────────
    for (const k of MEMBER_KEYS) {
      memberSeriesRef.current[k] = priceChart.addLineSeries({
        color: MEMBER_COLORS[k],
        lineWidth: k === "martingale" ? 1 : 2,
        lineStyle: k === "martingale" ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
      });
    }
    // p10/p90 lines intentionally NOT drawn as separate series — the
    // gradient band on the SVG overlay defines the cone edges by itself.
    // Drawing them as dashed cyan lines on top made the projection look
    // noisy and competed with the per-member colored lines.

    // ── subpane series ───────────────────────────────────────────────────
    rsiSeriesRef.current = rsiChart.addLineSeries({
      color: CHART.rsi,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    rsiSeriesRef.current.createPriceLine({
      price: 70, color: CHART.down, lineWidth: 1,
      lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "70",
    });
    rsiSeriesRef.current.createPriceLine({
      price: 30, color: CHART.up, lineWidth: 1,
      lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "30",
    });
    rsiSeriesRef.current.createPriceLine({
      price: 50, color: CHART.axis, lineWidth: 1,
      lineStyle: LineStyle.Solid, axisLabelVisible: false,
    });

    macdLineRef.current = macdChart.addLineSeries({
      color: CHART.macd.line, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: true,
    });
    macdSignalRef.current = macdChart.addLineSeries({
      color: CHART.macd.signal, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
    });
    macdHistRef.current = macdChart.addHistogramSeries({
      priceFormat: { type: "price", precision: 3, minMove: 0.001 },
      priceLineVisible: false, lastValueVisible: false,
    });

    smiLineRef.current = smiChart.addLineSeries({
      color: CHART.smi.line, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: true,
    });
    smiSignalRef.current = smiChart.addLineSeries({
      color: CHART.smi.signal, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
    });
    smiLineRef.current.createPriceLine({
      price: 40, color: CHART.down, lineWidth: 1,
      lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "+40",
    });
    smiLineRef.current.createPriceLine({
      price: -40, color: CHART.up, lineWidth: 1,
      lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "-40",
    });
    smiLineRef.current.createPriceLine({
      price: 0, color: CHART.axis, lineWidth: 1,
      lineStyle: LineStyle.Solid, axisLabelVisible: false,
    });

    // ── sync time-scale across panes ─────────────────────────────────────
    let syncing = false;
    const syncRange = (driver: IChartApi) => (range: LogicalRange | null) => {
      if (syncing || !range || disposedRef.current) return;
      syncing = true;
      try {
        for (const c of [priceChart, rsiChart, macdChart, smiChart]) {
          if (c !== driver) c.timeScale().setVisibleLogicalRange(range);
        }
      } finally {
        syncing = false;
      }
    };
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(priceChart));
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(rsiChart));
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(macdChart));
    smiChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(smiChart));

    // ── sync crosshair across panes ──────────────────────────────────────
    const moveOthers = (
      others: { chart: IChartApi; series: ISeriesApi<any> }[],
      time: any,
    ) => {
      if (disposedRef.current) return;
      for (const { chart: c, series } of others) {
        try {
          if (time == null) c.clearCrosshairPosition();
          else c.setCrosshairPosition(NaN, time, series);
        } catch { /* */ }
      }
    };

    priceChart.subscribeCrosshairMove((p: MouseEventParams) => {
      const t = p.time as number | undefined;
      moveOthers(
        [
          { chart: rsiChart, series: rsiSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
          { chart: smiChart, series: smiLineRef.current! },
        ],
        t,
      );
      if (t == null) { onHoverChange(null); return; }
      const histIdx = barIndexByTime.get(t);
      if (histIdx != null) onHoverChange({ time: t, barIdx: histIdx, fcStep: null });
      else {
        const fcStep = futureTimes.indexOf(t);
        if (fcStep >= 0) onHoverChange({ time: t, barIdx: null, fcStep });
        else onHoverChange(null);
      }
    });
    rsiChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
          { chart: smiChart, series: smiLineRef.current! },
        ],
        p.time,
      ),
    );
    macdChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: rsiChart, series: rsiSeriesRef.current! },
          { chart: smiChart, series: smiLineRef.current! },
        ],
        p.time,
      ),
    );
    smiChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: rsiChart, series: rsiSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
        ],
        p.time,
      ),
    );

    // ── resize ───────────────────────────────────────────────────────────
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (disposedRef.current) return;
        for (const [c, el] of [
          [priceChart, priceEl],
          [rsiChart, rsiEl],
          [macdChart, macdEl],
          [smiChart, smiEl],
        ] as const) {
          try {
            c.applyOptions({ width: el.clientWidth, height: el.clientHeight });
          } catch { /* */ }
        }
      });
    });
    ro.observe(priceEl);
    ro.observe(rsiEl);
    ro.observe(macdEl);
    ro.observe(smiEl);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
      ema9SeriesRef.current = null;
      ema21SeriesRef.current = null;
      vwapSeriesRef.current = null;
      for (const k of MEMBER_KEYS) memberSeriesRef.current[k] = null;
      rsiSeriesRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      smiLineRef.current = null;
      smiSignalRef.current = null;
      refLinesRef.current = [];
      priceChartRef.current = null;
      rsiChartRef.current = null;
      macdChartRef.current = null;
      smiChartRef.current = null;
      try { priceChart.remove(); } catch { /* */ }
      try { rsiChart.remove(); } catch { /* */ }
      try { macdChart.remove(); } catch { /* */ }
      try { smiChart.remove(); } catch { /* */ }
    };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[UnderlyingAnalysisCard] chart init failed:", err);
      setInitError(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── set data on price + indicators when bars change ───────────────────
  useEffect(() => {
    if (disposedRef.current || !candleSeriesRef.current) return;

    const bars = chart.bars;
    const candleData: CandlestickData[] = bars.map((b) => ({
      time: b.time as UTCTimestamp,
      open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    candleSeriesRef.current.setData(candleData);

    // Volume — fade the bars to ~30% so they don't drown the candles.
    volSeriesRef.current?.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color:
          b.close >= b.open
            ? `${CHART.candle.up}4d` // hex+alpha (~30%)
            : `${CHART.candle.down}4d`,
      })) as HistogramData[],
    );

    ema9SeriesRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.ema9[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    ema21SeriesRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.ema21[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    vwapSeriesRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.vwap[i] }))
        .filter((d) => Number.isFinite(d.value) && d.value > 0) as LineData[],
    );

    const start = Math.max(0, bars.length - VISIBLE_BARS_DEFAULT);
    if (bars.length > 1 && priceChartRef.current) {
      priceChartRef.current.timeScale().setVisibleLogicalRange({
        from: start - 0.5,
        to: bars.length - 0.5 + (futureTimes.length || 0),
      });
    }
  }, [chart, futureTimes.length]);

  useEffect(() => {
    if (disposedRef.current) return;
    const bars = chart.bars;

    rsiSeriesRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.rsi[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdLineRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.macd[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdSignalRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.macd_signal[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdHistRef.current?.setData(
      bars
        .map((b, i) => ({
          time: b.time as UTCTimestamp,
          value: chart.macd_hist[i],
          color: chart.macd_hist[i] >= 0 ? CHART.macd.histUp : CHART.macd.histDown,
        }))
        .filter((d) => Number.isFinite(d.value)) as HistogramData[],
    );
    smiLineRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.smi[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    smiSignalRef.current?.setData(
      bars
        .map((b, i) => ({ time: b.time as UTCTimestamp, value: chart.smi_signal[i] }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
  }, [chart]);

  // Reference lines.
  useEffect(() => {
    if (disposedRef.current || !candleSeriesRef.current) return;
    for (const pl of refLinesRef.current) {
      try { candleSeriesRef.current.removePriceLine(pl); } catch { /* */ }
    }
    refLinesRef.current = [];

    refLinesRef.current.push(
      candleSeriesRef.current.createPriceLine({
        price: strike, color: CHART.ref.strike, lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `K ${strike}`,
      }),
    );
    refLinesRef.current.push(
      candleSeriesRef.current.createPriceLine({
        price: breakeven, color: CHART.ref.be, lineWidth: 1,
        lineStyle: LineStyle.Dotted, axisLabelVisible: true,
        title: `BE ${breakeven.toFixed(2)}`,
      }),
    );
    if (sigma1High != null) {
      refLinesRef.current.push(
        candleSeriesRef.current.createPriceLine({
          price: sigma1High, color: CHART.ref.sigma, lineWidth: 1,
          lineStyle: LineStyle.SparseDotted, axisLabelVisible: false, title: "+1σ",
        }),
      );
    }
    if (sigma1Low != null) {
      refLinesRef.current.push(
        candleSeriesRef.current.createPriceLine({
          price: sigma1Low, color: CHART.ref.sigma, lineWidth: 1,
          lineStyle: LineStyle.SparseDotted, axisLabelVisible: false, title: "−1σ",
        }),
      );
    }
  }, [strike, breakeven, sigma1Low, sigma1High]);

  // Forecast cone series.
  useEffect(() => {
    if (disposedRef.current) return;
    const lastBar = chart.bars[chart.bars.length - 1];
    if (!lastBar) return;
    const lastClose = lastBar.close;
    const lastTime = lastBar.time as UTCTimestamp;

    // p10/p90 ribbon is drawn by the SVG overlay (gradient band).

    if (ensemble && futureTimes.length > 0) {
      for (const k of MEMBER_KEYS) {
        const horizons = ensemble.members[k]?.horizons[String(coneHorizon)];
        const series = memberSeriesRef.current[k];
        if (!series) continue;
        if (!horizons || horizons.median.length !== futureTimes.length) {
          series.setData([]);
          continue;
        }
        series.setData([
          { time: lastTime, value: lastClose } as LineData,
          ...horizons.median.map((v, i) => ({
            time: futureTimes[i] as UTCTimestamp, value: v,
          })),
        ]);
      }
    } else {
      for (const k of MEMBER_KEYS) memberSeriesRef.current[k]?.setData([]);
    }
  }, [forecast, ensemble, coneHorizon, futureTimes, chart.bars]);

  // Forecast cone fill (SVG overlay).
  useEffect(() => {
    if (disposedRef.current) return;
    const chartApi = priceChartRef.current;
    const series = candleSeriesRef.current;
    const overlayEl = coneOverlayRef.current;
    if (!chartApi || !series || !overlayEl) return;
    if (!forecast || forecast.median.length === 0 || futureTimes.length === 0) {
      overlayEl.innerHTML = "";
      return;
    }

    const draw = () => {
      if (disposedRef.current) return;
      const w = overlayEl.clientWidth;
      const h = overlayEl.clientHeight;
      const lastBar = chart.bars[chart.bars.length - 1];
      if (!lastBar) return;
      const ts = chartApi.timeScale();

      const points: { x: number | null; yHi: number | null; yLo: number | null }[] = [];
      points.push({
        x: ts.timeToCoordinate(lastBar.time as UTCTimestamp),
        yHi: series.priceToCoordinate(lastBar.close),
        yLo: series.priceToCoordinate(lastBar.close),
      });
      for (let i = 0; i < futureTimes.length; i++) {
        points.push({
          x: ts.timeToCoordinate(futureTimes[i] as UTCTimestamp),
          yHi: series.priceToCoordinate(forecast.p90[i]),
          yLo: series.priceToCoordinate(forecast.p10[i]),
        });
      }
      const valid = points.every((p) => p.x != null && p.yHi != null && p.yLo != null);
      if (!valid) { overlayEl.innerHTML = ""; return; }

      // Band path — p90 along the top, p10 back to the anchor.
      const topPath = points.map((p, i) =>
        `${i === 0 ? "M" : "L"}${p.x!.toFixed(2)},${p.yHi!.toFixed(2)}`,
      ).join(" ");
      const bottomPath = points.slice().reverse().map((p) =>
        `L${p.x!.toFixed(2)},${p.yLo!.toFixed(2)}`,
      ).join(" ");

      const xAnchor = points[0].x!;
      const yAnchor = points[0].yHi!;
      const xRight = points[points.length - 1].x!;

      // Per-member terminal labels at the right edge. Vertically de-overlap
      // so cluster labels stay readable. Skip if priceToCoordinate fails
      // (point off-screen due to extreme price).
      interface TermLabel {
        key: MemberKey;
        label: string;
        color: string;
        pct: number;
        y: number;
        opacity: number;
      }
      const memberTerminals: TermLabel[] = ensemble && futureTimes.length > 0
        ? (["chronos", "momentum", "mean_reversion", "martingale"] as const)
            .map((k): TermLabel | null => {
              const horizons = ensemble.members[k]?.horizons[String(coneHorizon)];
              if (!horizons || horizons.median.length === 0) return null;
              const lastV = horizons.median[horizons.median.length - 1];
              const yC = series.priceToCoordinate(lastV);
              if (yC == null) return null;
              return {
                key: k,
                label: MEMBER_LABELS[k],
                color: MEMBER_COLORS[k],
                pct: horizons.expected_return_pct,
                y: Number(yC),
                opacity: k === "martingale" ? 0.55 : 0.95,
              };
            })
            .filter((m): m is TermLabel => m != null)
            .sort((a, b) => a.y - b.y)
        : [];
      // Greedy push-down to break overlaps.
      const minSpacing = 11;
      for (let i = 1; i < memberTerminals.length; i++) {
        if (memberTerminals[i].y - memberTerminals[i - 1].y < minSpacing) {
          memberTerminals[i].y = memberTerminals[i - 1].y + minSpacing;
        }
      }

      const labelsSvg = memberTerminals.map((m) => `
        <text x="${(xRight - 2).toFixed(2)}" y="${(m.y + 3).toFixed(2)}"
              font-size="8.5" fill="${m.color}" text-anchor="end"
              font-weight="500" opacity="${m.opacity}"
              style="font-variant-numeric: tabular-nums;">
          ${m.label} ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(1)}%
        </text>`).join("");

      // Horizon hint at top-right of cone area.
      const horizonLabel = futureTimes.length > 0 ? `
        <text x="${(xRight - 2).toFixed(2)}" y="14"
              font-size="9" fill="${CHART.forecast.cone}" text-anchor="end"
              font-weight="600"
              style="font-variant-numeric: tabular-nums;">
          +${futureTimes.length}d horizon
        </text>` : "";

      // No-change reference — horizontal dotted line at last close,
      // extending across the projection band only. Makes each member's
      // direction legible at a glance: above this line = predicts up.
      const noChangeRef = `
        <line x1="${xAnchor.toFixed(2)}" x2="${xRight.toFixed(2)}"
              y1="${yAnchor.toFixed(2)}" y2="${yAnchor.toFixed(2)}"
              stroke="${CHART.axisText}" stroke-opacity="0.45"
              stroke-width="1" stroke-dasharray="2 3" />`;

      overlayEl.innerHTML = `
        <svg width="${w}" height="${h}" style="position:absolute;inset:0;pointer-events:none;overflow:hidden;">
          <defs>
            <linearGradient id="forecast-cone-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="${CHART.forecast.cone}" stop-opacity="0.05" />
              <stop offset="100%" stop-color="${CHART.forecast.cone}" stop-opacity="0.24" />
            </linearGradient>
          </defs>
          <path d="${topPath} ${bottomPath} Z" fill="url(#forecast-cone-grad)" stroke="none" />
          ${noChangeRef}
          <!-- last-close anchor: halo + dot, signals "the cone emanates from HERE" -->
          <circle cx="${xAnchor.toFixed(2)}" cy="${yAnchor.toFixed(2)}" r="4.5"
                  fill="${CHART.text}" fill-opacity="0.18" />
          <circle cx="${xAnchor.toFixed(2)}" cy="${yAnchor.toFixed(2)}" r="2.5"
                  fill="${CHART.text}" />
          ${labelsSvg}
          ${horizonLabel}
        </svg>
      `;
    };

    draw();
    const ts = chartApi.timeScale();
    const ro = new ResizeObserver(draw);
    ro.observe(overlayEl);
    const unsub = ts.subscribeVisibleTimeRangeChange(draw);
    return () => {
      ro.disconnect();
      try { ts.unsubscribeVisibleTimeRangeChange(draw); } catch { /* */ }
      void unsub;
    };
  }, [forecast, futureTimes, chart.bars, ensemble, coneHorizon]);

  // Trade-marker clicks → open the journal popover for the bucket of trades
  // on the clicked bar. lightweight-charts doesn't tell us "you hit a
  // marker", so we map the click time back through the hook's bucket index.
  useEffect(() => {
    const chartApi = priceChartRef.current;
    if (!chartApi) return;
    const handler = (param: MouseEventParams) => {
      if (param.time == null || !param.point) return;
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
    chartApi.subscribeClick(handler);
    return () => {
      try { chartApi.unsubscribeClick(handler); } catch { /* */ }
    };
  }, [tradeMarkers.bucketAt]);

  // Drop the popover when the underlying changes — its trades no longer apply.
  useEffect(() => {
    setActivePopover(null);
  }, [symbolWatermark]);

  return (
    <>
      {/* ── Price pane — dominant, with symbol watermark behind the
            candles (mirrors the main TradingChart's chart-canvas region).
            Height reduced from 560 → 400 so the analyzer page doesn't
            scroll forever — the three subpanes already add 300+ px of
            indicator context below. */}
      <div className="relative bg-bg border-t border-border shrink-0" style={{ height: 400 }}>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-0">
          <span className="text-[88px] font-medium text-text-muted/[0.04] tracking-[0.2em]">
            {symbolWatermark}
          </span>
        </div>
        <div ref={priceContainerRef} className="absolute inset-0 z-10" />
        <div ref={coneOverlayRef} className="pointer-events-none absolute inset-0 z-20" />
        {/* Trade-marker badge — count of this underlying's executions pinned
            on the timeline. Off-range trades (outside the loaded bars) are
            fetched but can't render, so we distinguish the two states. */}
        {(tradeMarkers.renderedCount > 0 || tradeMarkers.trades.length > 0) && (
          <div
            className={cn(
              "absolute top-2 left-2 z-20 inline-flex items-center gap-1 h-5 px-1.5 rounded-sm border text-[10px] tabular pointer-events-none",
              tradeMarkers.renderedCount > 0
                ? "border-up/30 bg-up/10 text-up"
                : "border-warning/30 bg-warning/10 text-warning",
            )}
            title={`${tradeMarkers.trades.length} trade(s) on ${symbolWatermark}; ${tradeMarkers.renderedCount} pinned in the loaded range. Click a marker to journal.`}
          >
            {tradeMarkers.renderedCount > 0
              ? `${tradeMarkers.renderedCount} trade${tradeMarkers.renderedCount > 1 ? "s" : ""}`
              : `${tradeMarkers.trades.length} off-range`}
          </div>
        )}
        {activePopover && priceContainerRef.current && (
          <TradeMarkerPopover
            trades={activePopover.trades}
            anchor={activePopover.anchor}
            container={{
              width: priceContainerRef.current.clientWidth,
              height: priceContainerRef.current.clientHeight,
            }}
            onClose={() => setActivePopover(null)}
            onSaved={() => tradeMarkers.refresh()}
          />
        )}
        {initError && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-sm p-4">
            <div className="max-w-md text-center">
              <div className="text-down text-[11px] uppercase tracking-wider font-semibold mb-1">
                chart failed to initialize
              </div>
              <div className="text-text-secondary text-[11px] tabular">
                {initError}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Subpanes — each block mirrors the SMI subpane in TradingChart:
            border-t, bg-bg, h-6 header strip with label · params · legend,
            chart canvas below. Same look across all three sub-panes. */}
      <Subpane
        label="RSI"
        params="14"
        legend={[{ color: CHART.rsi, label: "rsi" }]}
        rightTone={tonedLast(chart.rsi, 70, 30)}
        containerRef={rsiContainerRef}
      />
      <Subpane
        label="MACD"
        params="12 · 26 · 9"
        legend={[
          { color: CHART.macd.line, label: "macd" },
          { color: CHART.macd.signal, label: "signal" },
        ]}
        rightTone={tonedDelta(
          chart.macd[chart.macd.length - 1],
          chart.macd_signal[chart.macd_signal.length - 1],
        )}
        containerRef={macdContainerRef}
      />
      <Subpane
        label="SMI"
        params="13 · 25 · 2"
        legend={[
          { color: CHART.smi.line, label: "smi" },
          { color: CHART.smi.signal, label: "signal" },
        ]}
        rightTone={tonedLast(chart.smi, 40, -40)}
        containerRef={smiContainerRef}
      />

      {hover?.fcStep != null && forecast && (
        <ForecastReadout
          fcStep={hover.fcStep}
          forecast={forecast}
          ensemble={ensemble}
          coneHorizon={coneHorizon}
          futureTimes={futureTimes}
          spot={spot}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Subpane — verbatim copy of the SMI subpane block in TradingChart so the
// analyzer's RSI / MACD / SMI panes read as part of the same family.
// ---------------------------------------------------------------------------
function Subpane({
  label,
  params,
  legend,
  rightTone,
  containerRef,
}: {
  label: string;
  params: string;
  legend: { color: string; label: string }[];
  rightTone?: { value: string; cls: string } | null;
  containerRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="border-t border-border bg-bg shrink-0" style={{ height: 140 }}>
      <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="text-[10px] tabular text-text-muted">{params}</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] tabular text-text-muted">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1">
              <span
                className="w-2 h-0.5 inline-block"
                style={{ backgroundColor: l.color }}
              />
              {l.label}
            </span>
          ))}
          {rightTone && (
            <span className={cn("font-medium tabular", rightTone.cls)}>
              {rightTone.value}
            </span>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full h-[114px]" />
    </div>
  );
}

function tonedLast(series: number[], hi: number, lo: number) {
  const v = series[series.length - 1];
  if (!Number.isFinite(v)) return null;
  const cls = v >= hi ? "text-down" : v <= lo ? "text-up" : "text-text-secondary";
  return { value: v.toFixed(0), cls };
}
function tonedDelta(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = a - b;
  return {
    value: `${a.toFixed(2)} / ${b.toFixed(2)}`,
    cls: d >= 0 ? "text-up" : "text-down",
  };
}

// ---------------------------------------------------------------------------
// Top OHLCV value cell — matches TradingChart's `<Val>`.
// ---------------------------------------------------------------------------
function OhlcVal({
  n,
  tone,
  compact,
}: {
  n: number;
  tone?: "up" | "down";
  compact?: boolean;
}) {
  const cls =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-secondary";
  return (
    <span className={cn("normal-case tracking-normal text-[11px] tabular", cls)}>
      {compact ? fmtCompact(n) : fmt(n)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Forecast readout — only shown when crosshair is in the projection band.
// ---------------------------------------------------------------------------
function ForecastReadout({
  fcStep,
  forecast,
  ensemble,
  coneHorizon,
  futureTimes,
  spot,
}: {
  fcStep: number;
  forecast: PaneStackProps["forecast"];
  ensemble: PaneStackProps["ensemble"];
  coneHorizon: number;
  futureTimes: number[];
  spot: number;
}) {
  if (!forecast) return null;
  const med = forecast.median[fcStep];
  const p10 = forecast.p10[fcStep];
  const p90 = forecast.p90[fcStep];
  if (med == null) return null;
  const projTime = futureTimes[fcStep];
  const dayOffset = fcStep + 1;
  const pctFromSpot = ((med - spot) / spot) * 100;
  const pctTone =
    pctFromSpot >= 0.1 ? "text-up" : pctFromSpot <= -0.1 ? "text-down" : "text-text-muted";
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/60 bg-surface text-[10px] tabular text-text-secondary flex-wrap">
      <span
        className="text-[9px] uppercase tracking-wider font-medium"
        style={{ color: CHART.forecast.cone }}
      >
        forecast +{dayOffset}d · {formatBarTime(projTime, "1d")}
      </span>
      <span>
        ensemble <span className="text-text-primary font-medium">${med.toFixed(2)}</span>
      </span>
      <span>
        band <span className="text-text-primary">${p10.toFixed(2)}</span>
        {" – "}
        <span className="text-text-primary">${p90.toFixed(2)}</span>
      </span>
      {ensemble && MEMBER_KEYS.map((k) => {
        const v = ensemble.members[k]?.horizons[String(coneHorizon)]?.median[fcStep];
        if (v == null) return null;
        return (
          <span key={k} style={{ color: MEMBER_COLORS[k] }}>
            {MEMBER_LABELS[k]} <span className="text-text-primary">${v.toFixed(2)}</span>
          </span>
        );
      })}
      <span className={cn(pctTone, "ml-auto font-medium")}>
        vs spot {pctFromSpot >= 0 ? "+" : ""}
        {pctFromSpot.toFixed(2)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBarTime(epoch: number, tf: OptionAnalyzerTimeframe): string {
  const d = new Date(epoch * 1000);
  if (tf === "1d") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function inferBarStepSeconds(
  bars: OptionAnalyzeResult["chart"]["bars"],
  tf: OptionAnalyzerTimeframe,
): number {
  const TF_MAP: Record<string, number> = {
    "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400,
    "1d": 86400, "1w": 604800,
  };
  if (TF_MAP[tf]) return TF_MAP[tf];
  if (bars.length >= 2) return bars[bars.length - 1].time - bars[bars.length - 2].time;
  return 86400;
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function TimeframePills({
  value,
  options,
  onChange,
  disabled,
}: {
  value: OptionAnalyzerTimeframe;
  options: OptionAnalyzerTimeframe[];
  onChange: (tf: OptionAnalyzerTimeframe) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-6 rounded-md border border-border overflow-hidden tabular">
      {options.map((tf, i) => (
        <button
          key={tf}
          onClick={() => !disabled && onChange(tf)}
          disabled={disabled}
          className={cn(
            "px-2 text-[10px] font-medium transition-colors",
            i > 0 && "border-l border-border",
            value === tf
              ? "bg-accent/15 text-accent"
              : "text-text-muted hover:bg-surface-2",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}

function ForecastHorizonPicker({
  horizons,
  selected,
  onSelect,
  data,
  agreement,
}: {
  horizons: number[];
  selected: number;
  onSelect: (h: number) => void;
  data: Record<string, { expected_return_pct: number; band_pct: number }>;
  agreement: Record<string, number>;
}) {
  return (
    <div className="flex h-6 rounded-md border border-border overflow-hidden tabular">
      {horizons.map((h, i) => {
        const hf = data[String(h)];
        const er = hf?.expected_return_pct ?? 0;
        const band = hf?.band_pct ?? 0;
        const agree = agreement[String(h)] ?? 1;
        const dir = er >= 0.5 ? "up" : er <= -0.5 ? "down" : "neutral";
        const isSel = selected === h;
        return (
          <button
            key={h}
            onClick={() => onSelect(h)}
            className={cn(
              "px-2 text-[9px] transition-colors flex items-center gap-1",
              i > 0 && "border-l border-border",
              isSel ? "bg-accent/15" : "hover:bg-surface-2",
            )}
            title={`${h}d: median ${er >= 0 ? "+" : ""}${er.toFixed(2)}%, ±${band.toFixed(1)}% band, ${(agree * 100).toFixed(0)}% agreement`}
          >
            <span className={cn("font-medium", isSel ? "text-accent" : "text-text-muted")}>
              {h}d
            </span>
            <span
              className={cn(
                "tabular",
                dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-text-muted",
              )}
            >
              {er >= 0 ? "+" : ""}
              {er.toFixed(1)}%
            </span>
          </button>
        );
      })}
    </div>
  );
}
