import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-2", className)}
      {...props}
    />
  );
}

// Lightweight inline spinner — sized by the parent text size via `currentColor`.
export function Spinner({ className, size = 12 }: { className?: string; size?: number }) {
  return (
    <Loader2
      className={cn("animate-spin text-text-muted", className)}
      size={size}
      aria-hidden
    />
  );
}

// Centered spinner block for panel-level loading states.
export function LoadingBlock({ label, className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-10 text-text-muted",
        className,
      )}
    >
      <Spinner size={16} />
      {label && <span className="text-[11px] uppercase tracking-wider">{label}</span>}
    </div>
  );
}

// Skeleton rows shaped to fit inside a <Table>. Useful while initial fetch
// is in flight — keeps row heights stable so the table doesn't jump when
// the first real row arrives.
export function TableSkeletonRows({
  rows = 4,
  cols,
  widths,
}: {
  rows?: number;
  cols: number;
  widths?: string[];
}) {
  const ws = widths ?? Array.from({ length: cols }, () => "w-full");
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-border/50">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-2 py-1.5">
              <Skeleton className={cn("h-3", ws[c] ?? "w-full")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
