"use client";

import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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

// One status dot per agent; the dot carries the colour, the word carries
// the meaning, so a row never rests on colour alone.
const STATUS_META: Record<AgentStatus, { dot: string; text: string; label: string }> = {
  idle: { dot: "bg-foreground-icon-quaternary", text: "text-text-tertiary", label: "Idle" },
  thinking: { dot: "bg-accent-600 animate-pulse", text: "text-accent-600", label: "Thinking" },
  responding: { dot: "bg-status-yellow-text animate-pulse", text: "text-status-yellow-text", label: "Responding" },
  done: { dot: "bg-status-lime-text", text: "text-status-lime-text", label: "Done" },
  error: { dot: "bg-status-rose-text", text: "text-status-rose-text", label: "Error" },
};

export function AgentStatusRail({ items }: Props) {
  const done = items.filter((i) => i.status === "done").length;
  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <Badge variant="muted" className="tabular">{done} of {items.length} done</Badge>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {items.map((item) => {
            const meta = STATUS_META[item.status];
            return (
              <li
                key={item.key}
                data-status={item.status}
                className="rounded-2lg bg-background-secondary-default px-3 h-10 flex items-center gap-2 min-w-0"
              >
                <span className={cn("size-2 rounded-full shrink-0", meta.dot)} aria-hidden />
                <span className="text-body-2-medium text-text-primary truncate flex-1">{item.label}</span>
                <span className={cn("text-caption-1-medium whitespace-nowrap tabular", meta.text)}>
                  {meta.label}
                  {item.status === "done" && item.durationMs != null && (
                    <span className="text-text-tertiary"> {(item.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
