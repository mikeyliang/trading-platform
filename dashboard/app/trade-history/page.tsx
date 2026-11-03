import { redirect } from "next/navigation";

// Legacy route. The history page lives under /trade/history with the rest of
// the trade section; keep the query string so ?trade=<id> deep links survive.
export default function LegacyTradeHistory({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null) q.set(k, v);
  }
  const s = q.toString();
  redirect(`/trade/history${s ? `?${s}` : ""}`);
}
