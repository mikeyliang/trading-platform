"use client";

import { useEffect, useState } from "react";
import { api, type StrategySchema } from "@/lib/api";
import { useStore } from "@/lib/store";
import { fmtCurrency, fmtPct, pnlClass, cn } from "@/lib/utils";
import type { BacktestRequest, BacktestResult } from "@/types";
import { Play, Loader2, ChevronDown } from "lucide-react";
import dynamic from "next/dynamic";
import { SchemaForm } from "@/components/ui/schema-form";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Stat, StatGroup } from "@/components/ui/stat";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toaster";

const BacktestChart = dynamic(
  () => import("./BacktestChart").then((m) => m.BacktestChart),
  { ssr: false },
);

const STRATEGIES = ["smi-short", "smi-mid", "ema-cross"];
const SYMBOLS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "TSLA",
  "GOOGL",
  "META",
  "AMD",
  "JPM",
  "XOM",
  "AMZN",
];
const TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d"];

export function BacktestPanel() {
  const [form, setForm] = useState<BacktestRequest>({
    strategy: "smi-short",
    symbol: "AAPL",
    timeframe: "15m",
    start_date: "2024-01-01",
    end_date: "2024-12-31",
    initial_capital: 100_000,
    params: {},
  });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [schema, setSchema] = useState<StrategySchema | null>(null);
  const setLastBacktest = useStore((s) => s.setLastBacktest);
  const pendingSuggestion = useStore((s) => s.pendingSuggestion);
  const consumePending = useStore((s) => s.consumePendingSuggestion);

  useEffect(() => {
    api
      .strategySchema(form.strategy)
      .then(setSchema)
      .catch(() => setSchema(null));
  }, [form.strategy]);

  // When the agent proposes params, accept them into this form
  useEffect(() => {
    if (!pendingSuggestion || pendingSuggestion.consumed) return;
    setForm((f) => ({
      ...f,
      strategy: pendingSuggestion.strategy || f.strategy,
      params: { ...(f.params ?? {}), ...pendingSuggestion.params },
    }));
    setShowAdvanced(true);
    consumePending();
    toast("Agent suggestion applied", {
      description: `${Object.keys(pendingSuggestion.params).length} param(s) staged in the form.`,
    });
  }, [pendingSuggestion, consumePending]);

  const paramCount = Object.keys(form.params ?? {}).length;

  const run = async () => {
    setRunning(true);
    setError(null);
    const toastId = toast.loading(
      `Running backtest: ${form.strategy} on ${form.symbol}…`,
    );
    try {
      const r = await api.runBacktest(form);
      setResult(r);
      setLastBacktest(r);
      toast.success("Backtest complete", {
        id: toastId,
        description: `${r.total_trades} trades · ${r.total_return_pct.toFixed(2)}% return`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "backtest failed";
      setError(msg);
      toast.error("Backtest failed", { id: toastId, description: msg });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-4 p-4 bg-bg overflow-hidden">
      {/* config panel */}
      <Card className="w-72 shrink-0 flex flex-col">
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 overflow-y-auto">
          <Field label="Strategy">
            <Select
              value={form.strategy}
              onValueChange={(v) => setForm({ ...form, strategy: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Symbol">
            <Select
              value={form.symbol}
              onValueChange={(v) => setForm({ ...form, symbol: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYMBOLS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Timeframe">
            <Select
              value={form.timeframe}
              onValueChange={(v) => setForm({ ...form, timeframe: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEFRAMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Start Date">
            <Input
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </Field>

          <Field label="End Date">
            <Input
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
            />
          </Field>

          <Field label="Capital ($)">
            <Input
              type="number"
              value={form.initial_capital}
              onChange={(e) =>
                setForm({ ...form, initial_capital: +e.target.value })
              }
            />
          </Field>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary transition-colors mt-1"
          >
            <ChevronDown
              size={11}
              className={cn(
                "transition-transform",
                showAdvanced && "rotate-180",
              )}
            />
            Parameters
            {paramCount > 0 && (
              <span className="ml-auto text-[10px] text-accent">
                {paramCount} overridden
              </span>
            )}
          </button>

          {showAdvanced && (
            <div className="pl-3 border-l border-border/60">
              <SchemaForm
                schema={schema}
                value={form.params ?? {}}
                onChange={(params) => setForm({ ...form, params })}
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-down bg-down/10 border border-down/20 rounded px-2 py-1.5">
              {error}
            </p>
          )}

          <Button
            onClick={run}
            disabled={running}
            variant="default"
            size="lg"
            className="mt-2"
          >
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            {running ? "running…" : "run backtest"}
          </Button>
        </CardContent>
      </Card>

      {/* results */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-4">
        {!result && !running && (
          <Card className="flex-1 flex items-center justify-center">
            <p className="text-text-muted text-sm">
              configure and run a backtest to see results
            </p>
          </Card>
        )}

        {running && (
          <Card className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-text-muted text-sm">
              <Loader2 size={18} className="animate-spin" />
              <span>running backtest…</span>
            </div>
          </Card>
        )}

        {result && !running && (
          <>
            <Card>
              <CardContent className="flex flex-col md:flex-row gap-4 md:items-center p-4">
                <Stat
                  size="lg"
                  label="Total return"
                  tone={result.total_return >= 0 ? "up" : "down"}
                  value={fmtPct(result.total_return_pct)}
                  hint={fmtCurrency(result.total_return)}
                  className="md:w-44 md:pr-4 md:border-r md:border-border/40"
                />
                <StatGroup className="flex-1">
                  <Stat
                    label="Final"
                    value={fmtCurrency(result.final_capital)}
                    hint={`from ${fmtCurrency(result.initial_capital)}`}
                  />
                  <Stat
                    label="Max drawdown"
                    tone="down"
                    value={fmtPct(result.max_drawdown_pct)}
                    hint={fmtCurrency(result.max_drawdown)}
                  />
                  <Stat
                    label="Sharpe"
                    tone={
                      result.sharpe_ratio > 1
                        ? "up"
                        : result.sharpe_ratio < 0
                          ? "down"
                          : "default"
                    }
                    value={result.sharpe_ratio.toFixed(2)}
                  />
                  <Stat
                    label="Win rate"
                    tone={result.win_rate > 50 ? "up" : "down"}
                    value={result.win_rate.toFixed(1) + "%"}
                    hint={`${result.winning_trades}W / ${result.losing_trades}L`}
                  />
                  <Stat
                    label="Profit factor"
                    tone={result.profit_factor > 1 ? "up" : "down"}
                    value={result.profit_factor.toFixed(2)}
                  />
                  <Stat
                    label="Trades"
                    value={result.total_trades.toString()}
                    hint={`avg win ${fmtCurrency(result.avg_win)}`}
                  />
                </StatGroup>
              </CardContent>
            </Card>

            {/* unified chart: candles + EMA + signal arrows + SMI subpane + equity */}
            <Card>
              <CardHeader>
                <CardTitle>Signals on chart</CardTitle>
                <Badge variant="muted">{result.trades.length} fills</Badge>
              </CardHeader>
              <CardContent>
                <BacktestChart result={result} />
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Trades</CardTitle>
                <Badge variant="muted">{result.trades.length}</Badge>
              </CardHeader>
              <div className="overflow-auto max-h-72">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>entry</TableHead>
                      <TableHead>exit</TableHead>
                      <TableHead className="text-right">entry $</TableHead>
                      <TableHead className="text-right">exit $</TableHead>
                      <TableHead className="text-right">qty</TableHead>
                      <TableHead className="text-right">P&amp;L</TableHead>
                      <TableHead className="text-right">P&amp;L %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.trades.map((t, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-text-muted">
                          {new Date(t.entry_time).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-text-muted">
                          {t.exit_time
                            ? new Date(t.exit_time).toLocaleDateString()
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {t.entry_price.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {t.exit_price?.toFixed(2) ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {t.quantity.toFixed(1)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular",
                            pnlClass(t.pnl ?? 0),
                          )}
                        >
                          {t.pnl != null ? fmtCurrency(t.pnl) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {t.pnl_pct != null ? (
                            <Badge
                              variant={t.pnl_pct >= 0 ? "up" : "down"}
                              className="tabular"
                            >
                              {fmtPct(t.pnl_pct)}
                            </Badge>
                          ) : (
                            <span className="text-text-muted">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-text-muted uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}
