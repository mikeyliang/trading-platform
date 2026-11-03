import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
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

// IBM Plex: a humanist grotesque with a matching mono, built for data-dense
// screens. Loaded at build time by next/font (self-hosted, no runtime
// request); if the download is unavailable at build, Next falls back to the
// system stack declared in globals.css.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trading Terminal",
  description: "NautilusTrader-powered trading platform",
};

// Runs before first paint so the page never flashes the wrong theme. Dark is
// the default; an explicit "light" choice in localStorage wins.
const themeScript = `
try {
  var t = localStorage.getItem("theme");
  if (t !== "light") document.documentElement.classList.add("dark");
} catch (e) { document.documentElement.classList.add("dark"); }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex h-screen overflow-hidden bg-bg text-text-primary font-sans">
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
      </body>
    </html>
  );
}
