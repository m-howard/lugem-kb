---
name: design-system
description: Use this skill to generate well-branded interfaces and assets using this design system. Contains essential design guidelines, color tokens, typography rules, and component patterns for prototyping or production.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), import `colors_and_type.css` and reference the preview cards in `preview/` as a component reference. If working on production code, copy the CSS tokens and follow the visual foundations documented in README.md.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts or production code, depending on the need.

## Quick Reference

**Primary colors:** `#4f46e5` (indigo) · `#0f172a` (slate) · `#e2e8f0` (mist)
**Secondary / semantic:** `#10b981` (emerald — success) · `#f59e0b` (amber — warning) · `#ef4444` (coral — error) · `#8b5cf6` (violet — accent)
**Neutrals:** slate scale `#f8fafc` · `#f1f5f9` · `#cbd5e1` · `#94a3b8` · `#475569` · `#0f172a`
**Font:** `'Aeonik', 'DM Sans', sans-serif` · Mono: `'JetBrains Mono'` for code/IDs
**Weights:** 300 / 400 / 500 / 600 / 700
**Radius:** 2px default · 4px cards/inputs · 9999px pills
**Prohibited:** drop-shadow · strong gradients · decorative outlines · white-on-amber text (fails contrast)
