import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface LoadingSpinnerProps {
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  text?: string;
  /** Hide the spinner visually but keep aria-live region for screen readers. */
  srOnly?: boolean;
}

const sizeClasses = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function LoadingSpinner({
  size = "md",
  className,
  text,
  srOnly = false,
}: LoadingSpinnerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center justify-center gap-2", className)}
    >
      <Loader2
        className={cn(
          "animate-spin text-text-muted",
          sizeClasses[size],
          srOnly && "sr-only"
        )}
        aria-hidden={!srOnly}
      />
      {text && (
        <span className="text-[11px] text-text-muted tabular">{text}</span>
      )}
      <span className="sr-only">{text ?? "Loading"}</span>
    </div>
  );
}

export function FullPageLoader({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="flex items-center justify-center min-h-[400px] animate-fade-in">
      <LoadingSpinner size="lg" text={text} />
    </div>
  );
}
