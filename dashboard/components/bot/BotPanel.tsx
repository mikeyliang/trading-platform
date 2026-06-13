"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BotGate, type BotSnapshot, type SimPreset } from "@/lib/api";
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
import { Bot as BotIcon, Loader2, Play, ShieldAlert, ShieldCheck, Square, X } from "lucide-react";
import { NewsAnalystCard } from "@/components/sim/NewsAnalystCard";
import { EquityCurveChart } from "@/components/backtest/EquityCurveChart";

const TIMEFRAMES = ["15m", "30m", "1h", "4h", "1d"];

const KIND_STYLE: Record<string, { text: string; chip: string }> = {
  entry:     { text: "text-up",          chip: "bg-up/10 text-up" },
  exit:      { text: "text-text-primary", chip: "bg-surface-3 text-text-primary" },
  blocked:   { text: "text-amber-400",   chip: "bg-amber-400/10 text-amber-400" },
  news:      { text: "text-text-muted",  chip: "bg-surface-2 text-text-muted" },
  data:      { text: "text-text-muted",  chip: "bg-surface-2 text-text-muted" },
  error:     { text: "text-down",        chip: "bg-down/10 text-down" },
  lifecycle: { text: "text-accent",      chip: "bg-accent/10 text-accent" },
};

type LogFilter = "all" | "trades" | "blocked" | "system";

export function BotPanel() {
  const [snap, setSnap] = useState<BotSnapshot | null>(null);
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
      setSnap(s);
      if (!seededRef.current) {
        seededRef.current = true;
        setSymbols(s.config.symbols);
        setTimeframe(s.config.timeframe);
        setPreset(s.config.preset);
        setCapital(s.config.initial_capital);
        setMaxPositions(s.config.max_positions);
        setNewsGate(s.config.news_gate);
      }
    } catch {
      /* api down — keep last snapshot */
    }
  }, []);

  useEffect(() => {
    refresh();
    api.simPresets().then((p) => setPresets(p.presets)).catch(() => {});
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
      setSnap(s);
      toast.success("Bot started", { description: `paper trading · ${symbols.length} symbols · ${timeframe}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed";
      if (msg.includes("409")) {
        toast.error("Blocked: no validating simulation", {
          description: "Run a sim with this preset+timeframe first (PF ≥ 1, positive return).",
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
      setSnap(await api.botStop());
      toast("Bot stopped");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      setSnap(await api.botReset());
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

  const positions = snap ? Object.entries(snap.positions) : [];
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
    <div className="flex h-full min-h-0 gap-4 p-4 bg-bg overflow-hidden">
      {/* ════ left rail: control ════ */}
      <div className="w-72 shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <BotIcon size={12} /> Paper bot
            </CardTitle>
            <Badge variant={running ? "up" : "muted"}>{running ? "RUNNING" : "STOPPED"}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* sim gate */}
            <div
              className={cn(
                "rounded border px-2 py-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed",
                gate?.validated
                  ? "border-up/30 bg-up/5 text-up"
                  : "border-amber-400/30 bg-amber-400/5 text-amber-400"
              )}
            >
              {gate?.validated
                ? <ShieldCheck size={12} className="mt-0.5 shrink-0" />
                : <ShieldAlert size={12} className="mt-0.5 shrink-0" />}
              {gate?.validated && gate.run ? (
                <span>
                  Sim-validated <span className="tabular">{gate.run.id}</span> · PF{" "}
                  <span className="tabular">{gate.run.aggregate.profit_factor.toFixed(2)}</span> · avg{" "}
                  <span className="tabular">
                    {gate.run.aggregate.avg_return_pct >= 0 ? "+" : ""}
                    {gate.run.aggregate.avg_return_pct.toFixed(2)}%
                  </span>
                </span>
              ) : (
                <span>No completed sim validates {preset} on {timeframe} — run one on the Simulate page.</span>
              )}
            </div>

            <Field label="Strategy preset">
              <Select value={preset} onValueChange={setPreset} disabled={running}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={`Symbols (${symbols.length}/12)`}>
              <div className="flex flex-wrap gap-1">
                {symbols.map((s) => (
                  <span key={s} className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded bg-surface-2 text-[10px] tabular">
                    {s}
                    {!running && (
                      <button onClick={() => setSymbols(symbols.filter((x) => x !== s))} className="text-text-muted hover:text-down">
                        <X size={9} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {!running && (
                <Input
                  value={symbolInput}
                  placeholder="add symbol ⏎"
                  onChange={(e) => setSymbolInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSymbol()}
                  onBlur={addSymbol}
                  className="mt-1"
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Timeframe">
                <Select value={timeframe} onValueChange={setTimeframe} disabled={running}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Max positions">
                <Input type="number" value={maxPositions} disabled={running}
                  onChange={(e) => setMaxPositions(Math.max(1, Math.min(12, +e.target.value)))} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2 items-end">
              <Field label="Capital ($)">
                <Input type="number" value={capital} disabled={running}
                  onChange={(e) => setCapital(+e.target.value)} />
              </Field>
              <button
                type="button"
                onClick={() => !running && setNewsGate((v) => !v)}
                className={cn(
                  "flex items-center justify-between h-7 px-2 rounded border text-[10px] uppercase tracking-wider transition-colors",
                  newsGate ? "border-accent/40 bg-accent/5 text-accent" : "border-border text-text-muted",
                  running && "opacity-60 cursor-default"
                )}
              >
                News gate
                <span className="tabular">{newsGate ? "ON" : "OFF"}</span>
              </button>
            </div>

            {running ? (
              <Button onClick={stop} disabled={busy} variant="destructive" size="lg">
                {busy ? <Loader2 className="animate-spin" /> : <Square />}
                stop bot
              </Button>
            ) : (
              <Button onClick={() => start(false)} disabled={busy || symbols.length === 0} size="lg">
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                start paper bot
              </Button>
            )}
            <div className="flex items-center justify-between">
              {!running && !gate?.validated ? (
                <button onClick={() => start(true)} className="text-[10px] text-amber-400/80 hover:text-amber-400 underline underline-offset-2">
                  start anyway
                </button>
              ) : <span />}
              {!running && snap && snap.trade_count > 0 && (
                <button onClick={reset} className="text-[10px] text-text-muted hover:text-down">
                  reset paper account
                </button>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="text-[10px] leading-relaxed text-text-muted px-1">
          Paper execution only — fills simulated at bar close with slippage, on the
          same signal engine the simulator validates. Live order routing stays off
          until paper results earn it.
        </p>

        {/* AI read for the first held symbol */}
        {positions.length > 0 && <NewsAnalystCard symbol={positions[0][0]} />}
      </div>

      {/* ════ main: status → live → activity ════ */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0 overflow-hidden">
        {/* status strip: account + config at a glance */}
        {snap && (
          <div className="shrink-0 grid grid-cols-4 lg:grid-cols-8 border border-border rounded-md overflow-hidden bg-surface-1">
            {[
              { l: "Equity", v: fmtCurrency(snap.equity) },
              { l: "Return", v: `${snap.total_return_pct >= 0 ? "+" : ""}${snap.total_return_pct.toFixed(2)}%`, c: pnlClass(snap.total_return_pct) },
              { l: "Cash", v: fmtCurrency(snap.cash) },
              { l: "Open", v: `${snap.open_count}/${snap.config.max_positions}` },
              { l: "Closed · Win", v: `${snap.trade_count} · ${snap.win_rate.toFixed(0)}%` },
              { l: "Strategy", v: `${snap.config.preset.replace("confluence-", "")} · ${snap.config.timeframe}` },
              { l: "News gate", v: snap.config.news_gate ? "ON" : "OFF", c: snap.config.news_gate ? "text-accent" : "text-text-muted" },
              {
                l: "Last cycle",
                v: snap.last_cycle_at
                  ? new Date(snap.last_cycle_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                  : "—",
              },
            ].map((c) => (
              <div key={c.l} className="px-2 py-1.5 border-r border-b lg:border-b-0 border-border/50 last:border-r-0">
                <div className="text-[9px] uppercase tracking-wider text-text-muted leading-tight whitespace-nowrap">{c.l}</div>
                <div className={cn("text-xs tabular leading-tight mt-0.5 whitespace-nowrap", c.c ?? "text-text-primary")}>{c.v}</div>
              </div>
            ))}
          </div>
        )}

        {snap?.last_error && (
          <p className="shrink-0 text-xs text-down bg-down/10 border border-down/20 rounded px-2 py-1.5">
            last cycle error: {snap.last_error}
          </p>
        )}

        {/* two columns: live state | activity feed */}
        <div className="flex-1 min-h-0 flex gap-3">
          {/* left: positions + equity + closed trades */}
          <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
            <Card className="overflow-hidden shrink-0">
              <CardHeader>
                <CardTitle>Open positions</CardTitle>
                <Badge variant="muted">{positions.length}/{snap?.config.max_positions ?? "—"}</Badge>
              </CardHeader>
              {positions.length === 0 ? (
                <p className="text-[11px] text-text-muted px-3 pb-2.5">
                  flat — waiting for a confluence entry{snap?.config.news_gate ? " that clears the news gate" : ""}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>symbol</TableHead>
                      <TableHead className="text-right">qty</TableHead>
                      <TableHead className="text-right">entry</TableHead>
                      <TableHead className="text-right">last</TableHead>
                      <TableHead className="text-right">stop</TableHead>
                      <TableHead className="text-right">target</TableHead>
                      <TableHead className="text-right">uP&L</TableHead>
                      <TableHead>score</TableHead>
                      <TableHead>news</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map(([sym, p]) => {
                      const upnl = (p.last_price - p.entry_price) * p.qty;
                      return (
                        <TableRow key={sym}>
                          <TableCell className="tabular font-medium">{sym}</TableCell>
                          <TableCell className="text-right tabular">{p.qty}</TableCell>
                          <TableCell className="text-right tabular">{p.entry_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right tabular">{p.last_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right tabular text-down/80">{p.stop.toFixed(2)}</TableCell>
                          <TableCell className="text-right tabular text-up/80">{p.target.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right tabular", pnlClass(upnl))}>{fmtCurrency(upnl)}</TableCell>
                          <TableCell className="tabular">{p.entry_score}/7</TableCell>
                          <TableCell>
                            <span className={cn("text-[10px]",
                              p.news_verdict === "bullish" ? "text-up" : p.news_verdict === "bearish" ? "text-down" : "text-text-muted")}>
                              {p.news_verdict}
                              {p.news_bias != null ? ` ${p.news_bias >= 0 ? "+" : ""}${p.news_bias.toFixed(2)}` : ""}
                            </span>
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
                  <span className="ml-auto text-[10px] tabular text-text-muted">
                    {fmtCurrency(snap.config.initial_capital)} → {fmtCurrency(snap.equity)}
                  </span>
                </CardHeader>
                <CardContent>
                  <EquityCurveChart equity={snap.equity_history} initialCapital={snap.config.initial_capital} height={150} ddHeight={48} />
                </CardContent>
              </Card>
            )}

            <Card className="overflow-hidden shrink-0">
              <CardHeader>
                <CardTitle>Closed trades</CardTitle>
                <Badge variant="muted">{snap?.trade_count ?? 0}</Badge>
              </CardHeader>
              {(snap?.closed_trades.length ?? 0) === 0 ? (
                <p className="text-[11px] text-text-muted px-3 pb-2.5">none yet</p>
              ) : (
                <div className="overflow-auto max-h-64">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>symbol</TableHead>
                        <TableHead>exit</TableHead>
                        <TableHead className="text-right">qty</TableHead>
                        <TableHead className="text-right">entry</TableHead>
                        <TableHead className="text-right">exit $</TableHead>
                        <TableHead className="text-right">P&L</TableHead>
                        <TableHead>reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snap!.closed_trades.slice().reverse().map((t, i) => (
                        <TableRow key={i}>
                          <TableCell className="tabular">{t.symbol}</TableCell>
                          <TableCell className="text-text-muted whitespace-nowrap">
                            {new Date(t.exit_time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </TableCell>
                          <TableCell className="text-right tabular">{t.qty}</TableCell>
                          <TableCell className="text-right tabular">{t.entry_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right tabular">{t.exit_price.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right tabular", pnlClass(t.pnl))}>
                            {fmtCurrency(t.pnl)} <span className="text-[9px]">({fmtPct(t.pnl_pct)})</span>
                          </TableCell>
                          <TableCell className="text-text-muted">{t.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </div>

          {/* right: decision log, full height */}
          <Card className="w-[380px] shrink-0 flex flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>Decision log</CardTitle>
              <div className="ml-auto flex items-center gap-0.5">
                {(["all", "trades", "blocked", "system"] as LogFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setLogFilter(f)}
                    className={cn(
                      "px-1.5 h-5 rounded text-[9px] uppercase tracking-wider transition-colors",
                      logFilter === f ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </CardHeader>
            <div className="flex-1 overflow-y-auto">
              {decisions.length === 0 && (
                <p className="text-[11px] text-text-muted px-3 py-2">
                  {logFilter === "all"
                    ? "no activity yet — every entry, exit, and news block lands here"
                    : "nothing in this filter"}
                </p>
              )}
              {decisions.map((d, i) => (
                <div key={i} className="px-3 py-1.5 border-b border-border/30">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("px-1 rounded text-[9px] uppercase tracking-wider", (KIND_STYLE[d.kind] ?? KIND_STYLE.news).chip)}>
                      {d.kind}
                    </span>
                    {d.symbol !== "*" && <span className="text-[10px] tabular font-medium">{d.symbol}</span>}
                    <span className="ml-auto text-[9px] tabular text-text-muted whitespace-nowrap">
                      {new Date(d.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-[10px] leading-snug text-text-secondary mt-0.5">{d.message}</p>
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
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-text-muted uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}
