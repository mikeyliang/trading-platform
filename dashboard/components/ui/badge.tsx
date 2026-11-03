import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status chip. Semantic variants (up / down / warning) are reserved for data
// and connection state; `accent` marks the interactive or selected thing;
// `muted` is for neutral metadata such as account mode.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 px-2 h-5 text-2xs font-medium whitespace-nowrap transition-colors [&>span]:cap",
  {
    variants: {
      variant: {
        default: "bg-surface-2 text-text-primary",
        outline: "bg-transparent text-text-secondary shadow-[inset_0_0_0_1px_rgb(var(--c-border))]",
        up: "bg-up/12 text-up",
        down: "bg-down/12 text-down",
        warning: "bg-warning/15 text-warning",
        accent: "bg-accent/12 text-accent-fg",
        muted: "bg-surface-2 text-text-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props}><span className="cap">{children}</span></div>;
}

export { Badge, badgeVariants };
