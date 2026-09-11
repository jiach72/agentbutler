---
name: agent-butler-design
description: Use this skill to generate well-branded interfaces for Agent Butler. Contains colors, type, fonts, assets, and UI kit for prototyping dashboard UIs.
user-invocable: true
---
# Agent Butler Design Skill

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts, copy assets out and create static HTML files. If working on production code, read the rules here to become an expert in designing with this brand.

## Quick map

- `README.md` — brand context, content fundamentals, visual foundations (read first)
- `colors_and_type.css` — drop-in CSS variables for colors, type, radius, shadow, spacing
- `css.json` — structured token understanding source
- `components/index.json` — component index + cross-component patterns
- `components.css` — aggregated component CSS
- `library-consumption.json` — recommended downstream read order
- `preview/` — small HTML cards illustrating foundations and components

## Essentials at a glance

- Primary `#207466` (deep teal-green) — a single restrained accent for health/trust; no gradients, no neon, no purple cards.
- Radius `8 / 10 / 12` px (sm/md/lg) with `9999px` pill reserved for status badges and dots — compact, never softer.
- Control height `40px` (md button, `32` sm / `48` lg; input `36px`), on a `4px` spacing base.
- Type: **Manrope** (display/headings), **Inter** (body), **JetBrains Mono** (metrics/numbers).
- Voice: 中文, calm professional-butler tone — "运行正常 / 立即检查 / 高级详情", no emoji.
- Shadow: whisper-quiet warm-grey `rgba(42,38,34,…)`; cards rest at `shadow-1`, elevate only on hover.
- Signature: status via a left `4px` card border bar + low-saturation semantic badges, not loud fills.

## Components

| Slug | Name | Key Insight |
|------|------|-------------|
| button | Button | 32/40/48px sizes; primary/secondary/ghost/danger with a 2px primary focus ring |
| card | Card | White card, 1px warm border, shadow-1; left 4px status bar marks success/warning/danger |
| table | Table | Data-dense rows, caption-grey headers, status badges carry a 6px dot |
| chart | Chart | Primary `#338f7e` line/spark; semantic fills map to success/warning/error/info |
| navigation | Navigation | Page header with breadcrumb + primary/ghost actions, Manrope titles |
| sidebar | Sidebar | 240px collapsing to 64px; active item = `primary-50` fill + left primary bar |
