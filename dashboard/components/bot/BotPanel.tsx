"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BotGate, type BotSnapshot, type SimPreset } from "@/lib/api";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatGroup } from "@/components/ui/stat";
import { ToggleGroup } from "@/components/ui/toggle-group";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toaster";
import {
  RiErrorWarningFill,
  RiFileList3Line,
  RiLoader4Line,
  RiPlayFill,
  RiRobot2Line,
  RiShieldCheckFill,
  RiShieldFlashFill,
  RiStackLine,
  RiStopFill,
} from "@remixicon/react";
import { NewsAnalystCard } from "@/components/sim/NewsAnalystCard";
import { SymbolChip } from "@/components/sim/SymbolChip";
import { EquityCurveChart } from "@/components/backtest/EquityCurveChart";

const TIMEFRAMES = ["15m", "30m", "1h", "4h", "1d"];

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const KIND_VARIANT: Record<string, BadgeVariant> = {
  entry: "up",
  exit: "default",
  blocked: "warning",
  news: "muted",
  data: "muted",
  error: "down",
  lifecycle: "accent",
};

type LogFilter = "all" | "trades" | "blocked" | "system";

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function BotPanel() {
  const [snap, setSnap] = useState<BotSnapshot | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [snapLoaded, setSnapLoaded] = useState(false);
  // The API answers with an object carrying `config`; anything else (an
  // empty body while the bot boots, a proxy error page) renders as "no bot".
  const asSnap = (v: unknown): BotSnapshot | null =>
    v && typeof v === "object" && !Array.isArray(v) && "config" in v ? (v as BotSnapshot) : null;
  const [gate, setGate] = useState<BotGate | null>(null);
  const [presets, setPresets] = useState<SimPreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");

  // config (editable while stopped)
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbolInput, setSymbolInput] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [preset, setPreset] = useState("confluence-core");
  const [capital, setCapital] = useState(100_000);
  const [maxPositions, setMaxPositions] = useState(3);
  const [newsGate, setNewsGate] = useState(true);
  const seededRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.botStatus();
      setSnap(asSnap(s));
      setSnapError(null);
      if (!seededRef.current) {
        seededRef.current = true;
        setSymbols(s.config.symbols);
        setTimeframe(s.config.timeframe);
        setPreset(s.config.preset);
        setCapital(s.config.initial_capital);
        setMaxPositions(s.config.max_positions);
        setNewsGate(s.config.news_gate);
      }
    } catch (e) {
      /* api down, keep last snapshot */
      setSnapError(e instanceof Error ? e.message : "Bot status unavailable");
    } finally {
      setSnapLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.simPresets().then((p) => setPresets(Array.isArray(p?.presets) ? p.presets : [])).catch(() => {});
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    api.botGate(preset, timeframe).then(setGate).catch(() => setGate(null));
  }, [preset, timeframe]);

  const running = snap?.status === "running";

  const start = async (force = false) => {
    setBusy(true);
    try {
      const s = await api.botStart({
        symbols, timeframe, preset, initial_capital: capital,
        max_positions: maxPositions, news_gate: newsGate, force,
      });
      setSnap(asSnap(s));
      toast.success("Bot started", { description: `Paper trading, ${symbols.length} symbols, ${timeframe}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed";
      if (msg.includes("409")) {
        toast.error("Blocked: no validating simulation", {
          description: "Run a sim with this preset and timeframe first (PF at least 1, positive return).",
        });
      } else {
        toast.error("Start failed", { description: msg });
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      setSnap(asSnap(await api.botStop()));
      toast("Bot stopped");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      setSnap(asSnap(await api.botReset()));
      toast("Paper account reset");
    } catch {
      toast.error("Stop the bot before resetting");
    }
  };

  const addSymbol = () => {
    const s = symbolInput.trim().toUpperCase();
    if (s && !symbols.includes(s) && symbols.length < 12) setSymbols([...symbols, s]);
    setSymbolInput("");
  };

  const positions = snap ? Object.entries(snap.positions ?? {}) : [];
  const decisions = (snap?.decisions ?? [])
    .filter((d) => {
      if (logFilter === "all") return true;
      if (logFilter === "trades") return d.kind === "entry" || d.kind === "exit";
      if (logFilter === "blocked") return d.kind === "blocked";
      return d.kind === "lifecycle" || d.kind === "error" || d.kind === "data" || d.kind === "news";
    })
    .slice()
    .reverse();

  return (
    <div className="flex h-full min-h-0 gap-3 p-3 overflow-hidden">
      {/* ════ left rail: control ════ */}
      <div className="w-80 shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto">
        <Card className="shrink-0">
          <CardHeader>
            <CardTitle>Paper bot</CardTitle>
            <Badge variant={running ? "up" : "muted"}>{running ? "Running" : "Stopped"}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* sim gate */}
            <div
              className={cn(
                "flex items-start gap-2 text-caption-1-regular text-text-secondary"
              )}
            >
              {gate?.validated
                ? <RiShieldCheckFill size={16} className="mt-px shrink-0 text-status-lime-text" aria-hidden />
                : <RiShieldFlashFill size={16} className="mt-px shrink-0 text-status-yellow-text" aria-hidden />}
              {gate?.validated && gate.run ? (
                <span>
                  Validated by sim <span className="tabular">{gate.run.id}</span>, profit factor{" "}
                  <span className="tabular">{gate.run.aggregate.profit_factor.toFixed(2)}</span>, avg return{" "}
                  <span className="tabular">
                    {gate.run.aggregate.avg_return_pct >= 0 ? "+" : ""}
                    {gate.run.aggregate.avg_return_pct.toFixed(2)}%
                  </span>
                </span>
              ) : (
                <span>No completed sim validates {preset} on {timeframe}. Run one on the Simulate page first.</span>
              )}
            </div>

            <Field label="Strategy preset">
              <Select value={presets.some((p) => p.id === preset) ? preset : ""} onValueChange={setPreset} disabled={running}>
                <SelectTrigger><SelectValue placeholder="Choose a preset" /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={`Symbols (${symbols.length} of 12)`}>
              {symbols.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {symbols.map((s) => (
                    <SymbolChip
                      key={s}
                      symbol={s}
                      onRemove={running ? undefined : () => setSymbols(symbols.filter((x) => x !== s))}
                    />
                  ))}
                </div>
              )}
              {!running && (
                <Input
                  value={symbolInput}
                  placeholder="Add a symbol and press Enter"
                  onChange={(e) => setSymbolInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSymbol()}
                  onBlur={addSymbol}
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Timeframe">
                <Select value={timeframe} onValueChange={setTimeframe} disabled={running}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Max positions">
                <Input type="number" className="tabular" value={maxPositions} disabled={running}
                  onChange={(e) => setMaxPositions(Math.max(1, Math.min(12, +e.target.value)))} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Capital ($)">
                <Input type="number" className="tabular" value={capital} disabled={running}
                  onChange={(e) => setCapital(+e.target.value)} />
              </Field>
              <Field label="News gate">
                <div className={cn("flex h-8 items-center", running && "opacity-60 pointer-events-none")}>
                  <ToggleGroup
                    ariaLabel="News gate"
                    value={newsGate ? "on" : "off"}
                    onChange={(v) => !running && setNewsGate(v === "on")}
                    options={[
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                  />
                </div>
              </Field>
            </div>

            {running ? (
              <Button onClick={stop} disabled={busy} variant="destructive">
                {busy ? <RiLoader4Line className="animate-spin" /> : <RiStopFill />}
                Stop bot
              </Button>
            ) : (
              <Button onClick={() => start(false)} disabled={busy || symbols.length === 0} variant="default">
                {busy ? <RiLoader4Line className="animate-spin" /> : <RiPlayFill />}
                Start paper bot
              </Button>
            )}
            {!running && (!gate?.validated || (snap && snap.trade_count > 0)) && (
              <div className="flex items-center justify-between gap-2">
                {!gate?.validated ? (
                  <Button variant="secondary" size="sm" onClick={() => start(true)}>
                    Start anyway
                  </Button>
                ) : <span />}
                {snap && snap.trade_count > 0 && (
                  <Button variant="secondary" size="sm" onClick={reset}>
                    Reset paper account
                  </Button>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="h-auto py-3">
            <p className="text-caption-1-regular text-text-tertiary">
              Paper execution only. Fills are simulated at bar close with slippage, on the
              same signal engine the simulator validates. Live order routing stays off
              until paper results earn it.
            </p>
          </CardFooter>
        </Card>

        {/* AI read for the first held symbol */}
        {positions.length > 0 && <NewsAnalystCard symbol={positions[0][0]} />}
      </div>

      {/* ════ main: status → live → activity ════ */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0 overflow-hidden">
        {/* status: account + config at a glance */}
        <Card className="shrink-0">
          {!snapLoaded ? (
            <CardContent>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }} role="status" aria-label="Loading bot status">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            </CardContent>
          ) : snap ? (
            <CardContent>
              <StatGroup>
                <Stat label="Equity" value={fmtCurrency(snap.equity)} />
                <Stat
                  label="Return"
                  value={`${snap.total_return_pct >= 0 ? "+" : ""}${snap.total_return_pct.toFixed(2)}%`}
                  tone={snap.total_return_pct > 0 ? "up" : snap.total_return_pct < 0 ? "down" : "default"}
                />
                <Stat label="Cash" value={fmtCurrency(snap.cash)} />
                <Stat label="Open positions" value={`${snap.open_count} of ${snap.config.max_positions}`} />
                <Stat label="Closed trades" value={snap.trade_count} />
                <Stat label="Win rate" value={`${snap.win_rate.toFixed(0)}%`} />
                <Stat label="Strategy" value={`${snap.config.preset.replace("confluence-", "")} ${snap.config.timeframe}`} />
                <Stat label="News gate" value={snap.config.news_gate ? "On" : "Off"} tone={snap.config.news_gate ? "default" : "muted"} />
                <Stat
                  label="Last cycle"
                  value={
                    snap.last_cycle_at
                      ? new Date(snap.last_cycle_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                      : "n/a"
                  }
                />
              </StatGroup>
            </CardContent>
          ) : snapError ? (
            <EmptyState
              icon={RiErrorWarningFill}
              title="Bot status unavailable"
              description={snapError}
              action={<Button onClick={refresh}>Retry</Button>}
            />
          ) : (
            <EmptyState
              icon={RiRobot2Line}
              title="No bot yet"
              description="Configure the paper bot on the left and start it to see account figures here."
            />
          )}
          {snap?.last_error && (
            <CardContent className="pt-0">
              <div className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                <RiErrorWarningFill size={16} className="shrink-0 mt-0.5 text-status-rose-text" aria-hidden />
                <span>Last cycle error: {snap.last_error}</span>
              </div>
            </CardContent>
          )}
        </Card>

        {/* two columns: live state | activity feed */}
        <div className="flex-1 min-h-0 flex gap-3">
          {/* left: positions + equity + closed trades */}
          <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
            <Card className="shrink-0">
              <CardHeader>
                <CardTitle>Open positions</CardTitle>
                <Badge variant="muted">{positions.length} of {snap?.config?.max_positions ?? "n/a"}</Badge>
              </CardHeader>
              {positions.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={RiStackLine}
                  title="Flat"
                  description={`Waiting for a confluence entry${snap?.config.news_gate ? " that clears the news gate" : ""}.`}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead className="text-right">Last</TableHead>
                      <TableHead className="text-right">Stop</TableHead>
                      <TableHead className="text-right">Target</TableHead>
                      <TableHead className="text-right">Unrealized P&L</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead>News</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map(([sym, p]) => {
                      const upnl = (p.last_price - p.entry_price) * p.qty;
                      return (
                        <TableRow key={sym}>
                          <TableCell>{sym}</TableCell>
                          <TableCell className="text-right">{p.qty}</TableCell>
                          <TableCell className="text-right">{p.entry_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right">{p.last_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right text-status-rose-text">{p.stop.toFixed(2)}</TableCell>
                          <TableCell className="text-right text-status-lime-text">{p.target.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right", pnlClass(upnl))}>{fmtCurrency(upnl)}</TableCell>
                          <TableCell className="text-right">{p.entry_score} of 7</TableCell>
                          <TableCell>
                            <Badge
                              variant={p.news_verdict === "bullish" ? "up" : p.news_verdict === "bearish" ? "down" : "muted"}
                              className="tabular"
                            >
                              {p.news_verdict}
                              {p.news_bias != null ? ` ${p.news_bias >= 0 ? "+" : ""}${p.news_bias.toFixed(2)}` : ""}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Card>

            {snap && snap.equity_history.length > 2 && (
              <Card className="shrink-0">
                <CardHeader>
                  <CardTitle>Paper equity</CardTitle>
                  <span className="text-caption-1-regular tabular text-text-tertiary">
                    {fmtCurrency(snap.config.initial_capital)} to {fmtCurrency(snap.equity)}
                  </span>
                </CardHeader>
                <CardContent>
                  <EquityCurveChart equity={snap.equity_history} initialCapital={snap.config.initial_capital} height={150} ddHeight={48} />
                </CardContent>
              </Card>
            )}

            <Card className="shrink-0">
              <CardHeader>
                <CardTitle>Closed trades</CardTitle>
                <Badge variant="muted">{snap?.trade_count ?? 0}</Badge>
              </CardHeader>
              {(snap?.closed_trades.length ?? 0) === 0 ? (
                <EmptyState
                  size="sm"
                  icon={RiFileList3Line}
                  title="No closed trades"
                  description="Exits land here with their realized P&L."
                />
              ) : (
                <div className="overflow-auto max-h-64">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Symbol</TableHead>
                        <TableHead>Exit time</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Entry</TableHead>
                        <TableHead className="text-right">Exit</TableHead>
                        <TableHead className="text-right">P&L</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(snap?.closed_trades ?? []).slice().reverse().map((t, i) => (
                        <TableRow key={i}>
                          <TableCell>{t.symbol}</TableCell>
                          <TableCell className="text-text-tertiary whitespace-nowrap">{fmtStamp(t.exit_time)}</TableCell>
                          <TableCell className="text-right">{t.qty}</TableCell>
                          <TableCell className="text-right">{t.entry_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right">{t.exit_price.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right whitespace-nowrap", pnlClass(t.pnl))}>
                            {fmtCurrency(t.pnl)} <span className="text-caption-1-regular">({fmtPct(t.pnl_pct)})</span>
                          </TableCell>
                          <TableCell className="text-text-tertiary">{t.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </div>

          {/* right: decision log, full height */}
          <Card className="w-[380px] shrink-0 flex flex-col">
            <CardHeader>
              <CardTitle>Decision log</CardTitle>
              <ToggleGroup
                size="xs"
                ariaLabel="Log filter"
                value={logFilter}
                onChange={setLogFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "trades", label: "Trades" },
                  { value: "blocked", label: "Blocked" },
                  { value: "system", label: "System" },
                ]}
              />
            </CardHeader>
            <div className="flex-1 overflow-y-auto">
              {decisions.length === 0 && (
                <EmptyState
                  size="sm"
                  icon={RiFileList3Line}
                  title={logFilter === "all" ? "No activity yet" : "Nothing in this filter"}
                  description={logFilter === "all" ? "Every entry, exit and news block lands here." : undefined}
                />
              )}
              {decisions.map((d, i) => (
                <div key={i} className="px-4 py-2 border-b border-separator-border flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={KIND_VARIANT[d.kind] ?? "muted"}>{d.kind}</Badge>
                    {d.symbol !== "*" && <span className="text-caption-1-medium tabular text-text-primary">{d.symbol}</span>}
                    <span className="ml-auto text-caption-1-regular tabular text-text-tertiary whitespace-nowrap">
                      {fmtStamp(d.time)}
                    </span>
                  </div>
                  <p className="text-caption-1-regular text-text-secondary">{d.message}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>
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
