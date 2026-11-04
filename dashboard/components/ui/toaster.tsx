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
            "!bg-background-primary-default !border-border-button-default !text-text-primary !shadow-dropdown !rounded-2lg !text-body-2-regular",
          title: "!text-text-primary !text-body-2-medium",
          description: "!text-text-secondary !text-caption-1-regular",
          success: "[&_svg]:!text-status-lime-text",
          error: "[&_svg]:!text-status-rose-text",
          warning: "[&_svg]:!text-status-yellow-text",
          actionButton: "!bg-button-primary !text-text-white !text-caption-1-semibold !rounded-md",
          cancelButton: "!bg-background-secondary-default !text-text-secondary !text-caption-1-semibold !rounded-md",
        },
      }}
    />
  );
}

export { toast } from "sonner";
