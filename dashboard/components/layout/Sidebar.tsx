"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  RiBookOpenLine,
  RiDashboardLine,
  RiEqualizerLine,
  RiFlaskLine,
  RiHistoryLine,
  RiLayoutColumnLine,
  RiPulseLine,
  RiRobot2Line,
  RiSettings4Line,
  RiStackLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/lib/health";
import { ThemeToggle } from "@/components/application/theme/theme-toggle";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

interface NavEntry {
  href: string;
  icon: IconComponent;
  label: string;
}

interface NavGroup {
  name: string;
  items: NavEntry[];
}

// Three groups, mirroring how a session runs: watch the book, look for the
// next trade, then study. Settings is pinned to the bottom.
const groups: NavGroup[] = [
  {
    name: "Desk",
    items: [
      { href: "/", icon: RiDashboardLine, label: "Home" },
      { href: "/monitor", icon: RiPulseLine, label: "Monitor" },
    ],
  },
  {
    name: "Market",
    items: [
      { href: "/screener", icon: RiEqualizerLine, label: "Screener" },
      { href: "/trade/chain", icon: RiLayoutColumnLine, label: "Chain" },
      { href: "/microstructure", icon: RiStackLine, label: "Depth" },
    ],
  },
  {
    name: "Study",
    items: [
      { href: "/backtest", icon: RiFlaskLine, label: "Simulate" },
      { href: "/bot", icon: RiRobot2Line, label: "Bot" },
      { href: "/trade/history", icon: RiHistoryLine, label: "History" },
      { href: "/monitor/journal", icon: RiBookOpenLine, label: "Journal" },
    ],
  },
];

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

// BoardUI floating sidebar (components/application/dashboard/dashboard-sidebar):
// a 220px panel on the page ground, 24px radius, sidebar elevation. The
// selected row is the one accent gradient on the screen. Off-canvas on phones.
export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const path = usePathname();
  const { health } = useHealth();
  const connected = !!health?.ib_connected;

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "w-[220px] shrink-0 flex flex-col gap-2 p-3 rounded-3xl border border-separator-border-button-default bg-background-secondary-default shadow-sidebar",
        "fixed inset-y-3 left-3 z-40 transform transition-transform duration-200",
        mobileOpen ? "translate-x-0" : "-translate-x-[calc(100%+12px)]",
        "md:static md:inset-auto md:translate-x-0 md:transition-none md:h-full"
      )}
    >
      <Link
        href="/"
        onClick={onMobileClose}
        aria-label={`Trading Terminal, ${connected ? "connected" : "offline"}`}
        className="flex items-center gap-2.5 rounded-2lg p-2 hover:bg-background-secondary-hover transition-colors"
      >
        <Wordmark />
        <span className="flex min-w-0 flex-col">
          <span className="text-body-medium text-text-primary leading-5 truncate">Trading Terminal</span>
          <span className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary leading-4">
            <span aria-hidden className={cn("size-1.5 rounded-full", connected ? "bg-status-lime-text" : "bg-foreground-icon-quaternary")} />
            {connected ? "IBKR connected" : "IBKR offline"}
          </span>
        </span>
      </Link>

      <nav className="flex-1 flex flex-col gap-4 pt-2 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.name} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-caption-1-medium text-text-tertiary select-none">{g.name}</div>
            {g.items.map((n) => (
              <NavItem key={n.href} {...n} active={isActive(path, n.href)} onNavigate={onMobileClose} />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-2 pt-2 border-t border-separator-border">
        <NavItem href="/settings" icon={RiSettings4Line} label="Settings" active={isActive(path, "/settings")} onNavigate={onMobileClose} />
        <ThemeToggle appearance="sidebar-segmented" size="small" />
      </div>
    </aside>
  );
}

// A small ledger glyph: three rising bars inside a rounded square, on the
// accent gradient so it matches the selected row.
function Wordmark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background-tertiary-default">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-text-primary">
        <rect x="2" y="8" width="3" height="6" rx="1" fill="currentColor" />
        <rect x="6.5" y="5" width="3" height="9" rx="1" fill="currentColor" />
        <rect x="11" y="2" width="3" height="12" rx="1" fill="currentColor" />
      </svg>
    </span>
  );
}

function isActive(path: string | null, href: string) {
  if (!path) return false;
  if (href === "/") return path === "/" || path.startsWith("/chart");
  if (href === "/monitor") return path.startsWith("/monitor") && !path.startsWith("/monitor/journal");
  return path === href || path.startsWith(href);
}

function NavItem({ href, icon: Icon, label, active, onNavigate }: NavEntry & { active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      prefetch
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-2lg p-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-border-button-default-focus-ring",
        active ? "bg-linear-to-b from-accent-500 to-accent-600 shadow-nav-selected" : "hover:bg-background-secondary-hover"
      )}
    >
      <Icon className={cn("size-5 shrink-0", active ? "text-white" : "text-foreground-icon-secondary")} aria-hidden />
      <span className={cn("text-body-medium whitespace-nowrap", active ? "text-white" : "text-text-secondary")}>{label}</span>
    </Link>
  );
}
