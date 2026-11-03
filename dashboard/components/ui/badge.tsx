import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status chip. Semantic variants (up / down / warning) are reserved for data
// and connection state; `accent` marks the interactive or selected thing;
// `muted` is for neutral metadata such as account mode.
const badgeVariants = cva(
  "inline-flex items-center gap-1 px-1.5 h-[18px] text-2xs font-medium border leading-none whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default: "bg-surface-3 text-text-secondary border-border",
        outline: "bg-transparent text-text-secondary border-border",
        up: "bg-up/10 text-up border-up/25",
        down: "bg-down/10 text-down border-down/25",
        warning: "bg-warning/10 text-warning border-warning/30",
        accent: "bg-accent/10 text-accent-fg border-accent/25",
        muted: "bg-surface-2 text-text-muted border-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
