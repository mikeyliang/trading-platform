"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { logoUrlForSymbol } from "@/lib/logos";

interface LogoProps {
  symbol: string;
  size?: number;
  className?: string;
}

/**
 * Company logo via Clearbit (free, no auth). Falls back to a
 * colored-initial circle when the symbol isn't mapped or the image fails.
 */
export function Logo({ symbol, size = 24, className }: LogoProps) {
  const url = logoUrlForSymbol(symbol);
  const [errored, setErrored] = useState(false);
  const useImg = !!url && !errored;

  return (
    <div
      className={cn(
        "shrink-0 rounded-md overflow-hidden flex items-center justify-center select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: useImg ? "#ffffff" : hashedColor(symbol),
      }}
    >
      {useImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url!}
          alt={symbol}
          width={size}
          height={size}
          loading="lazy"
          onError={() => setErrored(true)}
          className="object-contain w-full h-full"
        />
      ) : (
        <span
          className="font-semibold text-white"
          style={{ fontSize: Math.max(9, size * 0.42) }}
        >
          {symbol.slice(0, 2)}
        </span>
      )}
    </div>
  );
}

// Deterministic muted color per symbol for the fallback bubble.
function hashedColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 35%, 32%)`;
}
