"use client";

import { Loader2, CheckCircle2, XCircle, Circle, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentStatus = "idle" | "thinking" | "responding" | "done" | "error";

export interface AgentRailItem {
  key: string;
  label: string;
  status: AgentStatus;
  durationMs?: number;
}

interface Props {
  items: AgentRailItem[];
}

const STATUS_META: Record<
  AgentStatus,
  { tone: string; bg: string; ring: string; label: string }
> = {
  idle: {
    tone: "text-text-muted",
    bg: "bg-surface",
    ring: "border-border",
    label: "Idle",
  },
  thinking: {
    tone: "text-accent",
    bg: "bg-accent/5",
    ring: "border-accent/40",
    label: "Thinking",
  },
  responding: {
    tone: "text-warning",
    bg: "bg-warning/5",
    ring: "border-warning/40",
    label: "Responding",
  },
  done: {
    tone: "text-up",
    bg: "bg-up/5",
    ring: "border-up/40",
    label: "Done",
  },
  error: {
    tone: "text-down",
    bg: "bg-down/5",
    ring: "border-down/40",
    label: "Error",
  },
};

export function AgentStatusRail({ items }: Props) {
  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const meta = STATUS_META[item.status];
          return (
            <div
              key={item.key}
              className={cn(
                "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-[11px] transition-colors min-w-[150px]",
                meta.bg,
                meta.ring
              )}
              data-status={item.status}
            >
              <StatusIcon status={item.status} />
              <div className="flex flex-col min-w-0">
                <span className={cn("font-medium truncate", meta.tone)}>
                  {item.label}
                </span>
                <span className="text-[10px] text-text-muted uppercase tracking-wider">
                  {meta.label}
                  {item.status === "done" && item.durationMs != null && (
                    <span className="ml-1 tabular">
                      · {(item.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: AgentStatus }) {
  switch (status) {
    case "thinking":
      return <Loader2 size={13} className="animate-spin text-accent" />;
    case "responding":
      return <Pencil size={13} className="text-warning animate-pulse" />;
    case "done":
      return <CheckCircle2 size={13} className="text-up" />;
    case "error":
      return <XCircle size={13} className="text-down" />;
    case "idle":
    default:
      return <Circle size={13} className="text-text-muted" />;
  }
}
