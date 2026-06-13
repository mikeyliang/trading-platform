"use client";

// Floating popover anchored over the chart at a marker click. Shows the
// trade(s) on that bar plus a per-trade journal textarea so the user
// can capture context while the price action is still on screen.
//
// Notes are persisted into ``metadata.note`` on the trade row via
// ``PUT /api/trade-history/{id}`` — we splat the existing metadata so
// other Flex/IBKR fields (account, ib_exec_id, option contract, …)
// aren't blown away by the update.

import { useEffect, useMemo, useRef, useState } from "react";
import { X, ExternalLink, Save, Loader2 } from "lucide-react";
import { api, type TradeHistoryRecord } from "@/lib/api";
import { cn, fmt, fmtCurrency, pnlClass } from "@/lib/utils";

interface Props {
  trades: TradeHistoryRecord[];
  /** Pixel position of the click within the chart container. */
  anchor: { x: number; y: number };
  /** Bounding rect of the chart container — used to clamp positioning. */
  container: { width: number; height: number };
  onClose: () => void;
  /** Called after a successful save so the parent can re-fetch trades. */
  onSaved?: () => void;
}

const W = 320;
const PAD = 8;

export function TradeMarkerPopover({
  trades, anchor, container, onClose, onSaved,
}: Props) {
  // The clicked bucket can have multiple trades on the same day. Show
  // a small picker if >1; otherwise focus the single trade directly.
  const [activeIdx, setActiveIdx] = useState(0);
  const active = trades[activeIdx];

  // Reset picker when the bucket changes (different bar clicked).
  useEffect(() => {
    setActiveIdx(0);
  }, [trades]);

  // Clamp to keep the popover inside the chart bounds. Default to the
  // right of the click; flip to the left if there's no room.
  const pos = useMemo(() => {
    const right = anchor.x + 12 + W;
    const left = right > container.width - PAD ? anchor.x - 12 - W : anchor.x + 12;
    const top = Math.max(PAD, Math.min(anchor.y - 20, container.height - 220 - PAD));
    return { left: Math.max(PAD, left), top };
  }, [anchor, container]);

  if (!active) return null;

  return (
    <div
      className="absolute z-30 rounded-md border border-border/70 bg-surface shadow-xl"
      style={{ left: pos.left, top: pos.top, width: W }}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40 bg-surface-2/30">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Trade</span>
        {trades.length > 1 && (
          <div className="flex items-center gap-0.5">
            {trades.map((_t, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={cn(
                  "h-4 min-w-[16px] px-1 rounded-sm text-[9px] tabular transition-colors",
                  i === activeIdx
                    ? "bg-accent/20 text-accent"
                    : "bg-surface-2 text-text-muted hover:text-text-secondary",
                )}
              >
                {i + 1}
              </button>
            ))}
            <span className="text-[9px] text-text-muted ml-1">/ {trades.length}</span>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex items-center justify-center h-5 w-5 rounded-sm text-text-muted hover:text-text-primary hover:bg-surface-2"
        >
          <X size={11} />
        </button>
      </div>

      <TradeDetails trade={active} />

      <JournalEditor
        key={active.id}
        trade={active}
        onSaved={onSaved}
      />
    </div>
  );
}

function TradeDetails({ trade: t }: { trade: TradeHistoryRecord }) {
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  const isOption = (meta.asset_category as string | undefined) === "OPT"
    || (meta.asset_category as string | undefined) === "FOP";
  const strike = typeof meta.option_strike === "number" ? meta.option_strike : null;
  const right = meta.option_right === "C" || meta.option_right === "P" ? meta.option_right : null;
  const expiry = typeof meta.option_expiry === "string" ? meta.option_expiry : null;
  const account = typeof meta.account_id === "string" ? meta.account_id : null;
  const txType = typeof meta.transaction_type === "string" ? meta.transaction_type : null;
  const commission = typeof meta.commission === "number" ? meta.commission : null;
  const sideUpper = (t.side || "").toString().toUpperCase();
  const isBuy = sideUpper.startsWith("B");
  const tsLabel = useMemo(() => {
    const d = new Date(t.timestamp);
    return Number.isNaN(d.getTime()) ? t.timestamp : d.toLocaleString();
  }, [t.timestamp]);

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-[11px]">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider font-medium tabular",
            isBuy ? "bg-up/15 text-up" : "bg-down/15 text-down",
          )}
        >
          {isBuy ? "BUY" : "SELL"}
        </span>
        <span className="text-text-primary font-medium tabular">{t.symbol}</span>
        {isOption && strike != null && right && (
          <span className="text-text-secondary tabular text-[11px]">
            {formatStrike(strike)}{right}
          </span>
        )}
        {isOption && expiry && (
          <span className="text-text-muted text-[10px] tabular">
            {fmtOptionExpiry(expiry)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] tabular">
        <Field label="Time" value={tsLabel} />
        <Field label="Qty" value={fmt(t.quantity, 0)} />
        <Field label="Fill" value={fmt(t.price, 2)} />
        <Field
          label="P&L"
          value={t.pnl != null ? fmtCurrency(t.pnl) : "—"}
          valueClassName={t.pnl != null ? pnlClass(t.pnl) : "text-text-muted"}
        />
        {account && <Field label="Account" value={account} mono />}
        {commission != null && <Field label="Comm" value={fmtCurrency(commission)} />}
        {txType && <Field label="Type" value={txType} mono />}
        {t.strategy && <Field label="Strategy" value={t.strategy} />}
      </div>

      <a
        href={`/trade-history?trade=${t.id}`}
        className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent transition-colors w-fit"
      >
        Open in history <ExternalLink size={9} />
      </a>
    </div>
  );
}

function Field({
  label, value, valueClassName, mono,
}: { label: string; value: string; valueClassName?: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <span
        className={cn(
          "text-text-primary tabular",
          mono && "text-[10px]",
          valueClassName,
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function JournalEditor({
  trade, onSaved,
}: { trade: TradeHistoryRecord; onSaved?: () => void }) {
  const meta = (trade.metadata ?? {}) as Record<string, unknown>;
  const existing = typeof meta.note === "string" ? (meta.note as string) : "";
  const [text, setText] = useState(existing);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the textarea when the popover mounts — natural flow is open
  // marker → start typing the note.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const dirty = text !== existing;

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      const next = { ...(meta as Record<string, unknown>), note: text };
      await api.tradeHistoryUpdate(trade.id, { metadata: next });
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ⌘/Ctrl-Enter saves — the keyboard shortcut journals expect.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && dirty && !saving) {
      e.preventDefault();
      onSave();
    }
  };

  return (
    <div className="px-3 pb-2 pt-1 border-t border-border/40 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-text-muted">Journal</span>
        {savedAt && !dirty && !saving && (
          <span className="text-[9px] text-up">saved</span>
        )}
        {err && <span className="text-[9px] text-down" title={err}>save failed</span>}
      </div>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Why this trade? What did you see? How did it work out?"
        rows={3}
        className={cn(
          "w-full resize-y rounded-sm border border-border bg-surface-2/30",
          "px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted/60",
          "outline-none focus:border-accent/50 transition-colors tabular",
        )}
      />
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-text-muted">⌘/Ctrl-Enter to save</span>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            "ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-sm text-[10px] transition-colors",
            !dirty || saving
              ? "bg-surface-2 text-text-muted cursor-not-allowed"
              : "bg-accent/15 text-accent hover:bg-accent/25",
          )}
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </div>
  );
}

function formatStrike(s: number): string {
  if (Number.isInteger(s)) return s.toString();
  return s.toFixed(2).replace(/\.?0+$/, "");
}

function fmtOptionExpiry(s: string): string {
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 8) return s;
  const y = digits.slice(2, 4);
  const m = parseInt(digits.slice(4, 6), 10);
  const d = digits.slice(6, 8);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mo = months[m - 1] ?? digits.slice(4, 6);
  const yyyy = parseInt(digits.slice(0, 4), 10);
  const now = new Date();
  return yyyy === now.getFullYear() ? `${mo} ${d}` : `${mo} ${d} '${y}`;
}
