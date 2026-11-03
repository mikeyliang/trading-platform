"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  BookOpen,
  Settings,
  Activity,
  Clock,
  Filter,
  Bot,
  Layers,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";
import { useHealth } from "@/lib/health";

interface NavEntry {
  href: string;
  icon: LucideIcon;
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
      { href: "/",        icon: LayoutDashboard, label: "Home" },
      { href: "/monitor", icon: Activity,        label: "Monitor" },
    ],
  },
  {
    name: "Market",
    items: [
      { href: "/screener",       icon: Filter, label: "Screener" },
      { href: "/microstructure", icon: Layers, label: "Depth" },
    ],
  },
  {
    name: "Study",
    items: [
      { href: "/backtest",        icon: FlaskConical, label: "Simulate" },
      { href: "/bot",             icon: Bot,          label: "Bot" },
      { href: "/trade/history",   icon: Clock,        label: "History" },
      { href: "/monitor/journal", icon: BookOpen,     label: "Journal" },
    ],
  },
];

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

// Labeled icon rail. 64px wide: wide enough for a word under every icon so
// nobody has to hover to learn the app, narrow enough to leave the chart its
// space. Collapses to an off-canvas drawer on phones.
export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const path = usePathname();
  const { health } = useHealth();
  const connected = !!health?.ib_connected;

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "w-16 flex flex-col items-stretch bg-surface border-r border-border shrink-0",
        "fixed inset-y-0 left-0 z-40 transform transition-transform duration-200",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        "md:static md:translate-x-0 md:transition-none"
      )}
    >
      <Link
        href="/"
        onClick={onMobileClose}
        aria-label={`Trading Terminal, ${connected ? "connected" : "offline"}`}
        className="relative flex items-center justify-center h-12 border-b border-border/60 group"
      >
        <Wordmark />
        <span
          aria-hidden
          className={cn(
            "absolute bottom-2 right-3 h-1.5 w-1.5 rounded-full ring-2 ring-surface",
            connected ? "bg-up" : "bg-text-muted"
          )}
        />
      </Link>

      <nav className="flex-1 flex flex-col gap-3 py-3 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.name} className="flex flex-col gap-0.5">
            <div className="caption text-center text-2xs mb-1 select-none">{g.name}</div>
            {g.items.map((n) => (
              <NavItem key={n.href} {...n} active={isActive(path, n.href)} onNavigate={onMobileClose} />
            ))}
          </div>
        ))}
      </nav>

      <div className="py-2 border-t border-border/60">
        <NavItem
          href="/settings"
          icon={Settings}
          label="Settings"
          active={isActive(path, "/settings")}
          onNavigate={onMobileClose}
        />
      </div>
    </aside>
  );
}

// A small ledger glyph: three rising bars inside a rounded square. Drawn
// inline so it takes the accent token in both themes.
function Wordmark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="text-accent">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" fillOpacity="0.16" />
      <rect x="6" y="12" width="3" height="7" rx="1" fill="currentColor" />
      <rect x="10.5" y="8" width="3" height="11" rx="1" fill="currentColor" />
      <rect x="15" y="5" width="3" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function isActive(path: string | null, href: string) {
  if (!path) return false;
  if (href === "/") return path === "/" || path.startsWith("/chart");
  if (href === "/monitor") return path.startsWith("/monitor") && !path.startsWith("/monitor/journal");
  return path === href || path.startsWith(href);
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
  onNavigate,
}: NavEntry & { active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      prefetch
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "relative mx-1.5 flex flex-col items-center gap-1 py-1.5 transition-colors",
        active
          ? "bg-surface-2 text-text-primary"
          : "text-text-muted hover:text-text-primary hover:bg-surface-2/60"
      )}
    >
      <Icon size={16} />
      <span className="text-2xs leading-none font-medium">{label}</span>
    </Link>
  );
}
