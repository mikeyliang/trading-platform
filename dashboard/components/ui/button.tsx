import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Button recipes from BoardUI (components/base/buttons/button.tsx), kept
// behind the shadcn-style API the desk already uses. `default` is BoardUI's
// primary, `outline` and `secondary` are both its secondary, `destructive` is
// danger. Sizes: small is the desk default (32px), xs is 24px, medium 36px.
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1 whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow] duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-border-button-default-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-primary-default",
    "disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-button-primary text-text-white shadow-xs disabled:text-button-primary-disabled-foreground disabled:shadow-none",
        secondary:
          "bg-background-primary-default text-text-primary border border-separator-border-button-default shadow-xs hover:bg-background-primary-hover hover:border-separator-border-button-hover active:bg-background-primary-active disabled:bg-background-primary-disabled disabled:text-text-tertiary disabled:shadow-none",
        outline:
          "bg-background-primary-default text-text-primary border border-separator-border-button-default shadow-xs hover:bg-background-primary-hover hover:border-separator-border-button-hover active:bg-background-primary-active disabled:bg-background-primary-disabled disabled:text-text-tertiary disabled:shadow-none",
        ghost:
          "bg-button-ghost-background text-button-ghost-foreground hover:bg-button-ghost-hover active:bg-button-ghost-active disabled:text-button-ghost-disabled-foreground",
        destructive: "bg-button-danger text-text-white shadow-xs disabled:text-foreground-disabled-danger disabled:shadow-none",
        success: "bg-status-lime-background text-status-lime-text hover:brightness-95 disabled:opacity-50",
        link: "text-accent-600 underline-offset-4 hover:underline px-0",
      },
      size: {
        default: "h-8 rounded-lg px-2.5 text-body-2-medium [&_svg]:size-[18px]",
        sm: "h-6 rounded-sm px-2 text-caption-1-semibold [&_svg]:size-3.5",
        lg: "h-9 rounded-2lg px-3 text-body-medium [&_svg]:size-5",
        icon: "size-8 rounded-lg p-0 [&_svg]:size-[18px]",
        "icon-sm": "size-6 rounded-sm p-0 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
