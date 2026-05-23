import { SectionTabs } from "@/components/layout/SectionTabs";

// /monitor/analyzer stays as a route (PositionsPanel deep-links to it) but
// isn't a primary tab — it's a detail view, opened by clicking a position.
const MONITOR_TABS = [
  { href: "/monitor/exit",        label: "Exit" },
  { href: "/monitor/tracker",     label: "Tracker" },
  { href: "/monitor/performance", label: "Performance" },
  { href: "/monitor/journal",     label: "Journal" },
];

export default function MonitorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <SectionTabs tabs={MONITOR_TABS} />
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </div>
  );
}
