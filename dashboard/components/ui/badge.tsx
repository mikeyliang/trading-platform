import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// BoardUI Chip, caption variant (components/base/badges/chip.tsx), under the
// desk's semantic names. up / down / warning are for data and connection
// state, accent marks the selected or live thing, muted is neutral metadata.
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-md px-1.5 h-5 text-caption-1-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-background-secondary-default text-text-primary",
        outline: "bg-transparent text-text-secondary shadow-[inset_0_0_0_1px_var(--color-border-button-default)]",
        up: "bg-status-lime-background text-status-lime-text",
        down: "bg-status-rose-background text-status-rose-text",
        warning: "bg-status-yellow-background text-status-yellow-text",
        accent: "bg-status-blue-background text-status-blue-text",
        muted: "bg-background-tertiary-default text-text-secondary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
