import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { StatusFooter } from "@/components/layout/StatusFooter";
import { WSProvider } from "@/components/layout/WSProvider";
import { HealthProvider } from "@/lib/health";
import { NotConnectedBanner } from "@/components/layout/NotConnectedBanner";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { ConnectionToasts } from "@/components/layout/ConnectionToasts";
import { ChatDrawer } from "@/components/chat/ChatDrawer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";

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
              <Sidebar />
              <div className="flex flex-col flex-1 min-w-0">
                <Header />
                <NotConnectedBanner />
                <main className="flex-1 overflow-auto min-h-0">{children}</main>
                <StatusFooter />
              </div>
              <CommandPalette />
              <ChatDrawer />
              <ConnectionToasts />
              <Toaster />
            </WSProvider>
          </HealthProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
