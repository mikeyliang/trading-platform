// Module shim for lucide-react.
//
// The installed copy of lucide-react in node_modules is missing its bundled
// .d.ts file (the package.json points at dist/lucide-react.d.ts, but the file
// is not present in this environment). This shim declares the LucideIcon
// type and every icon name actually imported by the dashboard, so the
// project type-checks without a full dependency reinstall.

declare module "lucide-react" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  export interface LucideProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
    size?: number | string;
    absoluteStrokeWidth?: boolean;
  }

  export type LucideIcon = ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>;

  export const Activity: LucideIcon;
  export const AlertCircle: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const ArrowDown: LucideIcon;
  export const ArrowRight: LucideIcon;
  export const ArrowUp: LucideIcon;
  export const ArrowUpDown: LucideIcon;
  export const ArrowUpRight: LucideIcon;
  export const BarChart2: LucideIcon;
  export const BarChart3: LucideIcon;
  export const BookOpen: LucideIcon;
  export const Bot: LucideIcon;
  export const Brain: LucideIcon;
  export const Briefcase: LucideIcon;
  export const Calculator: LucideIcon;
  export const CalendarDays: LucideIcon;
  export const CandlestickChart: LucideIcon;
  export const Check: LucideIcon;
  export const CheckCircle2: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const ChevronUp: LucideIcon;
  export const ChevronsUpDown: LucideIcon;
  export const Circle: LucideIcon;
  export const CircleDollarSign: LucideIcon;
  export const Clipboard: LucideIcon;
  export const ClipboardCheck: LucideIcon;
  export const Copy: LucideIcon;
  export const Edit3: LucideIcon;
  export const Eraser: LucideIcon;
  export const Eye: LucideIcon;
  export const Filter: LucideIcon;
  export const FlaskConical: LucideIcon;
  export const Gauge: LucideIcon;
  export const Gavel: LucideIcon;
  export const History: LucideIcon;
  export const Hourglass: LucideIcon;
  export const Info: LucideIcon;
  export const Layers: LucideIcon;
  export const LayoutDashboard: LucideIcon;
  export const LineChart: LucideIcon;
  export const Link: LucideIcon;
  export const Loader2: LucideIcon;
  export const Menu: LucideIcon;
  export const MessageSquare: LucideIcon;
  export const Newspaper: LucideIcon;
  export const Notebook: LucideIcon;
  export const Pencil: LucideIcon;
  export const Play: LucideIcon;
  export const Plus: LucideIcon;
  export const Receipt: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Rocket: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const Ruler: LucideIcon;
  export const Save: LucideIcon;
  export const Search: LucideIcon;
  export const Send: LucideIcon;
  export const Settings: LucideIcon;
  export const Settings2: LucideIcon;
  export const ShieldAlert: LucideIcon;
  export const Sigma: LucideIcon;
  export const Sliders: LucideIcon;
  export const SlidersHorizontal: LucideIcon;
  export const Sparkles: LucideIcon;
  export const Square: LucideIcon;
  export const Tag: LucideIcon;
  export const Target: LucideIcon;
  export const Trash2: LucideIcon;
  export const TrendingDown: LucideIcon;
  export const TrendingUp: LucideIcon;
  export const Wand2: LucideIcon;
  export const Waves: LucideIcon;
  export const WifiOff: LucideIcon;
  export const X: LucideIcon;
  export const XCircle: LucideIcon;
}
