import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider border transition-colors",
  {
    variants: {
      variant: {
        default: "bg-surface-3 text-text-secondary border-border",
        outline: "bg-transparent text-text-secondary border-border",
        up: "bg-up/10 text-up border-up/30",
        down: "bg-down/10 text-down border-down/30",
        warning: "bg-warning/10 text-warning border-warning/30",
        accent: "bg-accent/10 text-accent border-accent/30",
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
