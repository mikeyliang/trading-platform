// Module shim for date-fns.
//
// The installed copy of date-fns@3.6.0 in node_modules is missing its
// bundled .d.ts / .d.mts files (package.json `exports` points at them but
// they are not present in this environment). This shim declares the
// signatures actually imported by the dashboard so the project type-checks
// without a full dependency reinstall — mirroring types/lucide-react.d.ts.

declare module "date-fns" {
  export interface FormatDistanceToNowOptions {
    addSuffix?: boolean;
    includeSeconds?: boolean;
    locale?: unknown;
  }

  export function formatDistanceToNow(
    date: Date | number,
    options?: FormatDistanceToNowOptions
  ): string;
}
