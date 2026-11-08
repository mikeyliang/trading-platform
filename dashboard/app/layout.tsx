import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { WSProvider } from "@/components/layout/WSProvider";
import { HealthProvider } from "@/lib/health";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { ConnectionToasts } from "@/components/layout/ConnectionToasts";
import { ChatDrawer } from "@/components/chat/ChatDrawer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { DirectionProvider } from "@/components/foundations/direction/direction";

// BoardUI's type scale is set in Inter with the optical-size axis; figures
// use its tabular numerals. JetBrains Mono is for code only.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-source",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trading Terminal",
  description: "Rule One options desk: RUT and SPX bull put spreads, positions, watchlist and live chart on IBKR.",
};

// Runs before first paint so the page never flashes the wrong theme. Dark is
// the default; an explicit "light" choice wins. The key is shared with the
// BoardUI theme toggle in the sidebar.
const themeScript = `
try {
  var t = localStorage.getItem("boardui:theme");
  if (t !== "light") document.documentElement.classList.add("dark");
} catch (e) { document.documentElement.classList.add("dark"); }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-US" dir="ltr" className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex h-screen overflow-hidden bg-background-full text-text-primary font-sans">
        <DirectionProvider locale="en-US">
          <TooltipProvider delayDuration={200}>
            <HealthProvider>
              <WSProvider>
                <AppShell>{children}</AppShell>
                <CommandPalette />
                <ChatDrawer />
                <ConnectionToasts />
                <Toaster />
                <ErrorBoundary />
              </WSProvider>
            </HealthProvider>
          </TooltipProvider>
        </DirectionProvider>
      </body>
    </html>
  );
}
