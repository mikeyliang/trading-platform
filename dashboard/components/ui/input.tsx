import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-primary placeholder:text-text-muted outline-none transition-colors",
      "file:border-0 file:bg-transparent file:text-xs file:font-medium",
      "focus:border-accent focus-visible:ring-1 focus-visible:ring-accent/40",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
