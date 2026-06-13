"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickData,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  LineStyle,
  LogicalRange,
  MouseEventParams,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { cn, fmt, fmtCompact } from "@/lib/utils";
import { HintLabel } from "@/components/ui/info-icon";
import { CHART, baseChartOptions } from "@/lib/chartTheme";
import type { OptionAnalyzeResult } from "@/lib/api";

interface Props {
  result: OptionAnalyzeResult;
}

// Bars visible on screen by default; the user can scroll back for older.
// Reduced from 90 so each delta-candle has visible width instead of
// compressing to a 1-pixel sliver on wide screens.
const VISIBLE_BARS_DEFAULT = 60;

/**
 * Option-contract chart — same visual language as the main TradingChart so
 * the analyzer page feels like one product, not two.
 *
 *  - Top OHLCV-style header with hover-driven option mid / change pill /
 *    EMA9 / EMA21 / RV30. Replaces the previous thin one-line strip.
 *  - Price pane uses *delta candles*: each bar is open=prev-close,
 *    close=current synthetic price. No wicks (the BS-replay has no
 *    intra-bar high/low) — body alone shows the bar-over-bar move,
 *    coloured up/down. Much denser than the previous line + matches the
 *    underlying chart's bar look.
 *  - A change-magnitude histogram parks at the bottom 18% of the price
 *    pane in place of true volume.
 *  - EMA9 / EMA21 line overlays + dashed RV30 on a secondary left scale.
 *  - Stacked RSI + MACD sub-panes with TradingChart-style header strips
 *    (uppercase label · parameter · color legend), synced time scale and
 *    crosshair with the price pane.
 *
 * IMPORTANT (still surfaced in the header tooltip): prices are a
 * Black-Scholes replay using the option's *current* IV, not historical
 * mids — it's "what this option would have been worth as the underlying
 * moved, if IV stayed where it is now."
 */
export function OptionAnalysisCard({ result }: Props) {
  const oc = result.option_chart;
  // `prices` is canonical; fall back to the legacy synthetic_prices field.
  const ocPrices = oc?.prices ?? oc?.synthetic_prices ?? [];
  if (!oc || ocPrices.length === 0) return null;

  const isReal = oc.source === "ibkr";
  const N = ocPrices.length;
  // Real bars carry their own timestamps; the modeled replay aligns to the
  // underlying-chart bars (same length/ordering) when it has no times of its own.
  const underlyingBars = result.chart?.bars ?? [];
  const offset = underlyingBars.length - N;
  const times: number[] = useMemo(() => {
    if (oc.times && oc.times.length === N) return oc.times;
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      const ub = underlyingBars[offset + i];
      out.push(ub ? ub.time : i);
    }
    return out;
  }, [oc.times, underlyingBars, offset, N]);

  // Hover state lifted up for the top OHLCV-style strip.
  const [hover, setHover] = useState<{ idx: number; time: number } | null>(null);
  const display = useMemo(() => {
    const idx = hover?.idx ?? N - 1;
    const px = ocPrices[idx];
    const pxPrev = idx > 0 ? ocPrices[idx - 1] : px;
    const chg = px - pxPrev;
    const chgPct = pxPrev !== 0 ? (chg / pxPrev) * 100 : 0;
    return {
      idx,
      time: times[idx],
      px,
      chg,
      chgPct,
      ema9: oc.ema9[idx],
      ema21: oc.ema21[idx],
      rv30: oc.rv30[idx] ?? 0,
      rsi: oc.rsi[idx],
      macd: oc.macd[idx],
      hist: oc.macd_hist[idx],
    };
  }, [hover, oc, times, N]);

  const positive = display.chg >= 0;
  const firstPx = ocPrices[Math.max(0, N - VISIBLE_BARS_DEFAULT)];
  const lastPx = ocPrices[N - 1];
  const periodPct = firstPx > 0 ? ((lastPx - firstPx) / firstPx) * 100 : 0;

  return (
    <div
      className="flex flex-col rounded-md border border-border bg-surface overflow-hidden shrink-0"
      style={{ minHeight: 680 }}
    >
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60 bg-surface">
        <HintLabel
          className="text-[10px] uppercase tracking-wider text-text-muted"
          hint={
            <div className="flex flex-col gap-1">
              <div className="font-medium">Option price & indicators</div>
              {isReal ? (
                <div>
                  Real <em>IBKR option bars</em> ({oc.bar_size} MIDPOINT) — the
                  contract&apos;s actual quoted price history. IBKR serves option
                  history intraday only (no daily bars), capped at ~81 days back.
                </div>
              ) : (
                <div>
                  No real IBKR bars for this contract, so prices are a{" "}
                  <em>Black-Scholes replay</em> using the option&apos;s current IV
                  — what it <em>would</em> have been worth as the underlying moved,
                  if IV stayed at today&apos;s level.
                </div>
              )}
              <div>
                RV30 (rolling 30-bar realized vol of the underlying) is shown as
                an IV-history proxy.
              </div>
            </div>
          }
        >
          Option contract
        </HintLabel>
        <span className="ml-auto text-[10px] tabular text-text-muted">
          BS replay · IV-as-of-now
        </span>
      </div>

      {/* TradingChart-style OHLCV strip — hover-driven, falls back to last bar. */}
      <div className="flex items-center gap-3 md:gap-5 px-3 min-h-10 py-1 border-b border-border/60 bg-surface shrink-0 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm text-text-primary tracking-tight">
            {result.strike}
            {result.right}
          </span>
          <span className="text-[10px] tabular text-text-muted">
            {fmtExp(result.expiry)}
          </span>
          {isReal ? (
            <span
              className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-300/90 cursor-help"
              title={
                `Real IBKR option bars (${oc.bar_size} MIDPOINT). ${N} bars of the ` +
                "contract's actual quoted price history — IBKR serves option history " +
                "intraday only (no daily bars), so this is the finest/longest real " +
                "series available, ~81 days back."
              }
            >
              IBKR {oc.bar_size.replace(/\s+/g, "")}
            </span>
          ) : (
            <span
              className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-amber-500/10 text-amber-300/90 cursor-help"
              title={
                "Modeled, not traded history. This contract has no real IBKR bars, so " +
                "the series is a Black-Scholes replay of the underlying's moves" +
                (result.vol_context?.iv_source === "calibrated_to_mark"
                  ? ` at IV ${((result.vol_context.iv ?? 0) * 100).toFixed(1)}% — calibrated so the right edge equals the live mark $${fmt(result.option.mid ?? display.px)}` +
                    (result.vol_context.market_iv
                      ? ` (IBKR model IV ${((result.vol_context.market_iv) * 100).toFixed(1)}%)`
                      : "")
                  : result.vol_context?.iv_source === "ibkr_model"
                  ? ` at IBKR's model IV ${((result.vol_context.iv ?? 0) * 100).toFixed(1)}% (no live quote to calibrate against)`
                  : result.vol_context?.iv_source === "realized_vol"
                  ? ` at realized vol ${((result.vol_context.iv ?? 0) * 100).toFixed(1)}% — no quote or IBKR IV available, using RV30 as the proxy`
                  : " at a default 35% IV — no market data available")
              }
            >
              modeled
            </span>
          )}
          <span className="text-base tabular font-medium text-text-primary">
            ${fmt(display.px)}
          </span>
          <span
            className={cn(
              "text-[11px] tabular leading-none px-1.5 py-0.5 rounded",
              positive ? "text-up bg-up/10" : "text-down bg-down/10",
            )}
          >
            {positive ? "+" : ""}
            {fmt(display.chg)} · {display.chgPct >= 0 ? "+" : ""}
            {display.chgPct.toFixed(2)}%
          </span>
          {hover && (
            <span className="text-[10px] tabular text-text-muted ml-1">
              {formatBarTime(display.time)}
            </span>
          )}
        </div>
        <div className="hidden md:flex items-center gap-3 text-[10px] uppercase tracking-wider text-text-muted">
          <span style={{ color: CHART.ema.fast }}>
            EMA9 <OhlcVal n={display.ema9} />
          </span>
          <span style={{ color: CHART.ema.slow }}>
            EMA21 <OhlcVal n={display.ema21} />
          </span>
          <span style={{ color: CHART.forecast.meanrev }}>
            RV30{" "}
            <OhlcVal n={display.rv30 * 100} />
            <span className="text-text-muted">%</span>
          </span>
          <span
            className={cn(
              "ml-2",
              periodPct >= 0 ? "text-up" : "text-down",
              "font-medium",
            )}
          >
            {periodPct >= 0 ? "+" : ""}
            {periodPct.toFixed(1)}%{" "}
            <span className="text-text-muted normal-case tracking-normal">
              · {Math.min(N, VISIBLE_BARS_DEFAULT)} bars
            </span>
          </span>
        </div>
      </div>

      <Panes
        times={times}
        prices={ocPrices}
        ema9={oc.ema9}
        ema21={oc.ema21}
        rv30={oc.rv30}
        rsi={oc.rsi}
        macd={oc.macd}
        macdSignal={oc.macd_signal}
        macdHist={oc.macd_hist}
        currentIv={result.option.iv}
        contractLabel={`${result.strike}${result.right}`}
        onHoverChange={setHover}
      />
    </div>
  );
}

interface PanesProps {
  times: number[];
  prices: number[];
  ema9: number[];
  ema21: number[];
  rv30: number[];
  rsi: number[];
  macd: number[];
  macdSignal: number[];
  macdHist: number[];
  /** Current implied vol (annualized decimal). Drawn as a horizontal
   *  reference line on the vol subpane so the user sees today's IV vs
   *  recent RV30 history at a glance. */
  currentIv: number;
  contractLabel: string;
  onHoverChange: (h: { idx: number; time: number } | null) => void;
}

function Panes({
  times,
  prices,
  ema9,
  ema21,
  rv30,
  rsi,
  macd,
  macdSignal,
  macdHist,
  currentIv,
  contractLabel,
  onHoverChange,
}: PanesProps) {
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const volContainerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);

  const priceChartRef = useRef<IChartApi | null>(null);
  const volChartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const changeHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const disposedRef = useRef(false);

  const timeIndex = useMemo(() => {
    const m = new Map<number, number>();
    times.forEach((t, i) => m.set(t, i));
    return m;
  }, [times]);

  // ── init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    disposedRef.current = false;
    const priceEl = priceContainerRef.current;
    const volEl = volContainerRef.current;
    const rsiEl = rsiContainerRef.current;
    const macdEl = macdContainerRef.current;
    if (!priceEl || !volEl || !rsiEl || !macdEl) return;

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
        // Leave room for the change-magnitude histogram at the bottom.
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
    });
    priceChartRef.current = priceChart;

    // Vol subpane — RV30 over time with a horizontal reference line at
    // the current IV. This is the closest we get to "IV over time"
    // without paid historical-IV data: realized vol IS the underlying's
    // moving statistical analog of IV, so its trajectory tells you
    // whether today's IV is rich, cheap, or in line with recent reality.
    const volChart = createChart(volEl, {
      ...subpaneOpts,
      width: volEl.clientWidth,
      height: volEl.clientHeight,
      timeScale: { ...subpaneOpts.timeScale, visible: false },
    });
    volChartRef.current = volChart;

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
    });
    macdChartRef.current = macdChart;

    // Delta candles — open = previous close, close = current synthetic
    // price. No wicks (we don't have intra-bar high/low for the BS
    // replay), so high = max(o,c), low = min(o,c). The body alone tells
    // the bar's directional story.
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

    // Change-magnitude histogram — |c - o|, signed by direction. Stands
    // in for volume so the bottom of the price pane reads "movement,
    // bar by bar" the same way TradingChart's volume strip does.
    changeHistRef.current = priceChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "change",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    priceChart
      .priceScale("change")
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

    // RV30 lives on its own subpane (volChart) now. Solid line at full
    // weight — this is the chart that answers "is today's IV high or
    // low vs realized?". Y-axis values are percentage points (× 100).
    volSeriesRef.current = volChart.addLineSeries({
      color: CHART.forecast.meanrev,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    });
    // Current IV as a horizontal reference line — the user can see at
    // a glance whether RV30 has been above or below the option's IV
    // through the visible window.
    const ivPct = currentIv * 100;
    if (Number.isFinite(ivPct) && ivPct > 0) {
      volSeriesRef.current.createPriceLine({
        price: ivPct,
        color: CHART.warning,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `IV ${ivPct.toFixed(0)}%`,
      });
    }

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
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      priceLineVisible: false, lastValueVisible: false,
    });

    // sync time-scale
    let syncing = false;
    const syncRange = (driver: IChartApi) => (range: LogicalRange | null) => {
      if (syncing || !range || disposedRef.current) return;
      syncing = true;
      try {
        for (const c of [priceChart, volChart, rsiChart, macdChart]) {
          if (c !== driver) c.timeScale().setVisibleLogicalRange(range);
        }
      } finally {
        syncing = false;
      }
    };
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(priceChart));
    volChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(volChart));
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(rsiChart));
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(macdChart));

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
          { chart: volChart, series: volSeriesRef.current! },
          { chart: rsiChart, series: rsiSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
        ],
        t,
      );
      if (t == null) { onHoverChange(null); return; }
      const idx = timeIndex.get(t);
      if (idx != null) onHoverChange({ idx, time: t });
    });
    volChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: rsiChart, series: rsiSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
        ],
        p.time,
      ),
    );
    rsiChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: volChart, series: volSeriesRef.current! },
          { chart: macdChart, series: macdLineRef.current! },
        ],
        p.time,
      ),
    );
    macdChart.subscribeCrosshairMove((p) =>
      moveOthers(
        [
          { chart: priceChart, series: candleSeriesRef.current! },
          { chart: volChart, series: volSeriesRef.current! },
          { chart: rsiChart, series: rsiSeriesRef.current! },
        ],
        p.time,
      ),
    );

    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (disposedRef.current) return;
        for (const [c, el] of [
          [priceChart, priceEl],
          [volChart, volEl],
          [rsiChart, rsiEl],
          [macdChart, macdEl],
        ] as const) {
          try {
            c.applyOptions({ width: el.clientWidth, height: el.clientHeight });
          } catch { /* */ }
        }
      });
    });
    ro.observe(priceEl);
    ro.observe(volEl);
    ro.observe(rsiEl);
    ro.observe(macdEl);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      candleSeriesRef.current = null;
      changeHistRef.current = null;
      ema9SeriesRef.current = null;
      ema21SeriesRef.current = null;
      volSeriesRef.current = null;
      rsiSeriesRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      priceChartRef.current = null;
      volChartRef.current = null;
      rsiChartRef.current = null;
      macdChartRef.current = null;
      try { priceChart.remove(); } catch { /* */ }
      try { volChart.remove(); } catch { /* */ }
      try { rsiChart.remove(); } catch { /* */ }
      try { macdChart.remove(); } catch { /* */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── set data ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (disposedRef.current) return;

    // Delta candles + change-magnitude histogram.
    const candles: CandlestickData[] = [];
    const change: HistogramData[] = [];
    for (let i = 0; i < prices.length; i++) {
      const o = i > 0 ? prices[i - 1] : prices[i];
      const c = prices[i];
      const hi = Math.max(o, c);
      const lo = Math.min(o, c);
      candles.push({
        time: times[i] as UTCTimestamp,
        open: o,
        high: hi,
        low: lo,
        close: c,
      });
      change.push({
        time: times[i] as UTCTimestamp,
        value: Math.abs(c - o),
        color: c >= o ? `${CHART.candle.up}66` : `${CHART.candle.down}66`,
      });
    }
    candleSeriesRef.current?.setData(candles);
    changeHistRef.current?.setData(change);

    ema9SeriesRef.current?.setData(
      ema9
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    ema21SeriesRef.current?.setData(
      ema21
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    // RV30 fed in percentage points (× 100) so the y-axis reads as
    // "65" not "0.65". Matches the IV reference line that's drawn in
    // the same units.
    volSeriesRef.current?.setData(
      rv30
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v * 100 }))
        .filter((d) => Number.isFinite(d.value) && d.value > 0) as LineData[],
    );

    rsiSeriesRef.current?.setData(
      rsi
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdLineRef.current?.setData(
      macd
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdSignalRef.current?.setData(
      macdSignal
        .map((v, i) => ({ time: times[i] as UTCTimestamp, value: v }))
        .filter((d) => Number.isFinite(d.value)) as LineData[],
    );
    macdHistRef.current?.setData(
      macdHist
        .map((v, i) => ({
          time: times[i] as UTCTimestamp,
          value: v,
          color: v >= 0 ? CHART.macd.histUp : CHART.macd.histDown,
        }))
        .filter((d) => Number.isFinite(d.value)) as HistogramData[],
    );

    if (priceChartRef.current && times.length > 1) {
      const start = Math.max(0, times.length - VISIBLE_BARS_DEFAULT);
      priceChartRef.current.timeScale().setVisibleLogicalRange({
        from: start - 0.5,
        to: times.length - 0.5,
      });
    }
  }, [times, prices, ema9, ema21, rv30, rsi, macd, macdSignal, macdHist]);

  return (
    <>
      {/* Price pane — dominant, with contract label watermark. shrink-0
          so flex-column parents don't squash it to 0 on mount. */}
      <div className="relative bg-bg shrink-0" style={{ height: 440 }}>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-0">
          <span className="text-[88px] font-medium text-text-muted/[0.04] tracking-[0.2em]">
            {contractLabel}
          </span>
        </div>
        <div ref={priceContainerRef} className="absolute inset-0 z-10" />
      </div>

      <Subpane
        label="IV proxy"
        params="RV30 · underlying vol over time"
        legend={[
          { color: CHART.forecast.meanrev, label: "RV30 history" },
          { color: CHART.warning, label: "current IV" },
        ]}
        rightTone={tonedRv30VsIv(rv30[rv30.length - 1], currentIv)}
        containerRef={volContainerRef}
        title="True historical IV needs paid data (not available). RV30 — realized volatility of the underlying over the trailing 30 bars — is the standard proxy. When RV30 line is below the dashed IV reference, today's IV is rich vs what the underlying has actually been doing (sellers' favor). When above, IV is cheap (buyers' favor)."
      />
      <Subpane
        label="RSI"
        params="14 · opt"
        legend={[{ color: CHART.rsi, label: "rsi" }]}
        rightTone={tonedLast(rsi, 70, 30)}
        containerRef={rsiContainerRef}
      />
      <Subpane
        label="MACD"
        params="12 · 26 · 9 · opt"
        legend={[
          { color: CHART.macd.line, label: "macd" },
          { color: CHART.macd.signal, label: "signal" },
        ]}
        rightTone={tonedDelta(macd[macd.length - 1], macdSignal[macdSignal.length - 1])}
        containerRef={macdContainerRef}
      />
    </>
  );
}

// Verbatim copy of the SMI-subpane block in TradingChart.
function Subpane({
  label,
  params,
  legend,
  rightTone,
  containerRef,
  title,
}: {
  label: string;
  params: string;
  legend: { color: string; label: string }[];
  rightTone?: { value: string; cls: string } | null;
  containerRef: React.RefObject<HTMLDivElement>;
  title?: string;
}) {
  return (
    <div className="border-t border-border bg-bg shrink-0" style={{ height: 140 }} title={title}>
      <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
        <span className="text-[10px] tabular text-text-muted">{params}</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] tabular text-text-muted">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1">
              <span className="w-2 h-0.5 inline-block" style={{ backgroundColor: l.color }} />
              {l.label}
            </span>
          ))}
          {rightTone && (
            <span className={cn("font-medium tabular", rightTone.cls)}>{rightTone.value}</span>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full h-[114px]" />
    </div>
  );
}

// "RV30 65% / IV 24% (rich)" — same right-side readout pattern as the
// other subpane headers. Tone signals the trader's edge: when IV ≫ RV
// option premium is rich (good for sellers, bad for buyers).
function tonedRv30VsIv(rv30: number | undefined, currentIv: number) {
  if (rv30 == null || !Number.isFinite(rv30)) return null;
  const rvPct = rv30 * 100;
  const ivPct = currentIv * 100;
  const ratio = ivPct > 0 && rvPct > 0 ? ivPct / rvPct : 1;
  const label = ratio >= 1.3 ? "rich" : ratio <= 0.8 ? "cheap" : "fair";
  const cls = ratio >= 1.3 ? "text-down" : ratio <= 0.8 ? "text-up" : "text-text-secondary";
  return {
    value: `RV ${rvPct.toFixed(0)}% / IV ${ivPct.toFixed(0)}% · ${label}`,
    cls,
  };
}

function tonedLast(series: number[], hi: number, lo: number) {
  const v = series[series.length - 1];
  if (!Number.isFinite(v)) return null;
  const cls = v >= hi ? "text-down" : v <= lo ? "text-up" : "text-text-secondary";
  return { value: v.toFixed(0), cls };
}
function tonedDelta(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return {
    value: `${a.toFixed(3)} / ${b.toFixed(3)}`,
    cls: a - b >= 0 ? "text-up" : "text-down",
  };
}

function OhlcVal({
  n,
  compact,
}: {
  n: number;
  compact?: boolean;
}) {
  if (!Number.isFinite(n)) return <span className="tabular text-text-muted">—</span>;
  return (
    <span className="normal-case tracking-normal text-[11px] tabular text-text-secondary">
      {compact ? fmtCompact(n) : fmt(n)}
    </span>
  );
}

function formatBarTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(2, 4)}`;
}
