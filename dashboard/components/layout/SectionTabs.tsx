"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * Minimal tab strip used at the top of /trade and /monitor section layouts.
 * Active tab is determined by whether ``pathname`` starts with the tab href.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 px-1 md:px-4 h-10 border-b border-border bg-surface shrink-0 overflow-x-auto">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            prefetch
            className={cn(
              "relative px-1 mx-2 h-10 flex items-center text-xs font-medium transition-colors shrink-0",
              active
                ? "text-text-primary"
                : "text-text-muted hover:text-text-secondary"
            )}
          >
            {t.label}
            {active && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-text-primary" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
