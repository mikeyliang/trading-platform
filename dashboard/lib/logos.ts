// Stock logos route through the API's MinIO-backed cache so any ticker
// gets a logo (lazily hydrated from public sources on first request),
// not just the hardcoded set. The Logo component handles 404 → initials
// fallback automatically.

export function logoUrlForSymbol(symbol: string): string {
  return `/api/logos/${encodeURIComponent(symbol.toUpperCase())}`;
}
