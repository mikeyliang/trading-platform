"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  api,
  type SimChartPayload,
  type SimPreset,
  type SimRunDetail,
  type SimRunSummary,
} from "@/lib/api";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toaster";
import { Loader2, Play, Trash2, X } from "lucide-react";
import { NewsAnalystCard } from "./NewsAnalystCard";
import { SimCompareTable } from "./SimCompareTable";
import { SimStatsGrid } from "./SimStatsGrid";
import { VolumeProfilePanel } from "./VolumeProfilePanel";
import { EquityCurveChart } from "@/components/backtest/EquityCurveChart";

const SimChart = dynamic(() => import("./SimChart").then((m) => m.SimChart), { ssr: false });

const TIMEFRAMES = ["15m", "30m", "1h", "4h", "1d"];
const DEFAULT_SYMBOLS = ["AAPL", "NVDA", "MSFT", "TSLA", "AMD"];

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function SimPanel() {
  // ── config state ──
  const [presets, setPresets] = useState<SimPreset[]>([]);
  const [preset, setPreset] = useState("confluence-core");
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_SYMBOLS);
  const [symbolInput, setSymbolInput] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [startDate, setStartDate] = useState(isoDaysAgo(365));
  const [endDate, setEndDate] = useState(isoDaysAgo(1));
  const [capital, setCapital] = useState(100_000);
  const [starting, setStarting] = useState(false);

  // ── runs state ──
  const [runs, setRuns] = useState<SimRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<SimRunDetail | null>(null);
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const [chartPayload, setChartPayload] = useState<SimChartPayload | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [view, setView] = useState<"detail" | "compare">("detail");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const rs = await api.simRuns();
      setRuns(rs);
      return rs;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    api.simPresets().then((p) => setPresets(p.presets)).catch(() => {});
    refreshRuns().then((rs) => {
      if (rs.length && !selectedRunId) setSelectedRunId(rs[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // poll while any run is in flight
  useEffect(() => {
    const anyRunning = runs.some((r) => r.status === "running");
    if (anyRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const rs = await refreshRuns();
        if (!rs.some((r) => r.status === "running") && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // refresh detail if the selected run just finished
          if (selectedRunId) loadDetail(selectedRunId);
        }
      }, 2500);
    }
    return () => {
      if (pollRef.current && !runs.some((r) => r.status === "running")) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, selectedRunId]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api.simRun(id);
      setRunDetail(d);
      const okSymbols = Object.keys(d.results).filter((s) => d.results[s]?.stats);
      setActiveSymbol((cur) => (cur && okSymbols.includes(cur) ? cur : okSymbols[0] ?? null));
    } catch {
      setRunDetail(null);
    }
  }, []);

  useEffect(() => {
    if (selectedRunId) {
      setChartPayload(null);
      loadDetail(selectedRunId);
    }
  }, [selectedRunId, loadDetail]);

  useEffect(() => {
    if (!selectedRunId || !activeSymbol || runDetail?.status === "running") return;
    setChartLoading(true);
    api
      .simChart(selectedRunId, activeSymbol)
      .then(setChartPayload)
      .catch(() => setChartPayload(null))
      .finally(() => setChartLoading(false));
  }, [selectedRunId, activeSymbol, runDetail?.status]);

  const addSymbol = () => {
    const s = symbolInput.trim().toUpperCase();
    if (s && !symbols.includes(s) && symbols.length < 12) setSymbols([...symbols, s]);
    setSymbolInput("");
  };

  const startRun = async () => {
    setStarting(true);
    try {
      const summary = await api.simStart({
        symbols, timeframe, start_date: startDate, end_date: endDate,
        initial_capital: capital, preset,
      });
      toast.success("Simulation started", {
        description: `${symbols.length} symbol(s) · ${timeframe} · NautilusTrader`,
      });
      setSelectedRunId(summary.id);
      await refreshRuns();
    } catch (e) {
      toast.error("Failed to start simulation", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setStarting(false);
    }
  };

  const deleteRun = async (id: string) => {
    try {
      await api.simDelete(id);
      if (selectedRunId === id) {
        setSelectedRunId(null);
        setRunDetail(null);
        setChartPayload(null);
      }
      await refreshRuns();
    } catch {
      toast.error("Delete failed");
    }
  };

  const selectedPreset = presets.find((p) => p.id === preset);
  const symbolTabs = useMemo(() => {
    if (!runDetail) return [];
    return runDetail.symbols.map((s) => ({
      symbol: s,
      stats: runDetail.results[s]?.stats ?? null,
      error: runDetail.results[s]?.error ?? null,
    }));
  }, [runDetail]);

  return (
    <div className="flex h-full min-h-0 gap-4 p-4 bg-bg overflow-hidden">
      {/* ── left rail: config + run history ── */}
      <div className="w-72 shrink-0 flex flex-col gap-4 min-h-0">
        <Card className="shrink-0">
          <CardHeader>
            <CardTitle>Simulation</CardTitle>
            <Badge variant="muted">NautilusTrader</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field label="Strategy preset">
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {selectedPreset && (
              <p className="text-[10px] leading-relaxed text-text-muted -mt-1">
                {selectedPreset.description}
              </p>
            )}

            <Field label={`Symbols (${symbols.length}/12)`}>
              <div className="flex flex-wrap gap-1 mb-1">
                {symbols.map((s) => (
                  <span key={s} className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded bg-surface-2 text-[10px] tabular">
                    {s}
                    <button
                      onClick={() => setSymbols(symbols.filter((x) => x !== s))}
                      className="text-text-muted hover:text-down"
                    >
                      <X size={9} />
                    </button>
                  </span>
                ))}
              </div>
              <Input
                value={symbolInput}
                placeholder="add symbol ⏎"
                onChange={(e) => setSymbolInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSymbol()}
                onBlur={addSymbol}
              />
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Timeframe">
                <Select value={timeframe} onValueChange={setTimeframe}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEFRAMES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Capital ($)">
                <Input type="number" value={capital} onChange={(e) => setCapital(+e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Start">
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="End">
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            </div>
            {(timeframe === "15m" || timeframe === "30m") && (
              <p className="text-[10px] text-amber-500/80 -mt-1">
                intraday {"<"}1h data is limited to ~60 days back
              </p>
            )}

            <Button onClick={startRun} disabled={starting || symbols.length === 0} size="lg" className="mt-1">
              {starting ? <Loader2 className="animate-spin" /> : <Play />}
              {starting ? "starting…" : "run simulation"}
            </Button>
          </CardContent>
        </Card>

        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
            <Badge variant="muted">{runs.length}</Badge>
          </CardHeader>
          <div className="flex-1 overflow-y-auto">
            {runs.length === 0 && (
              <p className="text-[11px] text-text-muted px-3 py-2">no runs yet</p>
            )}
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedRunId(r.id)}
                className={cn(
                  "w-full text-left px-3 py-1.5 border-b border-border/40 group transition-colors",
                  selectedRunId === r.id ? "bg-surface-2" : "hover:bg-surface-1"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      r.status === "running" && "bg-amber-400 animate-pulse",
                      r.status === "completed" && "bg-up",
                      r.status === "error" && "bg-down"
                    )}
                  />
                  <span className="text-[11px] truncate flex-1">{r.label}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); deleteRun(r.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); deleteRun(r.id); } }}
                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-down transition-opacity cursor-pointer"
                  >
                    <Trash2 size={10} />
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-3 text-[10px] tabular text-text-muted">
                  <span>{r.timeframe}</span>
                  <span>{r.symbols.length} sym</span>
                  {r.status === "running" ? (
                    <span className="text-amber-400">
                      {r.progress.done}/{r.progress.total} {r.progress.current ?? ""}
                    </span>
                  ) : r.aggregate ? (
                    <span className={pnlClass(r.aggregate.avg_return_pct)}>
                      {r.aggregate.avg_return_pct >= 0 ? "+" : ""}
                      {r.aggregate.avg_return_pct.toFixed(1)}% · PF {r.aggregate.profit_factor.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-down">failed</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* ── results ── */}
      <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-3">
        {!runDetail && (
          <Card className="flex-1 flex items-center justify-center">
            <p className="text-text-muted text-sm">configure and run a simulation, or select a past run</p>
          </Card>
        )}

        {runDetail?.status === "running" && (
          <Card className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-text-muted text-sm">
              <Loader2 size={18} className="animate-spin" />
              <span>
                simulating {runDetail.progress.current ?? "…"} ({runDetail.progress.done}/{runDetail.progress.total})
              </span>
              <span className="text-[10px]">NautilusTrader backtest engine</span>
            </div>
          </Card>
        )}

        {runDetail && runDetail.status !== "running" && (
          <>
            {/* header strip: run identity + aggregate + view toggle */}
            <div className="shrink-0 flex items-stretch border border-border rounded-md overflow-hidden bg-surface-1">
              <div className="px-2.5 py-1.5 border-r border-border/50 min-w-0">
                <div className="text-[9px] uppercase tracking-wider text-text-muted leading-tight">Run</div>
                <div className="text-xs leading-tight mt-0.5 truncate max-w-44" title={runDetail.label}>{runDetail.label}</div>
              </div>
              <div className="px-2.5 py-1.5 border-r border-border/50">
                <div className="text-[9px] uppercase tracking-wider text-text-muted leading-tight">Setup</div>
                <div className="text-xs tabular leading-tight mt-0.5 whitespace-nowrap">
                  {runDetail.preset.replace("confluence-", "")} · {runDetail.timeframe} · {runDetail.start_date.slice(2)}→{runDetail.end_date.slice(2)}
                </div>
              </div>
              {runDetail.aggregate && [
                { l: "Avg return", v: `${runDetail.aggregate.avg_return_pct >= 0 ? "+" : ""}${runDetail.aggregate.avg_return_pct.toFixed(2)}%`, c: pnlClass(runDetail.aggregate.avg_return_pct) },
                { l: "PF", v: runDetail.aggregate.profit_factor.toFixed(2), c: runDetail.aggregate.profit_factor >= 1 ? "text-up" : "text-down" },
                { l: "Sharpe", v: runDetail.aggregate.avg_sharpe.toFixed(2) },
                { l: "Max DD", v: `${runDetail.aggregate.avg_max_drawdown_pct.toFixed(1)}%`, c: "text-down" },
                { l: "Trades · Win", v: `${runDetail.aggregate.total_trades} · ${runDetail.aggregate.win_rate.toFixed(0)}%` },
              ].map((cell) => (
                <div key={cell.l} className="px-2.5 py-1.5 border-r border-border/50">
                  <div className="text-[9px] uppercase tracking-wider text-text-muted leading-tight whitespace-nowrap">{cell.l}</div>
                  <div className={cn("text-xs tabular leading-tight mt-0.5 whitespace-nowrap", cell.c ?? "text-text-primary")}>{cell.v}</div>
                </div>
              ))}
              <div className="ml-auto flex items-center gap-0.5 px-2">
                {(["detail", "compare"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={cn(
                      "px-2 h-6 rounded text-[10px] uppercase tracking-wider transition-colors",
                      view === v ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
                    )}
                  >
                    {v === "detail" ? "Results" : "Compare runs"}
                  </button>
                ))}
              </div>
            </div>

            {runDetail.error && (
              <p className="text-xs text-down bg-down/10 border border-down/20 rounded px-2 py-1.5">
                {runDetail.error}
              </p>
            )}

            {view === "compare" && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>All completed runs</CardTitle>
                  <Badge variant="muted">sorted by Sharpe</Badge>
                </CardHeader>
                <div className="overflow-auto">
                  <SimCompareTable
                    runs={runs}
                    selectedId={selectedRunId}
                    onSelect={(id) => { setSelectedRunId(id); setView("detail"); }}
                  />
                </div>
              </Card>
            )}

            {view === "detail" && (
            <>
            {/* symbol tabs */}
            <div className="flex items-center gap-1 flex-wrap">
              {symbolTabs.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => t.stats && setActiveSymbol(t.symbol)}
                  disabled={!t.stats}
                  className={cn(
                    "h-6 px-2 rounded text-[11px] tabular flex items-center gap-1.5 border transition-colors",
                    activeSymbol === t.symbol
                      ? "bg-surface-3 border-border text-text-primary"
                      : t.stats
                      ? "border-border/50 text-text-secondary hover:bg-surface-1"
                      : "border-border/30 text-text-muted/50 cursor-not-allowed"
                  )}
                >
                  {t.symbol}
                  {t.stats ? (
                    <span className={pnlClass(t.stats.total_return_pct)}>
                      {t.stats.total_return_pct >= 0 ? "+" : ""}
                      {t.stats.total_return_pct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-down">err</span>
                  )}
                </button>
              ))}
            </div>

            {/* per-symbol detail */}
            {chartLoading && (
              <Card className="h-40 flex items-center justify-center">
                <Loader2 size={16} className="animate-spin text-text-muted" />
              </Card>
            )}

            {chartPayload && !chartLoading && (
              <>
                <SimStatsGrid stats={chartPayload.stats} />

                <div className="flex gap-3 min-w-0">
                  <Card className="flex-1 min-w-0">
                    <CardHeader>
                      <CardTitle>
                        {activeSymbol} · {runDetail.timeframe} bars
                      </CardTitle>
                      <span className="text-[10px] tabular text-text-muted">
                        {runDetail.start_date} → {runDetail.end_date}
                      </span>
                      <Badge variant="muted">{chartPayload.trades.length} trades</Badge>
                    </CardHeader>
                    <CardContent>
                      <SimChart payload={chartPayload} />
                    </CardContent>
                  </Card>

                  <div className="w-52 shrink-0 flex flex-col gap-3 self-start">
                    <Card>
                      <CardHeader>
                        <CardTitle>Volume profile</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <VolumeProfilePanel
                          bins={chartPayload.chart.volume_profile.bins}
                          volumes={chartPayload.chart.volume_profile.volumes}
                          poc={chartPayload.chart.volume_profile.poc}
                          vah={chartPayload.chart.volume_profile.vah}
                          val={chartPayload.chart.volume_profile.val}
                          lastPrice={chartPayload.chart.candles.at(-1)?.close}
                        />
                      </CardContent>
                    </Card>
                    {activeSymbol && <NewsAnalystCard symbol={activeSymbol} />}
                  </div>
                </div>

                <div className="flex gap-3 min-w-0 items-start">
                <Card className="flex-1 min-w-0">
                  <CardHeader>
                    <CardTitle>Equity & drawdown</CardTitle>
                    <span className="ml-auto text-[10px] tabular text-text-muted">
                      {fmtCurrency(chartPayload.stats.initial_capital)} → {fmtCurrency(chartPayload.stats.final_capital)}
                    </span>
                  </CardHeader>
                  <CardContent>
                    <EquityCurveChart
                      equity={chartPayload.equity_curve}
                      initialCapital={chartPayload.stats.initial_capital}
                      height={190}
                      ddHeight={60}
                    />
                  </CardContent>
                </Card>

                <Card className="flex-1 min-w-0 overflow-hidden">
                  <CardHeader>
                    <CardTitle>Trades</CardTitle>
                    <Badge variant="muted">{chartPayload.trades.length}</Badge>
                  </CardHeader>
                  <div className="overflow-auto max-h-72">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>entry</TableHead>
                          <TableHead>exit</TableHead>
                          <TableHead className="text-right">px</TableHead>
                          <TableHead className="text-right">qty</TableHead>
                          <TableHead className="text-right">P&L</TableHead>
                          <TableHead className="text-right">%</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {chartPayload.trades.map((t, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-text-muted whitespace-nowrap">
                              {t.side === "SELL" && <span className="text-down mr-1">S</span>}
                              {new Date(t.entry_time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </TableCell>
                            <TableCell className="text-text-muted whitespace-nowrap">
                              {t.exit_time
                                ? new Date(t.exit_time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right tabular whitespace-nowrap">
                              {t.entry_price.toFixed(2)}<span className="text-text-muted">→</span>{t.exit_price?.toFixed(2) ?? "…"}
                            </TableCell>
                            <TableCell className="text-right tabular">{t.quantity.toFixed(0)}</TableCell>
                            <TableCell className={cn("text-right tabular", pnlClass(t.pnl ?? 0))}>
                              {t.pnl != null ? fmtCurrency(t.pnl) : "—"}
                            </TableCell>
                            <TableCell className={cn("text-right tabular", pnlClass(t.pnl_pct ?? 0))}>
                              {t.pnl_pct != null ? fmtPct(t.pnl_pct) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
                </div>
              </>
            )}
            </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-text-muted uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}
