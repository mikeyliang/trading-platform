"use client";

import { useEffect, useState } from "react";
import { api, type OkwSummary, type OkwTrade, type OkwTradeCreate } from "@/lib/api";
import { cn, fmtCurrency } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Stat, StatGroup } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, TableSkeletonRows } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  RiAddLine as Plus,
  RiCloseLine as X,
  RiCheckboxCircleFill as CheckCircle2,
  RiFileList3Line as LedgerIcon,
  RiErrorWarningFill as ErrorIcon,
  RiRefreshLine as RefreshCw,
  RiDeleteBinLine as Trash,
} from "@remixicon/react";

const TRADE_TYPES = [
  { value: "rut",     label: "RUT" },
  { value: "mars",    label: "Mars" },
  { value: "marsmax", label: "Mars max" },
  { value: "space",   label: "Space" },
];

const TRADE_LABEL: Record<string, string> = {
  rut: "RUT",
  mars: "Mars",
  marsmax: "Mars max",
  space: "Space",
};

const EXIT_REASONS = [
  { value: "delta",  label: "Delta trigger" },
  { value: "2pct",   label: "2% rule" },
  { value: "profit", label: "Profit target" },
  { value: "manual", label: "Manual" },
];

const STATUS_BADGE: Record<OkwTrade["status"], "accent" | "default" | "muted"> = {
  open: "accent",
  closed: "default",
  expired: "muted",
};

export function OkwTracker() {
  const [trades, setTrades] = useState<OkwTrade[]>([]);
  const [summary, setSummary] = useState<OkwSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.okwTrades({ status: statusFilter || undefined, limit: 200 });
      setTrades(Array.isArray(r?.trades) ? r.trades : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load trades");
    } finally {
      setLoaded(true);
    }
    setSummary(await api.okwSummary().catch(() => null));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [statusFilter]);

  return (
    <PageShell>
      <PageHeader
        title="Trade tracker"
        description="Log placed RUT, Mars, Mars max and Space spreads. Mirrors the Options Kelly Workbook columns."
        actions={
          <Button onClick={() => setShowAdd((v) => !v)} variant="default">
            <Plus /> {showAdd ? "Hide form" : "Add trade"}
          </Button>
        }
      />

      <SummaryCard s={summary} loading={!loaded && !summary} />

      {showAdd && (
        <AddForm
          onCreated={() => { setShowAdd(false); load(); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Trades</CardTitle>
            {loaded && <Badge variant="muted" className="tabular">{trades.length}</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-caption-1-medium text-text-tertiary">Status</span>
            <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="w-28" aria-label="Status filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!loaded ? (
            <TradesTable>
              <TableSkeletonRows rows={4} cols={14} />
            </TradesTable>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <Badge variant="down">
                <ErrorIcon size={14} aria-hidden="true" />
                {error}
              </Badge>
              <Button variant="secondary" onClick={load}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          ) : trades.length === 0 ? (
            <EmptyState
              icon={LedgerIcon}
              title={statusFilter ? `No ${statusFilter} trades` : "No trades logged yet"}
              description={statusFilter ? "Try another status filter." : "Add a trade after you place one to keep a running workbook."}
              action={
                !statusFilter && !showAdd ? (
                  <Button variant="secondary" onClick={() => setShowAdd(true)}>
                    <Plus /> Add trade
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TradesTable>
              {trades.map((t) => <Row key={t.id} t={t} onRefresh={load} />)}
            </TradesTable>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────
function SummaryCard({ s: raw, loading }: { s: OkwSummary | null; loading: boolean }) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const s = raw
    ? { total: n(raw.total), open: n(raw.open), closed: n(raw.closed), wins: n(raw.wins), realized_pnl: n(raw.realized_pnl) }
    : null;
  const winRate = s && s.closed > 0 ? Math.round((s.wins / s.closed) * 100) : 0;
  return (
    <Card>
      <CardContent>
        <StatGroup cols={6}>
          {loading ? (
            [0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-5 w-10" />
              </div>
            ))
          ) : (
            <>
              <Stat label="Total" value={s ? s.total : "n/a"} size="md" />
              <Stat label="Open" value={s ? s.open : "n/a"} size="md" />
              <Stat label="Closed" value={s ? s.closed : "n/a"} size="md" />
              <Stat
                label="Win rate"
                value={s && s.closed > 0 ? `${winRate}%` : "n/a"}
                size="md"
                tone={winRate >= 70 ? "up" : winRate >= 50 ? "default" : winRate > 0 ? "down" : "default"}
              />
              <Stat label="Wins" value={s ? s.wins : "n/a"} size="md" tone={s && s.wins > 0 ? "up" : "default"} />
              <Stat
                label="Realized P&L"
                value={s ? signed(s.realized_pnl) : "n/a"}
                size="md"
                tone={s && s.realized_pnl > 0 ? "up" : s && s.realized_pnl < 0 ? "down" : "default"}
              />
            </>
          )}
        </StatGroup>
      </CardContent>
    </Card>
  );
}

function signed(v: number): string {
  return v > 0 ? `+${fmtCurrency(v)}` : fmtCurrency(v);
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
    <Card>
      <CardHeader>
        <CardTitle>Log a placed trade</CardTitle>
        <Button variant="secondary" size="icon-sm" onClick={onCancel} aria-label="Close form">
          <X />
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FormField label="Type">
          <Select value={f.trade_type ?? "mars"} onValueChange={(v) => setField("trade_type", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TRADE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Symbol">
          <Input value={f.symbol ?? ""} onChange={(e) => setField("symbol", e.target.value.toUpperCase())} className="tabular" />
        </FormField>
        <FormField label="Expiry (YYYYMMDD)">
          <Input value={f.expiry ?? ""} onChange={(e) => setField("expiry", e.target.value)} placeholder="20260620" className="tabular" />
        </FormField>
        <FormField label="DTE">
          <Input type="number" value={f.dte ?? ""} onChange={(e) => setField("dte", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>

        <FormField label="Short strike">
          <Input type="number" step="0.5" value={f.short_strike ?? ""} onChange={(e) => setField("short_strike", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Long strike">
          <Input type="number" step="0.5" value={f.long_strike ?? ""} onChange={(e) => setField("long_strike", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Contracts">
          <Input type="number" min={1} value={f.contracts ?? 1} onChange={(e) => setField("contracts", +e.target.value || 1)} className="tabular" />
        </FormField>
        <FormField label="Credit ($)">
          <Input type="number" step="0.01" value={f.credit ?? ""} onChange={(e) => setField("credit", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>

        <FormField label="Spot at open">
          <Input type="number" step="0.01" value={f.spot_at_open ?? ""} onChange={(e) => setField("spot_at_open", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Short delta (0 to 1)">
          <Input type="number" step="0.01" value={f.short_delta ?? ""} onChange={(e) => setField("short_delta", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="AROC (%)">
          <Input type="number" step="0.1" value={f.aroc_pct ?? ""} onChange={(e) => setField("aroc_pct", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Kelly (%)">
          <Input type="number" step="0.1" value={f.kelly_pct ?? ""} onChange={(e) => setField("kelly_pct", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>

        <FormField label="Adjusted distance (% OTM)">
          <Input type="number" step="0.1" value={f.adj_distance_pct ?? ""} onChange={(e) => setField("adj_distance_pct", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Fib floor 1">
          <Input type="number" step="0.01" value={f.fib_floor1 ?? ""} onChange={(e) => setField("fib_floor1", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Fib floor 2">
          <Input type="number" step="0.01" value={f.fib_floor2 ?? ""} onChange={(e) => setField("fib_floor2", e.target.value ? +e.target.value : undefined)} className="tabular" />
        </FormField>
        <FormField label="Notes">
          <Input value={f.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} />
        </FormField>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {error && (
          <Badge variant="down" className="mr-auto whitespace-normal h-auto py-0.5">
            <ErrorIcon size={14} aria-hidden="true" />
            {error}
          </Badge>
        )}
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="default" onClick={submit} disabled={saving}>
          {saving ? "Saving" : "Save trade"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-caption-1-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}

// ─── Trades table ─────────────────────────────────────────────────────────────
function TradesTable({ children }: { children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Placed</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Symbol</TableHead>
          <TableHead className="text-right">Strikes</TableHead>
          <TableHead className="text-right">Expiry</TableHead>
          <TableHead className="text-right">DTE</TableHead>
          <TableHead className="text-right">Delta</TableHead>
          <TableHead className="text-right">AROC</TableHead>
          <TableHead className="text-right">Kelly</TableHead>
          <TableHead className="text-right">Adj</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Credit</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Row({ t, onRefresh }: { t: OkwTrade; onRefresh: () => void }) {
  const [closing, setClosing] = useState(false);
  const [exitReason, setExitReason] = useState("manual");
  const [pnl, setPnl] = useState<string>("");

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
      <TableRow>
        <TableCell className="text-text-secondary whitespace-nowrap">{placedStr}</TableCell>
        <TableCell className="text-text-secondary">{TRADE_LABEL[t.trade_type] ?? t.trade_type}</TableCell>
        <TableCell>{t.symbol}</TableCell>
        <TableCell className="text-right whitespace-nowrap">
          {t.short_strike}<span className="text-text-tertiary"> / </span>{t.long_strike}
        </TableCell>
        <TableCell className="text-right text-text-secondary whitespace-nowrap">{formatExpiry(t.expiry)}</TableCell>
        <TableCell className="text-right text-text-secondary">{t.dte}d</TableCell>
        <TableCell className="text-right text-text-secondary">
          {t.short_delta != null ? Math.round(t.short_delta * 100) : "n/a"}
        </TableCell>
        <TableCell className="text-right text-text-secondary">
          {t.aroc_pct != null ? `${t.aroc_pct.toFixed(0)}%` : "n/a"}
        </TableCell>
        <TableCell className="text-right text-text-secondary">
          {t.kelly_pct != null ? `${t.kelly_pct.toFixed(0)}%` : "n/a"}
        </TableCell>
        <TableCell className="text-right text-text-secondary">
          {t.adj_distance_pct != null ? `${t.adj_distance_pct.toFixed(1)}%` : "n/a"}
        </TableCell>
        <TableCell className="text-right text-text-secondary">{t.contracts}</TableCell>
        <TableCell className="text-right">${t.credit.toFixed(2)}</TableCell>
        <TableCell className={cn(
          "text-right",
          realized == null ? "text-text-tertiary" : realized > 0 ? "text-status-lime-text" : realized < 0 ? "text-status-rose-text" : "text-text-secondary"
        )}>
          {realized != null ? signed(realized) : "n/a"}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <Badge variant={STATUS_BADGE[t.status] ?? "muted"}>{capitalize(t.status)}</Badge>
            {t.exit_reason && <span className="text-caption-1-medium text-text-tertiary">{t.exit_reason}</span>}
          </div>
        </TableCell>
        <TableCell className="text-right">
          {isOpen ? (
            <Button variant="secondary" size="sm" onClick={() => setClosing((v) => !v)}>
              {closing ? "Cancel" : "Close"}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Delete trade"
              title="Delete"
              onClick={async () => {
                if (confirm("Delete this trade?")) {
                  await api.okwDelete(t.id);
                  onRefresh();
                }
              }}
            >
              <Trash />
            </Button>
          )}
        </TableCell>
      </TableRow>
      {closing && (
        <tr className="border-b border-separator-border">
          <td colSpan={15} className="px-3 py-3 bg-background-secondary-default">
            <div className="flex items-end gap-3 flex-wrap">
              <FormField label="Exit reason">
                <Select value={exitReason} onValueChange={setExitReason}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXIT_REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Realized P&L ($)">
                <Input type="number" step="0.01" value={pnl} onChange={(e) => setPnl(e.target.value)} className="w-32 tabular" />
              </FormField>
              <Button variant="default" onClick={closeTrade}>
                <CheckCircle2 /> Close trade
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
