---
name: Ethereal Precision
colors:
  surface: '#faf8fe'
  surface-dim: '#dad9df'
  surface-bright: '#faf8fe'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f3f8'
  surface-container: '#eeedf3'
  surface-container-high: '#e9e7ed'
  surface-container-highest: '#e3e2e7'
  on-surface: '#1a1b1f'
  on-surface-variant: '#414753'
  inverse-surface: '#2f3034'
  inverse-on-surface: '#f1f0f5'
  outline: '#717785'
  outline-variant: '#c1c6d6'
  surface-tint: '#005cbb'
  primary: '#0059b5'
  on-primary: '#ffffff'
  primary-container: '#0071e3'
  on-primary-container: '#fcfbff'
  inverse-primary: '#abc7ff'
  secondary: '#5f5e60'
  on-secondary: '#ffffff'
  secondary-container: '#e2dfe1'
  on-secondary-container: '#636264'
  tertiary: '#006a26'
  on-tertiary: '#ffffff'
  tertiary-container: '#008633'
  on-tertiary-container: '#f1ffec'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d7e2ff'
  primary-fixed-dim: '#abc7ff'
  on-primary-fixed: '#001b3f'
  on-primary-fixed-variant: '#00458f'
  secondary-fixed: '#e4e2e4'
  secondary-fixed-dim: '#c8c6c8'
  on-secondary-fixed: '#1b1b1d'
  on-secondary-fixed-variant: '#474649'
  tertiary-fixed: '#72fe88'
  tertiary-fixed-dim: '#53e16f'
  on-tertiary-fixed: '#002107'
  on-tertiary-fixed-variant: '#00531c'
  background: '#faf8fe'
  on-background: '#1a1b1f'
  surface-variant: '#e3e2e7'
typography:
  display-hero:
    fontFamily: Plus Jakarta Sans
    fontSize: 56px
    fontWeight: '700'
    lineHeight: 64px
    letterSpacing: -0.035em
  display-hero-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.025em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.011em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.006em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-lg:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: -0.005em
  label-md:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.01em
  label-caps:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.06em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 3rem
  margin-tablet: 2rem
  margin-mobile: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system embodies the apex of industrial computing and human interface craftsmanship: a convergence of calibrated aluminum, specular light transmission, and absolute functional quietude. Designed for an autonomous concierge and executive agent, the interface must convey peerless competence, discretion, and effortless capability.

The visual thesis relies on extreme restraint, fusing high-end tactile minimalism with visionOS-grade spatial glassmorphism. Surfaces reflect material physics—anodized silver planes, specular inner bevels, and optical-grade frosted diffusion. Rather than commanding attention through decorative excess, the interface recedes gracefully, surfacing contextual agent intelligence through razor-sharp hierarchy, micro-interactions, and pristine white space. Every element feels milled from solid billets of metal and optical glass.

## Colors

The palette is engineered around Apple's signature optical clarity. 

- **Canvas & Base Tones:** The viewport uses an ethereal anodized aluminum wash (`#F5F5F7`), shifting to pure milk-glass white (`#FFFFFF`) on elevated planes. Neutral typography leverages calibrated zinc blacks: Primary Text at `#1D1D1F`, Secondary Text at `#86868B`, and Tertiary/Disabled at `#AEAEB2`.
- **Primary Interactive:** Iconic Apple Blue (`#0071E3`) provides unmistakable affordance, accented in subtle spatial contexts with an Indigo tint (`#5856D6`).
- **Semantic Accents:** System statuses rely on crisp, high-purity functional pigments: System Emerald (`#34C759`) for optimal operational readiness, System Amber (`#FF9500`) for deferred decisions, and System Red (`#FF3B30`) reserved strictly for destructive state confirmations and critical halts.
- **Translucent Fill Layers:** Frosted overlays utilize white with calibrated alpha channels (`rgba(255, 255, 255, 0.72)` to `rgba(255, 255, 255, 0.88)`), complemented by whisper borders of `rgba(0, 0, 0, 0.06)` and light-refracting specular highlights of `rgba(255, 255, 255, 0.80)`.

## Typography

The typographic hierarchy channels the clarity and geometric neutrality of modern human interface standards. Plus Jakarta Sans serves as the display engine, set with deliberately tight tracking (`-0.02em` to `-0.035em`) to evoke the machined, display-grade precision of SF Pro Display. Inter governs all analytical, tabular, body, and micro-label hierarchies, providing clinical neutral legibility across high-density operational views.

Generous leading guarantees zero vertical tension, while meticulous optical scaling ensures desktop hierarchies gracefully downshift for compact mobile execution without sacrificing weight or authority. Micro labels and status tags adopt subtle positive tracking with upper case or medium weight styling to maintain legibility at 10px and 11px.

## Layout & Spacing

The system enforces an uncompromising 12-column adaptive fluid grid governed by a disciplined 8pt architectural rhythm, with a supplementary 4pt sub-grid for component-level optical alignment.

- **Breakpoints:**
  - Mobile: `< 640px` (4-column layout, `1.25rem` outer margins, `1rem` column gutters).
  - Tablet: `640px – 1024px` (8-column layout, `2rem` outer margins, `1.25rem` column gutters).
  - Desktop: `> 1024px` (12-column layout, maximum content container capped at `1440px`, centered with `3rem` margins and `1.5rem` gutters).
  
Spatial cadence prioritizes high breathing room, framing agent decisions as elevated artifacts rather than crowded dashboards. Macro components are separated by generous gaps (`space-xl`), allowing the eye to process system recommendations without cognitive friction.

## Elevation & Depth

Visual depth is achieved through an optical fusion of material translucency, dual specular rim illumination, and diffused ambient shadows:

1. **Surface 0 (Substrate):** Unyielding matte aluminum base (`#F5F5F7`), raw, grounding, and non-reflective.
2. **Surface 1 (Machined Plates & Cards):** Pure white (`#FFFFFF`) or frosted milk-glass (`rgba(255, 255, 255, 0.78)`) combined with a 24px background blur (`backdrop-filter: blur(24px) saturate(180%)`). Outlined by a whisper border of `1px solid rgba(0, 0, 0, 0.05)` and a top interior edge highlight of `inset 0 1px 0 0 rgba(255, 255, 255, 0.90)`. Ambient drop shadow: `0 4px 20px -2px rgba(0, 0, 0, 0.03), 0 2px 6px -1px rgba(0, 0, 0, 0.02)`.
3. **Surface 2 (Floating Modals, Inspectors, & Agent Overlays):** Highly diffuse frosted glass (`rgba(255, 255, 255, 0.88)` with `backdrop-filter: blur(40px) saturate(200%)`). Framed by `1px solid rgba(255, 255, 255, 0.60)` on top and `1px solid rgba(0, 0, 0, 0.08)` along edges. Deep spatial diffusion shadow: `0 24px 48px -12px rgba(0, 0, 0, 0.08), 0 8px 16px -4px rgba(0, 0, 0, 0.03)`.

## Shapes

Shapes utilize Apple's continuous curve squircles. The design systematically avoids acute, sharp geometries in favor of organic, friendly, yet mathematically exact contours.

- **Micro Controls & Badges:** Continuous pill contours (`9999px`) provide physical containment for tags, telemetry pills, and segmented toggles.
- **Buttons & Input Targets:** Milled at `0.75rem` (`12px`) to `1rem` (`16px`) radius, matching fingers and cursor targets with soft ergonomics.
- **Containers & Glass Cards:** Milled at `1.25rem` (`20px`) to `1.5rem` (`24px`), establishing a smooth, tablet-like physical presence.
- **Hero Viewports & Main Application Windows:** Rounded at `2rem` (`32px`), giving the digital workspace the softened physical boundary of an Apple Studio Display.

## Components

- **Buttons:**
  - *Primary:* Filled with Apple Blue (`#0071E3`), pure white text, squircle geometry with a subtle top inner reflection (`inset 0 1px 0 0 rgba(255, 255, 255, 0.3)`). Hover: smooth luminance lift.
  - *Secondary / Frosted:* Translucent white fill (`rgba(255, 255, 255, 0.65)`), border `1px solid rgba(0, 0, 0, 0.06)`, text `#1D1D1F`.
  - *Tertiary / Ghost:* Borderless, pure `#1D1D1F` with a soft aluminum background wash (`rgba(0, 0, 0, 0.04)`) on hover.
- **Segmented Controls:**
  - Recessed capsule container in translucent gray (`rgba(118, 118, 128, 0.12)`) housing smooth sliding white tabs (`#FFFFFF`) backed by a micro shadow (`0 2px 4px rgba(0, 0, 0, 0.08)`).
- **Cards & Bento Enclosures:**
  - Machined pure milk-glass panels with subtle `1px` ambient borders (`rgba(0, 0, 0, 0.05)`). Internal content structured using generous `1.5rem` to `2rem` padding, pairing display-grade headers with muted body text.
- **Input Fields & Search Bars:**
  - Recessed, capsule or squircle shapes filled with low-opacity aluminum glass (`rgba(0, 0, 0, 0.03)`). Focused state introduces an outer glow in iconic blue (`0 0 0 3px rgba(0, 113, 227, 0.25)`) with an optical surface whitening (`#FFFFFF`).
- **Pill Badges & Telemetry Indicators:**
  - Micro-pills (`height: 22px`, font size `11px`) featuring a 6px circular breathing status light (e.g., emerald for "Agent Active", amber for "Awaiting Review").
- **Agent Action Strips & Floating Bar:**
  - Suspended, frosted-glass island docked to the bottom viewport. Features rapid voice/text invocation, contextual quick actions, and status feedback enveloped in an ultra-blurred visionOS-style boundary.