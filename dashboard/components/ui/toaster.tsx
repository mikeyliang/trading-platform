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
            "!bg-surface !border-border !text-text-primary !shadow-pop !text-xs",
          title: "!text-text-primary !text-xs !font-medium",
          description: "!text-text-secondary !text-xs",
          success: "!border-up/30",
          error: "!border-down/30",
          warning: "!border-warning/30",
          actionButton: "!bg-accent !text-on-fill !text-xs",
          cancelButton: "!bg-surface-2 !text-text-secondary !text-xs",
        },
      }}
    />
  );
}

export { toast } from "sonner";
