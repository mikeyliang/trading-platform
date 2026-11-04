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
  RiDashboardLine,
  RiSettings4Line,
  RiBarChartBoxLine,
  RiFileListLine,
  RiBookOpenLine,
  RiPulseLine,
  RiEqualizerLine,
  RiLineChartLine,
  RiStockLine,
  RiStackLine,
  RiArrowRightLine,
  RiLightbulbLine,
  RiCalculatorLine,
  RiFlaskLine,
  RiRobot2Line,
  RiHistoryLine,
  RiLayoutColumnLine,
  RiBrainLine,
} from "@remixicon/react";
import { api } from "@/lib/api";
import type { WatchlistItem } from "@/types";

const PAGES = [
  { label: "Home",        href: "/",                    icon: RiDashboardLine, keywords: "dashboard overview board" },
  { label: "Exit",        href: "/monitor/exit",        icon: RiPulseLine,        keywords: "monitor open spreads delta trigger" },
  { label: "Tracker",     href: "/monitor/tracker",     icon: RiFileListLine,        keywords: "okw log positions" },
  { label: "Performance", href: "/monitor/performance", icon: RiBarChartBoxLine,       keywords: "analytics equity curve sharpe drawdown" },
  { label: "Insights",    href: "/monitor/insights",    icon: RiLightbulbLine,       keywords: "patterns review lessons" },
  { label: "Journal",     href: "/monitor/journal",     icon: RiBookOpenLine,        keywords: "notes reflection review mood" },
  { label: "Analyzer",    href: "/monitor/analyzer",    icon: RiCalculatorLine,      keywords: "options position spread payoff greeks" },
  { label: "Agents",      href: "/agents",              icon: RiBrainLine,  keywords: "debate ai bull bear verdict" },
  { label: "Screener",    href: "/screener",            icon: RiEqualizerLine,          keywords: "filter sector market cap pe dividend rule one" },
  { label: "Depth",       href: "/microstructure",      icon: RiStackLine,          keywords: "order book microstructure volume profile" },
  { label: "Chain",       href: "/trade/chain",         icon: RiLayoutColumnLine,          keywords: "options chain strikes expiry" },
  { label: "Simulate",    href: "/backtest",            icon: RiFlaskLine,    keywords: "backtest strategy presets runs" },
  { label: "Bot",         href: "/bot",                 icon: RiRobot2Line,             keywords: "automation paper trading decisions" },
  { label: "History",     href: "/trade/history",       icon: RiHistoryLine,           keywords: "trades fills flex backfill analysis" },
  { label: "Settings",    href: "/settings",            icon: RiSettings4Line,        keywords: "configuration theme account" },
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
        placeholder="Search symbols or jump to a page"
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
              <RiArrowRightLine size={16} className="mr-2 text-accent-600 shrink-0" aria-hidden />
              <span className="text-body-2-medium mr-2 tabular">{typedSymbol}</span>
              <span className="text-text-tertiary truncate">Chart</span>
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
            <CommandItem
              value={`${typedSymbol} ${query} open chain options`}
              onSelect={() => go(`/options/${typedSymbol}`)}
            >
              <RiStackLine size={16} className="mr-2 text-foreground-icon-tertiary shrink-0" aria-hidden />
              <span className="text-body-2-medium mr-2 tabular">{typedSymbol}</span>
              <span className="text-text-tertiary truncate">Options chain</span>
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
              <p.icon size={16} className="mr-2 text-foreground-icon-tertiary shrink-0" aria-hidden />
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
                  <RiStockLine size={16} className="mr-2 text-foreground-icon-tertiary shrink-0" aria-hidden />
                  <span className="text-body-2-medium mr-2 tabular">{w.symbol}</span>
                  <span className="text-text-tertiary truncate">{w.name}</span>
                  <CommandShortcut>Chart</CommandShortcut>
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
              <RiLineChartLine size={16} className="mr-2 text-foreground-icon-tertiary shrink-0" aria-hidden />
              <span className="text-body-2-medium tabular">{s}</span>
              <CommandShortcut>Chart</CommandShortcut>
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
              <RiStackLine size={16} className="mr-2 text-foreground-icon-tertiary shrink-0" aria-hidden />
              <span className="text-body-2-medium tabular mr-2">{s}</span>
              <span className="text-text-tertiary">Options chain</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
