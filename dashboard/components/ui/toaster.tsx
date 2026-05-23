"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        classNames: {
          toast:
            "!bg-surface !border-border !text-text-primary !shadow-xl !text-xs",
          title: "!text-text-primary !text-xs !font-medium",
          description: "!text-text-secondary !text-[11px]",
          success: "!border-up/30",
          error: "!border-down/30",
          warning: "!border-warning/30",
          actionButton: "!bg-accent !text-white !text-[11px]",
          cancelButton: "!bg-surface-2 !text-text-secondary !text-[11px]",
        },
      }}
    />
  );
}

export { toast } from "sonner";
