"use client";

import { useMemo, useState } from "react";
import { History, Search, Trash2, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface HistoryEntry {
  id: string;
  ran_at: string;
  symbol: string;
  trade_date: string;
  decision: string;
  duration_ms: number;
  final_state: Record<string, string>;
}

const STORAGE_KEY = "agentDebateHistory.v1";
const MAX_HISTORY = 50;

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory();
  const next = [entry, ...existing].slice(0, MAX_HISTORY);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota */
    }
  }
  return next;
}

export function clearHistory(): HistoryEntry[] {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }
  return [];
}

interface Props {
  history: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
  currentId?: string | null;
}

export function AgentHistory({ history, onSelect, onClear, currentId }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return history;
    return history.filter((row) => {
      const haystack = [
        row.symbol,
        row.trade_date,
        row.decision,
        ...Object.values(row.final_state || {}),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [history, query]);

  if (history.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center gap-2 text-text-muted text-xs">
          <History size={12} />
          <span>No prior debates yet — runs save here automatically.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <History size={14} className="text-text-secondary" />
        <div className="text-sm font-medium text-text-secondary">
          Conversation history
        </div>
        <span className="text-[11px] text-text-muted">
          {filtered.length}
          {query ? ` of ${history.length}` : ""} runs
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search
              size={11}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol, decision, text…"
              className="h-7 w-56 pl-6 text-[11px]"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={onClear} title="Clear history">
            <Trash2 size={12} />
          </Button>
        </div>
      </header>

      <ul className="divide-y divide-border max-h-72 overflow-y-auto">
        {filtered.map((row) => {
          const isCurrent = row.id === currentId;
          const decision = (row.decision || "").trim();
          const decisionLower = decision.toLowerCase();
          const tone = decisionLower.includes("buy")
            ? "text-up"
            : decisionLower.includes("sell")
            ? "text-down"
            : "text-text-secondary";
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onSelect(row)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-2 text-left text-[11px] tabular hover:bg-surface-2/60 transition-colors",
                  isCurrent && "bg-surface-2"
                )}
              >
                <span className="font-medium text-text-primary w-16 truncate">
                  {row.symbol}
                </span>
                <span className="text-text-muted w-24">{row.trade_date}</span>
                <span className={cn("font-medium truncate flex-1", tone)}>
                  {decision || "(no decision)"}
                </span>
                <span className="text-text-muted">
                  {(row.duration_ms / 1000).toFixed(1)}s
                </span>
                <span className="text-text-muted/70">
                  {formatRelative(row.ran_at)}
                </span>
                <ArrowUpRight size={11} className="text-text-muted" />
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-4 py-3 text-[11px] text-text-muted">
            No matches for &ldquo;{query}&rdquo;.
          </li>
        )}
      </ul>
    </section>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
