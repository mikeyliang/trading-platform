import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-8 w-full bg-surface px-3 py-1 text-xs text-text-primary placeholder:text-text-muted outline-none transition-shadow",
      "shadow-[inset_0_0_0_1px_rgb(var(--c-border))]",
      "file:border-0 file:bg-transparent file:text-xs file:font-medium",
      "focus:shadow-[inset_0_0_0_1px_rgb(var(--c-accent)),0_0_0_3px_rgb(var(--c-accent)/0.15)] focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
