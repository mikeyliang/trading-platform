import * as React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn("w-full caption-bottom text-xs", className)} {...props} />
    </div>
  )
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("sticky top-0 z-10 bg-surface", className)} {...props} />
  )
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("", className)} {...props} />
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("border-b border-border/50 transition-colors hover:bg-surface-2 data-[state=selected]:bg-surface-2", className)}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-6 px-2 text-left align-middle font-normal text-[10px] uppercase tracking-wider text-text-muted border-b border-border",
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-2 py-1 align-middle", className)} {...props} />
  )
);
TableCell.displayName = "TableCell";

const TableEmpty = ({ colSpan, children }: { colSpan: number; children: React.ReactNode }) => (
  <tr>
    <td colSpan={colSpan} className="text-center py-10 text-text-muted text-[11px]">
      {children}
    </td>
  </tr>
);

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K;
  direction: SortDirection;
}

/**
 * Header cell that toggles sort state. Click cycles asc → desc → asc on the
 * same column; clicking a new column adopts the column's `defaultDirection`
 * (numeric columns default to desc — most users want "biggest first").
 */
interface SortableTableHeadProps<K extends string>
  extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "onClick"> {
  sortKey: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  defaultDirection?: SortDirection;
  align?: "left" | "right";
}

function SortableTableHead<K extends string>({
  sortKey,
  sort,
  onSort,
  align = "left",
  className,
  children,
  ...props
}: SortableTableHeadProps<K>) {
  const active = sort?.key === sortKey;
  const direction = active ? sort!.direction : null;
  return (
    <TableHead
      className={cn(align === "right" && "text-right", className)}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-0.5 select-none transition-colors hover:text-text-primary",
          align === "right" && "flex-row-reverse",
          active && "text-accent"
        )}
      >
        <span>{children}</span>
        {active ? (
          direction === "asc" ? (
            <ChevronUp size={10} className="shrink-0" />
          ) : (
            <ChevronDown size={10} className="shrink-0" />
          )
        ) : (
          <ChevronsUpDown size={10} className="shrink-0 opacity-30" />
        )}
      </button>
    </TableHead>
  );
}

/**
 * Manages sort state + returns sorted rows. `accessors` maps each sortable
 * column key to a value extractor; the hook handles numeric vs. string
 * comparison and nullish coalescing. Pass `initial` to set a default sort.
 */
function useTableSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => string | number | null | undefined>,
  initial: SortState<K> | null = null,
  numericDefaults: ReadonlyArray<K> = []
): {
  sorted: T[];
  sort: SortState<K> | null;
  toggleSort: (key: K) => void;
} {
  const [sort, setSort] = React.useState<SortState<K> | null>(initial);

  const toggleSort = React.useCallback(
    (key: K) => {
      setSort((current) => {
        if (current?.key === key) {
          return { key, direction: current.direction === "asc" ? "desc" : "asc" };
        }
        return {
          key,
          direction: numericDefaults.includes(key) ? "desc" : "asc",
        };
      });
    },
    [numericDefaults]
  );

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const accessor = accessors[sort.key];
    if (!accessor) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      // Nulls always sort to the bottom regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * factor;
      }
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, sort, accessors]);

  return { sorted, sort, toggleSort };
}

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableEmpty,
  SortableTableHead,
  useTableSort,
};
