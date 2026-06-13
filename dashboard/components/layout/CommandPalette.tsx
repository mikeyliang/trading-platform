"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Settings,
  BarChart3,
  Notebook,
  Activity,
  Filter,
  LineChart,
  CandlestickChart,
  Layers,
  ArrowRight,
} from "lucide-react";
import { api } from "@/lib/api";
import type { WatchlistItem } from "@/types";

const PAGES = [
  { label: "Dashboard",   href: "/",                    icon: LayoutDashboard, keywords: "home overview" },
  { label: "Exit",        href: "/monitor/exit",        icon: Activity,        keywords: "monitor open spreads delta trigger" },
  { label: "Tracker",     href: "/monitor/tracker",     icon: Notebook,        keywords: "okw log positions" },
  { label: "Performance", href: "/monitor/performance", icon: BarChart3,       keywords: "analytics equity curve sharpe drawdown" },
  { label: "Journal",     href: "/monitor/journal",     icon: Notebook,        keywords: "notes reflection review" },
  { label: "Screener",    href: "/screener",            icon: Filter,          keywords: "filter sector market cap pe dividend" },
  { label: "Settings",    href: "/settings",            icon: Settings,        keywords: "configuration" },
];

const SUGGESTED_SYMBOLS = ["SPY", "QQQ", "IWM", "RUT", "AAPL", "NVDA", "TSLA", "MSFT"];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  // Controlled input so we can show a "Open <typed> chart" fallthrough
  // for any symbol the user types, even ones outside the hardcoded
  // suggestions / watchlist.
  const [query, setQuery] = useState("");

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  useEffect(() => {
    if (open && watchlist.length === 0) {
      api.watchlist().then(setWatchlist).catch(() => null);
    }
  }, [open, watchlist.length]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  // Normalize whatever the user typed into a chart-friendly ticker:
  // uppercase, strip spaces/punctuation that ticker symbols never have.
  // We keep '.' and '-' since legitimate IBKR tickers include them
  // (e.g. BRK.B, RDS-A).
  const typedSymbol = useMemo(() => {
    return query
      .toUpperCase()
      .replace(/[^A-Z0-9.\-]/g, "")
      .slice(0, 12);
  }, [query]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search symbols or jump to a page…"
        className="text-sm"
      />
      <CommandList className="max-h-[400px] overflow-y-auto">
        <CommandEmpty>No results. Press Enter to open as a chart.</CommandEmpty>

        {/* Free-text fallthrough: lets the user open a chart for any
            ticker, not just the ones in PAGES / watchlist / SUGGESTED.
            Top-of-list so Enter selects it by default while typing.
            Value includes the literal query so cmdk's fuzzy filter
            always keeps this item visible. */}
        {typedSymbol && (
          <CommandGroup heading="Open chart">
            <CommandItem
              value={`${typedSymbol} ${query} open chart symbol`}
              onSelect={() => go(`/chart/${typedSymbol}`)}
            >
              <ArrowRight size={12} className="mr-2 text-accent" />
              <span className="font-medium mr-2">{typedSymbol}</span>
              <span className="text-text-muted truncate">chart</span>
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
            <CommandItem
              value={`${typedSymbol} ${query} open chain options`}
              onSelect={() => go(`/options/${typedSymbol}`)}
            >
              <Layers size={12} className="mr-2 text-text-muted" />
              <span className="font-medium mr-2">{typedSymbol}</span>
              <span className="text-text-muted truncate">options chain</span>
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Pages">
          {PAGES.map((p) => (
            <CommandItem
              key={p.href}
              value={`${p.label} ${p.keywords}`}
              onSelect={() => go(p.href)}
            >
              <p.icon size={12} className="mr-2 text-text-muted" />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {watchlist.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Watchlist">
              {watchlist.map((w) => (
                <CommandItem
                  key={w.symbol}
                  value={`${w.symbol} ${w.name} chart`}
                  onSelect={() => go(`/chart/${w.symbol}`)}
                >
                  <CandlestickChart size={12} className="mr-2 text-text-muted" />
                  <span className="font-medium mr-2">{w.symbol}</span>
                  <span className="text-text-muted truncate">{w.name}</span>
                  <CommandShortcut>chart</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Quick chart">
          {SUGGESTED_SYMBOLS.map((s) => (
            <CommandItem
              key={s}
              value={`${s} chart quick`}
              onSelect={() => go(`/chart/${s}`)}
            >
              <LineChart size={12} className="mr-2 text-text-muted" />
              <span className="font-medium">{s}</span>
              <CommandShortcut>chart</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Options chains">
          {["SPY", "RUT", "QQQ", "IWM"].map((s) => (
            <CommandItem
              key={`opt-${s}`}
              value={`${s} options chain`}
              onSelect={() => go(`/options/${s}`)}
            >
              <Layers size={12} className="mr-2 text-text-muted" />
              {s} chain
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
