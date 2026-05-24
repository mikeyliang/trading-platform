import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { WSProvider } from "@/components/layout/WSProvider";
import { HealthProvider } from "@/lib/health";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { ChatDrawer } from "@/components/chat/ChatDrawer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";

export const metadata: Metadata = {
  title: "Trading Terminal",
  description: "NautilusTrader-powered trading platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden bg-bg text-text-primary">
        <TooltipProvider delayDuration={200}>
          <HealthProvider>
            <WSProvider>
              <AppShell>{children}</AppShell>
              <CommandPalette />
              <ChatDrawer />
              <Toaster />
              <ErrorBoundary />
            </WSProvider>
          </HealthProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
