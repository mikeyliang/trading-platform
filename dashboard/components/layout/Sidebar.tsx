"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  BookOpen,
  Settings,
  Activity,
  Filter,
  Bot,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useHealth } from "@/lib/health";

interface NavEntry {
  href: string;
  icon: LucideIcon;
  label: string;
}

// Grouped to mirror IBKR TWS module rails: primary workspace, market lookups,
// research, then settings pinned to the bottom.
const primary: NavEntry[] = [
  { href: "/",        icon: LayoutDashboard, label: "Dashboard" },
  { href: "/monitor", icon: Activity,        label: "Monitor" },
];

const market: NavEntry[] = [
  { href: "/screener",       icon: Filter, label: "Screener" },
  { href: "/microstructure", icon: Layers, label: "Microstructure" },
];

const research: NavEntry[] = [
  { href: "/agents", icon: Bot, label: "AI Debate" },
];

export function Sidebar() {
  const path = usePathname();
  const { health } = useHealth();
  const connected = !!health?.ib_connected;

  return (
    <aside className="w-12 flex flex-col items-center py-2 gap-0.5 bg-bg border-r border-border/60 shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/"
            className="relative w-7 h-7 rounded-sm bg-accent flex items-center justify-center mb-1 shrink-0"
          >
            <BookOpen size={12} className="text-white" />
            {connected && (
              <span className="absolute -bottom-0.5 -right-0.5 flex">
                <span className="absolute inline-flex h-1.5 w-1.5 rounded-full bg-up opacity-60 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up border border-bg" />
              </span>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          Trading Terminal {connected ? "· LIVE" : "· offline"}
        </TooltipContent>
      </Tooltip>

      <Separator className="my-1 w-5" />

      {primary.map((n) => (
        <NavItem key={n.href} {...n} active={isActive(path, n.href)} />
      ))}

      <Separator className="my-1 w-5" />

      {market.map((n) => (
        <NavItem key={n.href} {...n} active={isActive(path, n.href)} />
      ))}

      <Separator className="my-1 w-5" />

      {research.map((n) => (
        <NavItem key={n.href} {...n} active={isActive(path, n.href)} />
      ))}

      <div className="mt-auto">
        <NavItem
          href="/settings"
          icon={Settings}
          label="Settings"
          active={isActive(path, "/settings")}
        />
      </div>
    </aside>
  );
}

function isActive(path: string | null, href: string) {
  if (!path) return false;
  return path === href || (href !== "/" && path.startsWith(href));
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: NavEntry & { active: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          prefetch
          aria-label={label}
          className={cn(
            "relative w-8 h-8 flex items-center justify-center rounded-sm transition-colors",
            active
              ? "bg-surface-3 text-text-primary"
              : "text-text-muted hover:text-text-secondary hover:bg-surface-2"
          )}
        >
          {active && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full bg-accent" />
          )}
          <Icon size={14} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
