"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * BoardUI underline tabs for the /trade and /monitor section layouts. The
 * active tab is the one whose href is a prefix of the pathname.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 px-1 h-10 border-b border-separator-border shrink-0 overflow-x-auto">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            prefetch
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative px-2.5 h-10 flex items-center transition-colors shrink-0 rounded-t-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-button-default-focus-ring",
              active ? "text-body-2-medium text-accent-500-600" : "text-body-2-regular text-text-secondary hover:text-text-primary"
            )}
          >
            {t.label}
            {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent-500-600" />}
          </Link>
        );
      })}
    </nav>
  );
}
