"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      duration={3000}
      toastOptions={{
        classNames: {
          toast:
            "!bg-surface-2 !border-border !text-text-primary !shadow-[0_0_0_1px_rgb(var(--c-border)),0_12px_32px_-8px_rgb(0_0_0/0.35)] !rounded-none !text-xs",
          title: "!text-text-primary !text-xs !font-medium",
          description: "!text-text-secondary !text-xs",
          success: "[&_svg]:!text-up",
          error: "[&_svg]:!text-down",
          warning: "[&_svg]:!text-warning",
          actionButton: "!bg-accent !text-on-fill !text-xs",
          cancelButton: "!bg-surface-2 !text-text-secondary !text-xs",
        },
      }}
    />
  );
}

export { toast } from "sonner";
