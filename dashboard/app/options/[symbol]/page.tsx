import { redirect } from "next/navigation";

export default function OptionsSymbolRedirect({
  params,
}: {
  params: { symbol: string };
}) {
  redirect(`/trade/chain?symbol=${params.symbol.toUpperCase()}`);
}
