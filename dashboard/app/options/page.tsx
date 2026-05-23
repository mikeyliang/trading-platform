import { redirect } from "next/navigation";

export default function OptionsIndex() {
  redirect("/trade/chain?symbol=SPY");
}
