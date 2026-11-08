import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

// One row on the page ground: title, a one-line description, actions right.
// `eyebrow` is accepted for callers that still pass it but is folded into the
// description so nothing renders as a tracked label above the title.
export function PageHeader({ title, eyebrow, description, actions, className }: PageHeaderProps) {
  const sub = description ?? eyebrow;
  return (
    <div className={cn("flex items-end justify-between gap-4 px-1", className)}>
      <div className="min-w-0 flex flex-col gap-0.5">
        <h1 className="text-title-3-semibold text-text-primary truncate">{title}</h1>
        {sub && <p className="text-body-2-regular text-text-secondary">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// Page ground: 12px gutters and gaps so panels float on the full background.
export function PageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 p-3 h-full overflow-y-auto", className)}>{children}</div>;
}
