"use client";

import { useMemo, useState } from "react";
import { RiHistoryLine, RiSearchLine, RiDeleteBinLine, RiArrowRightSLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

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

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Prior runs</CardTitle>
          <Badge variant="muted" className="tabular">
            {filtered.length}
            {query ? ` of ${history.length}` : ""}
          </Badge>
        </div>
        {history.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <RiSearchLine
                size={16}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-icon-tertiary pointer-events-none"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search runs"
                aria-label="Search prior runs"
                className="w-56 pl-8"
              />
            </div>
            <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear history">
              <RiDeleteBinLine />
            </Button>
          </div>
        )}
      </CardHeader>

      {history.length === 0 ? (
        <EmptyState
          size="sm"
          icon={RiHistoryLine}
          title="No prior debates"
          description="Runs save here automatically."
        />
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {filtered.map((row) => {
            const isCurrent = row.id === currentId;
            const decision = (row.decision || "").trim();
            const decisionLower = decision.toLowerCase();
            const variant = decisionLower.includes("buy")
              ? "up"
              : decisionLower.includes("sell")
              ? "down"
              : "muted";
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onSelect(row)}
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 h-9 text-left text-body-2-medium tabular border-b border-separator-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
                    isCurrent ? "bg-background-secondary-default" : "hover:bg-background-secondary-hover"
                  )}
                >
                  <span className="text-text-primary w-16 truncate">{row.symbol}</span>
                  <span className="text-text-tertiary w-24 text-caption-1-regular">{row.trade_date}</span>
                  <span className="flex-1 min-w-0 flex">
                    <Badge variant={variant} className="max-w-full">
                      <span className="truncate">{decision || "No decision"}</span>
                    </Badge>
                  </span>
                  <span className="text-caption-1-regular text-text-tertiary">
                    {(row.duration_ms / 1000).toFixed(1)}s
                  </span>
                  <span className="text-caption-1-regular text-text-tertiary w-16 text-right">
                    {formatRelative(row.ran_at)}
                  </span>
                  <RiArrowRightSLine size={16} className="text-foreground-icon-tertiary shrink-0" aria-hidden />
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li>
              <EmptyState size="sm" icon={RiSearchLine} title="No matches" description={`Nothing in prior runs matches "${query}".`} />
            </li>
          )}
        </ul>
      )}
    </Card>
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
