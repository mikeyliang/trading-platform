"use client";

import { RiLoader4Line as Loader2, RiCheckboxCircleFill as CheckCircle2, RiCloseCircleFill as XCircle, RiCircleLine as Circle, RiPencilLine as Pencil } from "@remixicon/react";
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
    tone: "text-text-tertiary",
    bg: "bg-background-primary-default",
    ring: "border-separator-border",
    label: "Idle",
  },
  thinking: {
    tone: "text-accent-500",
    bg: "bg-status-blue-background",
    ring: "border-accent-500",
    label: "Thinking",
  },
  responding: {
    tone: "text-status-yellow-text",
    bg: "bg-status-yellow-background",
    ring: "border-status-yellow-text",
    label: "Responding",
  },
  done: {
    tone: "text-status-lime-text",
    bg: "bg-status-lime-background",
    ring: "border-status-lime-text",
    label: "Done",
  },
  error: {
    tone: "text-status-rose-text",
    bg: "bg-status-rose-background",
    ring: "border-status-rose-text",
    label: "Error",
  },
};

export function AgentStatusRail({ items }: Props) {
  return (
    <section className="rounded-lg border border-separator-border bg-background-primary-default p-3">
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const meta = STATUS_META[item.status];
          return (
            <div
              key={item.key}
              className={cn(
                "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-caption-1-regular transition-colors min-w-[150px]",
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
                <span className="text-caption-2-regular text-text-tertiary">
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
      return <Loader2 size={13} className="animate-spin text-accent-500" />;
    case "responding":
      return <Pencil size={13} className="text-status-yellow-text animate-pulse" />;
    case "done":
      return <CheckCircle2 size={13} className="text-status-lime-text" />;
    case "error":
      return <XCircle size={13} className="text-status-rose-text" />;
    case "idle":
    default:
      return <Circle size={13} className="text-text-tertiary" />;
  }
}
