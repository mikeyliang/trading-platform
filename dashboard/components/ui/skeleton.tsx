import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "animate-pulse rounded-md bg-surface-2/70 border border-border/40",
        className
      )}
      {...props}
    />
  );
}

/**
 * Row of skeleton bars sized to mimic a single table row. Use inside
 * <TableBody> for tabular loading states that keep column alignment.
 */
export function TableRowSkeleton({
  cols,
  className,
}: {
  cols: number;
  className?: string;
}) {
  return (
    <tr className={cn("border-b border-border/40", className)} aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-2 py-1.5">
          <Skeleton
            className="h-3"
            style={{ width: `${50 + ((i * 17) % 40)}%` }}
          />
        </td>
      ))}
    </tr>
  );
}
