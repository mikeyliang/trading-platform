import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

// BoardUI small input: tertiary field, 10px radius, inset ring on focus.
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-8 w-full rounded-2lg bg-background-tertiary-default px-2.5 text-body-2-regular text-text-primary",
      "placeholder:text-text-tertiary outline-none ring-2 ring-inset ring-transparent transition-[background-color,box-shadow] duration-150",
      "hover:bg-background-tertiary-hover focus:bg-background-primary-default focus:ring-border-button-default-focus-ring",
      "file:border-0 file:bg-transparent file:text-body-2-medium",
      "disabled:cursor-not-allowed disabled:text-input-disabled-text disabled:bg-background-primary-disabled",
      "aria-invalid:ring-border-button-default-error",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
