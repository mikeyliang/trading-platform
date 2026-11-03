# Design lock: Trading Terminal on BoardUI

Theme: BoardUI, both modes, dark default. Genre modern-minimal, posture restrained.

## Surfaces
- Ground: `bg-background-full`. Everything floats on it with 12px gaps (`gap-3`, `p-3`).
- Panel: `rounded-3xl border border-border-button-default bg-background-primary-default shadow-card`. Header row h-11 px-4 with `border-b border-separator-border`; body `p-4`, dense tables `p-0`.
- Inner tile: `rounded-2lg bg-background-secondary-default` (no border).
- Sidebar: BoardUI floating panel, 220px, `rounded-3xl bg-background-secondary-default border border-border-button-default shadow-sidebar`, selected row = accent gradient + `shadow-nav-selected`, white text.
- Popovers: `rounded-2lg bg-background-primary-default border border-border-button-default shadow-dropdown`.

## Type (BoardUI composite utilities only)
- Page title `text-title-3-semibold`; panel title `text-body-semibold`; body `text-body-2-regular`; table cells `text-body-2-medium`; labels and meta `text-caption-1-medium text-text-tertiary`; big figures `text-title-2-semibold` with `tabular`.
- Sentence case everywhere. No eyebrows, no tracked caps, no middle dots: separate meta with gaps or a `·`-free "Sep" hairline.

## Colour
- Accent (`accent-500/600`) only for the primary action, the selected nav row, the selected tab underline and the selected table row.
- Gain `text-status-lime-text` / loss `text-status-rose-text`, each always with a sign or arrow. Warning `status-yellow`. Live account = yellow chip, paper = neutral chip.
- Chips: `Badge` adapter maps to BoardUI Chip caption variant.

## Controls
- Button: primary / secondary / ghost / danger from BoardUI, sizes small (h-8) default, xs (h-6), medium (h-9). Icons 18px via Remix (`Ri*Line` for chrome, `Ri*Fill` for small 14px statuses).
- Input: `rounded-2lg bg-background-tertiary-default` ring-on-focus, h-8.
- Segmented control: tertiary track p-1 `rounded-2lg`, selected `bg-background-primary-default shadow-2xs rounded-md`.
- Tabs: underline, 2px `accent-600`, `text-body-2-medium`, h-10.
- Tables: header `bg-background-secondary-default text-caption-1-medium text-text-tertiary` h-8, rows h-9 `border-b border-separator-border`, hover `bg-background-secondary-hover`, numbers right-aligned `tabular`.

## States
Every data region has loading (skeleton), empty (EmptyState with Remix icon tile), error (rose chip + retry) and full.
