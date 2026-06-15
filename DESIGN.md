---
version: alpha
name: LibreFlowDesignSystem
colors:
  bg:
    main: "#0d1117"       # HSL(220, 25%, 8%) - Very dark slate for high contrast background
    surface: "#161b22"    # HSL(220, 20%, 11%) - Card/panel container surface
    surface-glass: "rgba(22, 27, 34, 0.7)"
  border:
    default: "#5a626c"    # HSL(215, 12%, 40%) - High contrast border (Meets WCAG 3:1 ratio against #0d1117)
    glass: "rgba(90, 98, 108, 0.5)"
  text:
    primary: "#f0f6fc"    # HSL(210, 100%, 96%) - Premium white (High contrast ratio > 15:1)
    secondary: "#c9d1d9"  # HSL(210, 15%, 82%) - Readability text (High contrast ratio > 10:1)
    muted: "#8b949e"      # HSL(210, 10%, 58%) - Secondary details (Contrast ratio > 4.8:1 - Exceeds WCAG 4.5:1)
  accent:
    indigo: "#5c6bc0"     # HSL(231, 48%, 56%) - Indigo button background
    indigo-text: "#637bfe" # HSL(231, 75%, 65%) - Indigo accent text (Meets WCAG 4.5:1 contrast)
    emerald: "#34d399"    # HSL(158, 64%, 52%) - Log nodes and success execution states
    amber: "#fbbf24"      # HSL(43, 96%, 56%) - Set nodes and warning states
    crimson: "#f87171"    # HSL(0, 93%, 68%) - IF nodes false branch and failure states (Brightened for dark background)
    cyan: "#22d3ee"       # HSL(189, 94%, 54%) - HTTP request nodes and active execution states
typography:
  font-family: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  size:
    xs: "12px"            # Increased from 11px to meet minimum legibility standards
    sm: "13px"
    md: "14px"
    lg: "16px"
    xl: "26px"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
---

# LibreFlow Design Specification

This document defines the visual standards, accessibility rules, and design tokens for **LibreFlow**. It serves as the single source of truth for design consistency.

## Design Principles

1.  **Aesthetic Legibility:** Interfaces must be visually premium (glassmorphic dark mode, smooth transitions, soft indicator glows) but never at the expense of readability.
2.  **Accessible Contrast (WCAG AA):** Text and interactive elements must meet WCAG AA requirements:
    *   Primary text on slate background has a contrast ratio of >15:1.
    *   Muted/helper text (`text.muted`) must not drop below a 4.5:1 contrast ratio against the canvas background. We use `#8b949e` (or lighter) for muted text to maintain a 4.8:1 ratio.
    *   Status states (success/failure) must use high-luminance colors (`#34d399` for green, `#f87171` for red) to remain legible on dark layouts.
3.  **Minimum Font Size:** The minimum font size for any UI element (including node subtitles, date fields, table headers, and status badges) is **12px** to ensure reading comfort.

## Accessibility (WCAG) Auditing Rules

*   **Dipped Opacity:** Skipped nodes must not fade below `opacity: 0.65` (previously `0.5`) so their text labels remain readable by users.
*   **Active Outlines:** All focused buttons, select inputs, and textboxes must display a distinct focus glow (`var(--color-primary)`) to support keyboard navigation.
*   **Color + Icon Indication:** Never rely *only* on color to indicate execution status. Use status labels (e.g., "Éxito" or "Fallo") or distinct icons alongside color glows.
