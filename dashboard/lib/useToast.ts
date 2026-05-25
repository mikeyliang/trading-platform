"use client";

import { useMemo } from "react";
import { toast } from "sonner";

type ToastOptions = {
  description?: string;
  duration?: number;
  id?: string | number;
};

export function useToast() {
  return useMemo(
    () => ({
      success: (message: string, options?: ToastOptions) =>
        toast.success(message, options),
      error: (message: string, options?: ToastOptions) =>
        toast.error(message, options),
      info: (message: string, options?: ToastOptions) =>
        toast(message, options),
      dismiss: (id?: string | number) => toast.dismiss(id),
    }),
    [],
  );
}
