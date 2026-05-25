"use client";

import { useConnectionStatus, type ConnState } from "@/lib/connection";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Always-visible IBKR connection badge for the header. The dot color is the
// primary signal; the tooltip breaks the state down across API / Stream / IB.
// Styling rides on badgeVariants so the pill stays in lockstep with other
// status badges (mode, P&L tones) elsewhere in the UI.
export function ConnectionPill() {
  const { ib, ws, api, ibLabel, ibDescription } = useConnectionStatus();

  const variant = ib === "connected" ? "up" : ib === "reconnecting" ? "warning" : "down";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ibLabel}
          className={cn(
            badgeVariants({ variant }),
            "h-6 px-2 rounded-sm cursor-pointer",
            ib === "connected" && "hover:bg-up/15",
            ib === "reconnecting" && "hover:bg-warning/15",
            ib === "disconnected" && "hover:bg-down/15",
          )}
        >
          <ConnectionDot state={ib} />
          <span>IBKR</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-text-primary">{ibLabel}</div>
          <div className="text-[11px] text-text-secondary leading-snug">{ibDescription}</div>
          <div className="pt-1.5 mt-1 border-t border-border/60 space-y-1">
            <SubLine label="API" state={api} />
            <SubLine label="Stream" state={ws} />
            <SubLine label="IBKR" state={ib} />
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SubLine({ label, state }: { label: string; state: ConnState }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <ConnectionDot state={state} small />
      <span className="text-text-muted uppercase tracking-wider w-12">{label}</span>
      <span className={cn(
        "uppercase tracking-wider tabular",
        state === "connected" && "text-up",
        state === "reconnecting" && "text-warning",
        state === "disconnected" && "text-down",
      )}>
        {state}
      </span>
    </div>
  );
}

export function ConnectionDot({ state, small }: { state: ConnState; small?: boolean }) {
  const size = small ? "w-1.5 h-1.5" : "w-2 h-2";
  const color =
    state === "connected" ? "bg-up"
      : state === "reconnecting" ? "bg-warning"
        : "bg-down";

  return (
    <span className={cn("relative inline-flex items-center justify-center", size)}>
      <span className={cn("absolute inset-0 rounded-full", color)} />
      {state === "reconnecting" && (
        <span className={cn("absolute inset-0 rounded-full animate-ping opacity-75", color)} />
      )}
    </span>
  );
}
