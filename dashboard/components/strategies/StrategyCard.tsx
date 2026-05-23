"use client";

import { useEffect, useState } from "react";
import { api, type StrategySchema } from "@/lib/api";
import { cn, fmtCurrency } from "@/lib/utils";
import type { StrategyInfo } from "@/types";
import { Play, Square, Loader2, Sliders } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toaster";
import { SchemaForm } from "@/components/ui/schema-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

export function StrategyCard({ strategy, onUpdate }: { strategy: StrategyInfo; onUpdate: () => void }) {
  const [loading, setLoading] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [schema, setSchema] = useState<StrategySchema | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>(strategy.params ?? {});

  useEffect(() => {
    if (showParams && !schema) {
      api.strategySchema(strategy.id).then(setSchema).catch(() => null);
    }
  }, [showParams, schema, strategy.id]);

  const running = strategy.status === "running";

  const doStart = async () => {
    setLoading(true);
    try {
      await api.strategyStart(strategy.id, strategy.symbols, strategy.timeframe, strategy.params);
      toast.success(`Strategy ${strategy.name} started`);
      onUpdate();
    } catch (e) {
      toast.error(`Failed to start ${strategy.name}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  const doStop = async () => {
    setConfirmStop(false);
    setLoading(true);
    try {
      await api.strategyStop(strategy.id);
      toast(`Strategy ${strategy.name} stopped`);
      onUpdate();
    } catch (e) {
      toast.error(`Failed to stop ${strategy.name}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  const onToggle = () => {
    if (running) setConfirmStop(true);
    else doStart();
  };

  const saveParams = async () => {
    setShowParams(false);
    if (running) {
      // restart with the new params
      try {
        await api.strategyStop(strategy.id);
        await api.strategyStart(strategy.id, strategy.symbols, strategy.timeframe, params);
        toast.success("Params updated", { description: "Strategy restarted with new config." });
        onUpdate();
      } catch (e) {
        toast.error("Failed to apply params", {
          description: e instanceof Error ? e.message : undefined,
        });
      }
    } else {
      // not running yet — just remember; will apply on next start
      strategy.params = params as any;
      toast("Params saved", { description: "Will apply when you start the strategy." });
    }
  };

  return (
    <Card
      className={cn(
        "transition-colors",
        running ? "border-accent/40 bg-surface-2" : "border-border bg-surface"
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{strategy.name}</span>
              <Badge variant={running ? "up" : "muted"}>{strategy.status}</Badge>
            </div>
            <p className="text-xs text-text-muted mt-1">{strategy.description}</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setShowParams(true)}
                variant="ghost"
                size="icon-sm"
                aria-label="Edit parameters"
                className="shrink-0"
              >
                <Sliders />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Edit parameters</TooltipContent>
          </Tooltip>
          <Button
            onClick={onToggle}
            disabled={loading}
            variant={running ? "destructive" : "success"}
            size="sm"
            className="shrink-0"
          >
            {loading ? (
              <Loader2 className="animate-spin" />
            ) : running ? (
              <Square />
            ) : (
              <Play />
            )}
            {running ? "stop" : "start"}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1">
          {strategy.symbols.map((s) => (
            <Badge key={s} variant="default">
              {s}
            </Badge>
          ))}
          <Badge variant="accent">{strategy.timeframe}</Badge>
        </div>

        <Separator />

        <div className="grid grid-cols-3 gap-3">
          <Metric label="P&L" value={fmtCurrency(strategy.pnl)} tone={strategy.pnl >= 0 ? "up" : "down"} />
          <Metric label="Trades" value={strategy.trades.toString()} />
          <Metric
            label="Win Rate"
            value={strategy.win_rate.toFixed(1) + "%"}
            tone={strategy.win_rate >= 50 ? "up" : strategy.win_rate >= 30 ? undefined : "down"}
          />
        </div>

        {strategy.params && Object.keys(strategy.params).length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-muted pt-1 border-t border-border/60">
            {Object.entries(strategy.params).map(([k, v]) => (
              <span key={k}>
                {k}: <span className="text-text-secondary tabular">{String(v)}</span>
              </span>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {strategy.name}?</DialogTitle>
            <DialogDescription>
              This will halt the scan loop. Any open positions/spreads remain — they will not be auto-closed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={doStop}>
              Stop strategy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showParams} onOpenChange={setShowParams}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{strategy.name} · Parameters</DialogTitle>
            <DialogDescription>
              {running
                ? "Changes will restart the strategy with the new config."
                : "Saved values will be applied on next start."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <SchemaForm schema={schema} value={params} onChange={setParams} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="default" size="sm" onClick={saveParams}>
              {running ? "Restart with new params" : "Save params"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-text-muted uppercase tracking-wider">{label}</span>
      <span
        className={cn(
          "tabular text-sm font-semibold",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-primary"
        )}
      >
        {value}
      </span>
    </div>
  );
}
