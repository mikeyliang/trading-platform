"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type OkwSummary, type OkwTrade, type OkwTradeCreate } from "@/lib/api";
import { cn, fmtCurrency } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Plus, X, CheckCircle2 } from "lucide-react";

const TRADE_TYPES = [
  { value: "rut",     label: "RUT" },
  { value: "mars",    label: "Mars" },
  { value: "marsmax", label: "Mars Max" },
  { value: "space",   label: "Space" },
];

const TRADE_TONE: Record<string, string> = {
  rut: "text-text-secondary",
  mars: "text-accent",
  marsmax: "text-warning",
  space: "text-up",
};

const EXIT_REASONS = [
  { value: "delta",  label: "Δ trigger" },
  { value: "2pct",   label: "2% rule" },
  { value: "profit", label: "Profit target" },
  { value: "manual", label: "Manual" },
];

export function OkwTracker() {
  const [trades, setTrades] = useState<OkwTrade[]>([]);
  const [summary, setSummary] = useState<OkwSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);

  const load = async () => {
    const r = await api.okwTrades({ status: statusFilter || undefined, limit: 200 });
    setTrades(r.trades);
    setSummary(await api.okwSummary().catch(() => null));
  };

  useEffect(() => { load(); }, [statusFilter]);

  return (
    <PageShell>
      <PageHeader
        eyebrow="OKW · trade tracker"
        title="Trade tracker"
        description="Log placed RUT / Mars / Mars Max / Space spreads. Mirrors Jamal's Options Kelly Workbook columns."
        actions={
          <div className="flex items-end gap-2 flex-wrap">
            <Field label="Status">
              <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
                <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button onClick={() => setShowAdd((v) => !v)} variant="default" size="sm">
              <Plus /> {showAdd ? "Hide form" : "Add trade"}
            </Button>
          </div>
        }
      />

      {summary && <SummaryStrip s={summary} />}

      {showAdd && (
        <AddForm
          onCreated={() => { setShowAdd(false); load(); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {trades.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-secondary">
          No trades logged yet.
          <div className="text-xs text-text-muted mt-1.5">
            Click <span className="text-text-primary">Add trade</span> after you place one
            to keep a running OKW.
          </div>
        </div>
      ) : (
        <TradesTable trades={trades} onRefresh={load} />
      )}
    </PageShell>
  );
}

// ─── Summary strip ────────────────────────────────────────────────────────────
function SummaryStrip({ s }: { s: OkwSummary }) {
  const winRate = s.closed > 0 ? Math.round((s.wins / s.closed) * 100) : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-x-8 gap-y-4 py-2">
      <Stat label="Total"      value={String(s.total)} />
      <Stat label="Open"       value={String(s.open)} tone={s.open > 0 ? "accent" : undefined} />
      <Stat label="Closed"     value={String(s.closed)} />
      <Stat label="Win rate"   value={s.closed > 0 ? `${winRate}%` : "—"}
            tone={winRate >= 70 ? "up" : winRate >= 50 ? undefined : winRate > 0 ? "down" : undefined} />
      <Stat label="Wins"       value={String(s.wins)}   tone={s.wins > 0 ? "up" : undefined} />
      <Stat label="Realized $" value={fmtCurrency(s.realized_pnl)}
            tone={s.realized_pnl > 0 ? "up" : s.realized_pnl < 0 ? "down" : undefined} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "accent" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">{label}</div>
      <div className={cn(
        "text-xl md:text-2xl font-semibold tabular tracking-tight",
        tone === "up" ? "text-up"
          : tone === "down" ? "text-down"
          : tone === "accent" ? "text-accent"
          : "text-text-primary",
      )}>
        {value}
      </div>
    </div>
  );
}

// ─── Add form ─────────────────────────────────────────────────────────────────
function AddForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [f, setF] = useState<Partial<OkwTradeCreate>>({
    symbol: "RUT",
    trade_type: "mars",
    side: "put",
    contracts: 1,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (k: keyof OkwTradeCreate, v: string | number | undefined) => {
    setF((prev) => ({ ...prev, [k]: v }));
  };

  const submit = async () => {
    if (!f.symbol || !f.trade_type || !f.expiry || f.dte == null
        || f.short_strike == null || f.long_strike == null || f.credit == null) {
      setError("Symbol, type, expiry, DTE, both strikes, and credit are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.okwCreate(f as OkwTradeCreate);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border border-border/40 rounded-md p-4 bg-surface-2/30 flex flex-col gap-4">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">Log a placed trade</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FormField label="Type">
          <Select value={f.trade_type ?? "mars"} onValueChange={(v) => setField("trade_type", v)}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TRADE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Symbol">
          <Input value={f.symbol ?? ""} onChange={(e) => setField("symbol", e.target.value.toUpperCase())} className="h-8 uppercase tabular" />
        </FormField>
        <FormField label="Expiry YYYYMMDD">
          <Input value={f.expiry ?? ""} onChange={(e) => setField("expiry", e.target.value)} placeholder="20260620" className="h-8 tabular" />
        </FormField>
        <FormField label="DTE">
          <Input type="number" value={f.dte ?? ""} onChange={(e) => setField("dte", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>

        <FormField label="Short strike">
          <Input type="number" step="0.5" value={f.short_strike ?? ""} onChange={(e) => setField("short_strike", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Long strike">
          <Input type="number" step="0.5" value={f.long_strike ?? ""} onChange={(e) => setField("long_strike", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Contracts">
          <Input type="number" min={1} value={f.contracts ?? 1} onChange={(e) => setField("contracts", +e.target.value || 1)} className="h-8 tabular" />
        </FormField>
        <FormField label="Credit $">
          <Input type="number" step="0.01" value={f.credit ?? ""} onChange={(e) => setField("credit", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>

        <FormField label="Spot at open">
          <Input type="number" step="0.01" value={f.spot_at_open ?? ""} onChange={(e) => setField("spot_at_open", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Short Δ (0-1)">
          <Input type="number" step="0.01" value={f.short_delta ?? ""} onChange={(e) => setField("short_delta", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="AROC %">
          <Input type="number" step="0.1" value={f.aroc_pct ?? ""} onChange={(e) => setField("aroc_pct", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Kelly %">
          <Input type="number" step="0.1" value={f.kelly_pct ?? ""} onChange={(e) => setField("kelly_pct", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>

        <FormField label="Adj %OTM">
          <Input type="number" step="0.1" value={f.adj_distance_pct ?? ""} onChange={(e) => setField("adj_distance_pct", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Fib floor 1">
          <Input type="number" step="0.01" value={f.fib_floor1 ?? ""} onChange={(e) => setField("fib_floor1", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Fib floor 2">
          <Input type="number" step="0.01" value={f.fib_floor2 ?? ""} onChange={(e) => setField("fib_floor2", e.target.value ? +e.target.value : undefined)} className="h-8 tabular" />
        </FormField>
        <FormField label="Notes">
          <Input value={f.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} className="h-8" />
        </FormField>
      </div>

      {error && <div className="text-[11px] text-down">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="default" size="sm" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Save trade"}
        </Button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

// ─── Trades table ─────────────────────────────────────────────────────────────
function TradesTable({ trades, onRefresh }: { trades: OkwTrade[]; onRefresh: () => void }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[11px] tabular">
        <thead className="text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">When</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-left font-medium">Sym</th>
            <th className="px-3 py-2 text-right font-medium">Strikes</th>
            <th className="px-3 py-2 text-right font-medium">Exp · DTE</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
            <th className="px-3 py-2 text-right font-medium">AROC</th>
            <th className="px-3 py-2 text-right font-medium">Kelly</th>
            <th className="px-3 py-2 text-right font-medium">Adj</th>
            <th className="px-3 py-2 text-right font-medium">×</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
            <th className="px-3 py-2 text-right font-medium">P&L</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => <Row key={t.id} t={t} onRefresh={onRefresh} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ t, onRefresh }: { t: OkwTrade; onRefresh: () => void }) {
  const [closing, setClosing] = useState(false);
  const [exitReason, setExitReason] = useState("manual");
  const [pnl, setPnl] = useState<string>("");

  const tone = TRADE_TONE[t.trade_type] ?? "text-text-secondary";
  const placed = new Date(t.placed_at);
  const placedStr = `${placed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const realized = t.realized_pnl;
  const isOpen = t.status === "open";

  const closeTrade = async () => {
    await api.okwClose(t.id, {
      exit_reason: exitReason,
      realized_pnl: pnl ? +pnl : null,
    });
    setClosing(false);
    onRefresh();
  };

  return (
    <>
      <tr className="border-t border-border/30 hover:bg-surface-2/30">
        <td className="px-3 py-2.5 text-text-secondary whitespace-nowrap">{placedStr}</td>
        <td className={cn("px-3 py-2.5 uppercase text-[10px] tracking-wider", tone)}>
          {t.trade_type === "marsmax" ? "MAX" : t.trade_type}
        </td>
        <td className="px-3 py-2.5 text-text-primary font-medium">{t.symbol}</td>
        <td className="px-3 py-2.5 text-right font-mono text-text-primary">
          {t.short_strike}<span className="text-text-muted">/</span>{t.long_strike}
        </td>
        <td className="px-3 py-2.5 text-right text-text-secondary whitespace-nowrap">
          {formatExpiry(t.expiry)} · {t.dte}d
        </td>
        <td className="px-3 py-2.5 text-right text-text-secondary">
          {t.short_delta != null ? Math.round(t.short_delta * 100) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right text-up">
          {t.aroc_pct != null ? `${t.aroc_pct.toFixed(0)}%` : "—"}
        </td>
        <td className="px-3 py-2.5 text-right text-text-secondary">
          {t.kelly_pct != null ? t.kelly_pct.toFixed(0) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right text-text-secondary">
          {t.adj_distance_pct != null ? `${t.adj_distance_pct.toFixed(1)}%` : "—"}
        </td>
        <td className="px-3 py-2.5 text-right text-text-secondary">{t.contracts}</td>
        <td className="px-3 py-2.5 text-right text-up">${t.credit.toFixed(2)}</td>
        <td className={cn(
          "px-3 py-2.5 text-right",
          realized == null ? "text-text-muted" : realized > 0 ? "text-up" : realized < 0 ? "text-down" : "text-text-secondary"
        )}>
          {realized != null ? fmtCurrency(realized) : "—"}
        </td>
        <td className="px-3 py-2.5">
          <span className={cn(
            "text-[10px] uppercase tracking-wider",
            t.status === "open" ? "text-accent" : t.status === "closed" ? "text-text-secondary" : "text-text-muted"
          )}>
            {t.status}
            {t.exit_reason ? <span className="text-text-muted ml-1">· {t.exit_reason}</span> : null}
          </span>
        </td>
        <td className="px-3 py-2.5 text-right">
          {isOpen && (
            <button
              type="button"
              onClick={() => setClosing((v) => !v)}
              className="text-[10px] text-accent hover:underline"
            >
              {closing ? "cancel" : "close"}
            </button>
          )}
          {!isOpen && (
            <button
              type="button"
              onClick={async () => {
                if (confirm("Delete this trade?")) {
                  await api.okwDelete(t.id);
                  onRefresh();
                }
              }}
              className="text-text-muted hover:text-down"
              title="Delete"
            >
              <X size={11} />
            </button>
          )}
        </td>
      </tr>
      {closing && (
        <tr>
          <td colSpan={14} className="px-3 py-3 bg-surface-2/30 border-t border-border/30">
            <div className="flex items-end gap-3 flex-wrap">
              <FormField label="Exit reason">
                <Select value={exitReason} onValueChange={setExitReason}>
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXIT_REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Realized P&L $">
                <Input type="number" step="0.01" value={pnl} onChange={(e) => setPnl(e.target.value)} className="h-8 w-32 tabular" />
              </FormField>
              <Button size="sm" variant="default" onClick={closeTrade}>
                <CheckCircle2 /> Close trade
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
