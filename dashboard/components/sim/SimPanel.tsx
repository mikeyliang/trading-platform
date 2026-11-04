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
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Spinner } from "@/components/ui/skeleton";
import { ToggleGroup } from "@/components/ui/toggle-group";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toaster";
import {
  RiDeleteBinLine,
  RiErrorWarningFill,
  RiFlaskLine,
  RiLoader4Line,
  RiPlayFill,
} from "@remixicon/react";
import { NewsAnalystCard } from "./NewsAnalystCard";
import { SymbolChip } from "./SymbolChip";
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

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

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
  const [chartNonce, setChartNonce] = useState(0);
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
    api.simPresets().then((p) => setPresets(Array.isArray(p?.presets) ? p.presets : [])).catch(() => {});
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
      const results = d.results ?? {};
      const okSymbols = Object.keys(results).filter((s) => results[s]?.stats);
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
  }, [selectedRunId, activeSymbol, runDetail?.status, chartNonce]);

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
        description: `${symbols.length} symbol(s), ${timeframe}, NautilusTrader`,
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

  const agg = runDetail?.aggregate ?? null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3 overflow-hidden">
      {/* ── left rail: config + run history ── */}
      <div className="w-80 shrink-0 flex flex-col gap-3 min-h-0">
        <Card className="shrink-0">
          <CardHeader>
            <CardTitle>Simulation</CardTitle>
            <Badge variant="muted">NautilusTrader</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field label="Strategy preset">
              <Select value={presets.some((p) => p.id === preset) ? preset : ""} onValueChange={setPreset}>
                <SelectTrigger><SelectValue placeholder="Choose a preset" /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPreset && (
                <p className="text-caption-1-regular text-text-tertiary">{selectedPreset.description}</p>
              )}
            </Field>

            <Field label={`Symbols (${symbols.length} of 12)`}>
              {symbols.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {symbols.map((s) => (
                    <SymbolChip key={s} symbol={s} onRemove={() => setSymbols(symbols.filter((x) => x !== s))} />
                  ))}
                </div>
              )}
              <Input
                value={symbolInput}
                placeholder="Add a symbol and press Enter"
                onChange={(e) => setSymbolInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSymbol()}
                onBlur={addSymbol}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
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
                <Input type="number" className="tabular" value={capital} onChange={(e) => setCapital(+e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Start">
                <Input type="date" className="tabular" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="End">
                <Input type="date" className="tabular" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            </div>
            {(timeframe === "15m" || timeframe === "30m") && (
              <p className="text-caption-1-regular text-status-yellow-text">
                Intraday data under 1h only reaches back about 60 days.
              </p>
            )}

            <Button variant="default" onClick={startRun} disabled={starting || symbols.length === 0}>
              {starting ? <RiLoader4Line className="animate-spin" /> : <RiPlayFill />}
              {starting ? "Starting" : "Run simulation"}
            </Button>
          </CardContent>
        </Card>

        <Card className="flex-1 min-h-0 flex flex-col">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
            <Badge variant="muted">{runs.length}</Badge>
          </CardHeader>
          <div className="flex-1 overflow-y-auto">
            {runs.length === 0 && (
              <EmptyState
                size="sm"
                icon={RiFlaskLine}
                title="No runs yet"
                description="Finished simulations are listed here."
              />
            )}
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                selected={selectedRunId === r.id}
                onSelect={() => setSelectedRunId(r.id)}
                onDelete={() => deleteRun(r.id)}
              />
            ))}
          </div>
        </Card>
      </div>

      {/* ── results ── */}
      <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-3">
        {!runDetail && (
          <Card className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={RiFlaskLine}
              title="No run selected"
              description="Configure and run a simulation, or pick a past run from the list."
            />
          </Card>
        )}

        {runDetail?.status === "running" && (
          <Card className="flex-1 flex items-center justify-center">
            <div role="status" aria-live="polite" className="flex flex-col items-center gap-2 text-text-tertiary">
              <Spinner size={18} />
              <span className="text-body-2-regular text-text-secondary">
                Simulating {runDetail.progress.current ?? ""} ({runDetail.progress.done} of {runDetail.progress.total})
              </span>
              <span className="text-caption-1-regular">NautilusTrader backtest engine</span>
            </div>
          </Card>
        )}

        {runDetail && runDetail.status !== "running" && (
          <>
            {/* run identity + aggregate + view toggle */}
            <Card className="shrink-0">
              <CardHeader>
                <div className="flex items-center gap-2 min-w-0">
                  <CardTitle title={runDetail.label}>{runDetail.label}</CardTitle>
                  <Badge variant="muted" className="tabular">
                    {runDetail.preset.replace("confluence-", "")} {runDetail.timeframe}
                  </Badge>
                  <span className="text-caption-1-regular tabular text-text-tertiary whitespace-nowrap">
                    {runDetail.start_date} to {runDetail.end_date}
                  </span>
                </div>
                <ToggleGroup
                  ariaLabel="Results view"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "detail", label: "Results" },
                    { value: "compare", label: "Compare runs" },
                  ]}
                />
              </CardHeader>
              {agg && (
                <CardContent>
                  <StatGroup>
                    <Stat
                      label="Avg return"
                      value={`${agg.avg_return_pct >= 0 ? "+" : ""}${agg.avg_return_pct.toFixed(2)}%`}
                      tone={agg.avg_return_pct >= 0 ? "up" : "down"}
                    />
                    <Stat
                      label="Profit factor"
                      value={agg.profit_factor.toFixed(2)}
                      tone={agg.profit_factor >= 1 ? "up" : "down"}
                    />
                    <Stat label="Sharpe" value={agg.avg_sharpe.toFixed(2)} />
                    <Stat label="Max drawdown" value={`-${Math.abs(agg.avg_max_drawdown_pct).toFixed(1)}%`} tone="down" />
                    <Stat label="Trades" value={agg.total_trades} />
                    <Stat label="Win rate" value={`${agg.win_rate.toFixed(0)}%`} />
                  </StatGroup>
                </CardContent>
              )}
              {runDetail.error && (
                <CardContent className="pt-0">
                  <div className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                    <RiErrorWarningFill size={16} className="shrink-0 mt-0.5 text-status-rose-text" aria-hidden />
                    <span>{runDetail.error}</span>
                  </div>
                </CardContent>
              )}
              {view === "detail" && symbolTabs.length > 0 && (
                <CardFooter className="h-auto min-h-11 py-2 gap-3 overflow-x-auto">
                  <span className="text-caption-1-medium text-text-tertiary shrink-0">Symbol</span>
                  <div
                    role="radiogroup"
                    aria-label="Symbol"
                    className="inline-flex items-center gap-0.5 rounded-2lg bg-segmented-control-background p-0.5"
                  >
                    {symbolTabs.map((t) => {
                      const active = activeSymbol === t.symbol;
                      return (
                        <button
                          key={t.symbol}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => t.stats && setActiveSymbol(t.symbol)}
                          disabled={!t.stats}
                          className={cn(
                            "inline-flex items-center gap-1.5 h-6 px-2.5 rounded-md text-body-2-medium tabular whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                            active
                              ? "bg-segmented-control-selected-background text-text-primary shadow-2xs"
                              : "text-text-secondary hover:text-text-primary",
                            !t.stats && "text-text-tertiary cursor-not-allowed hover:text-text-tertiary"
                          )}
                        >
                          {t.symbol}
                          {t.stats ? (
                            <span className={cn("text-caption-1-medium", pnlClass(t.stats.total_return_pct))}>
                              {t.stats.total_return_pct >= 0 ? "+" : ""}
                              {t.stats.total_return_pct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-caption-1-medium text-status-rose-text">error</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </CardFooter>
              )}
            </Card>

            {view === "compare" && (
              <Card>
                <CardHeader>
                  <CardTitle>All completed runs</CardTitle>
                  <Badge variant="muted">Sorted by Sharpe</Badge>
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
                {/* per-symbol detail */}
                {chartLoading && (
                  <Card className="h-40 flex items-center justify-center">
                    <Spinner size={16} />
                  </Card>
                )}

                {!chartLoading && !chartPayload && activeSymbol && (
                  <Card>
                    <EmptyState
                      icon={RiErrorWarningFill}
                      title="Chart unavailable"
                      description={`The result for ${activeSymbol} could not be loaded.`}
                      action={
                        <Button onClick={() => setChartNonce((n) => n + 1)}>Retry</Button>
                      }
                    />
                  </Card>
                )}

                {chartPayload && !chartLoading && (
                  <>
                    <SimStatsGrid stats={chartPayload.stats} />

                    <div className="flex gap-3 min-w-0">
                      <Card className="flex-1 min-w-0">
                        <CardHeader>
                          <CardTitle>
                            {activeSymbol} {runDetail.timeframe} bars
                          </CardTitle>
                          <div className="flex items-center gap-3">
                            <span className="text-caption-1-regular tabular text-text-tertiary">
                              {runDetail.start_date} to {runDetail.end_date}
                            </span>
                            <Badge variant="muted">{chartPayload.trades.length} trades</Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <SimChart payload={chartPayload} />
                        </CardContent>
                      </Card>

                      <div className="w-56 shrink-0 flex flex-col gap-3 self-start">
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
                          <CardTitle>Equity and drawdown</CardTitle>
                          <span className="text-caption-1-regular tabular text-text-tertiary">
                            {fmtCurrency(chartPayload.stats.initial_capital)} to {fmtCurrency(chartPayload.stats.final_capital)}
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

                      <Card className="flex-1 min-w-0">
                        <CardHeader>
                          <CardTitle>Trades</CardTitle>
                          <Badge variant="muted">{chartPayload.trades.length}</Badge>
                        </CardHeader>
                        <div className="overflow-auto max-h-72">
                          {chartPayload.trades.length === 0 ? (
                            <EmptyState size="sm" icon={RiFlaskLine} title="No trades" description="This run closed no positions." />
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                  <TableHead>Side</TableHead>
                                  <TableHead>Entry</TableHead>
                                  <TableHead>Exit</TableHead>
                                  <TableHead className="text-right">Price</TableHead>
                                  <TableHead className="text-right">Qty</TableHead>
                                  <TableHead className="text-right">P&L</TableHead>
                                  <TableHead className="text-right">Return</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {chartPayload.trades.map((t, i) => (
                                  <TableRow key={i}>
                                    <TableCell>
                                      <Badge variant={t.side === "SELL" ? "down" : "up"}>{t.side === "SELL" ? "Sell" : "Buy"}</Badge>
                                    </TableCell>
                                    <TableCell className="text-text-tertiary whitespace-nowrap">{fmtStamp(t.entry_time)}</TableCell>
                                    <TableCell className="text-text-tertiary whitespace-nowrap">
                                      {t.exit_time ? fmtStamp(t.exit_time) : "n/a"}
                                    </TableCell>
                                    <TableCell className="text-right whitespace-nowrap">
                                      {t.entry_price.toFixed(2)}
                                      <span className="text-text-tertiary"> to </span>
                                      {t.exit_price?.toFixed(2) ?? "n/a"}
                                    </TableCell>
                                    <TableCell className="text-right">{t.quantity.toFixed(0)}</TableCell>
                                    <TableCell className={cn("text-right", pnlClass(t.pnl ?? 0))}>
                                      {t.pnl != null ? fmtCurrency(t.pnl) : "n/a"}
                                    </TableCell>
                                    <TableCell className={cn("text-right", pnlClass(t.pnl_pct ?? 0))}>
                                      {t.pnl_pct != null ? fmtPct(t.pnl_pct) : "n/a"}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
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

function RunRow({
  run: r,
  selected,
  onSelect,
  onDelete,
}: {
  run: SimRunSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className={cn(
        "w-full text-left px-4 py-2 border-b border-separator-border group transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
        selected ? "bg-background-secondary-default" : "hover:bg-background-secondary-hover"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full shrink-0",
            r.status === "running" && "bg-status-yellow-text animate-pulse",
            r.status === "completed" && "bg-status-lime-text",
            r.status === "error" && "bg-status-rose-text"
          )}
        />
        <span className="text-body-2-medium text-text-primary truncate flex-1">{r.label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete run"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-foreground-icon-tertiary hover:text-status-rose-text"
        >
          <RiDeleteBinLine />
        </Button>
      </div>
      <div className="flex items-center gap-3 pl-4 text-caption-1-regular tabular text-text-tertiary">
        <span>{r.timeframe}</span>
        <span>{r.symbols.length} symbols</span>
        {r.status === "running" ? (
          <span className="text-status-yellow-text">
            {r.progress.done} of {r.progress.total} {r.progress.current ?? ""}
          </span>
        ) : r.aggregate ? (
          <>
            <span className={pnlClass(r.aggregate.avg_return_pct)}>
              {r.aggregate.avg_return_pct >= 0 ? "+" : ""}
              {r.aggregate.avg_return_pct.toFixed(1)}%
            </span>
            <span>PF {r.aggregate.profit_factor.toFixed(2)}</span>
          </>
        ) : (
          <span className="text-status-rose-text">Failed</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <span className="text-caption-1-medium text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}
