"use client";

import { useEffect, useState } from "react";

export type Mood = "🚀" | "👍" | "😐" | "👎" | "💀";

export interface JournalEntry {
  id: string;
  created_at: number;
  updated_at: number;
  date: string; // YYYY-MM-DD
  title: string;
  body: string;
  tags: string[];
  mood?: Mood;
  linked_trade_id?: string;
  linked_strategy_id?: string;
  symbol?: string;
}

const KEY = "trading_journal_v1";

function readAll(): JournalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: JournalEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

export function useJournal() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setEntries(readAll());
    setHydrated(true);
  }, []);

  // sync across tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setEntries(readAll());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const upsert = (entry: JournalEntry) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      const now = Date.now();
      const next = [...prev];
      if (idx >= 0) next[idx] = { ...entry, updated_at: now };
      else next.unshift({ ...entry, created_at: now, updated_at: now });
      writeAll(next);
      return next;
    });
  };

  const remove = (id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      writeAll(next);
      return next;
    });
  };

  return { entries, hydrated, upsert, remove };
}

export function newEntry(seed: Partial<JournalEntry> = {}): JournalEntry {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: `je-${now}`,
    created_at: now,
    updated_at: now,
    date: today,
    title: "",
    body: "",
    tags: [],
    ...seed,
  };
}

export function allTags(entries: JournalEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) for (const t of e.tags) set.add(t);
  return Array.from(set).sort();
}
