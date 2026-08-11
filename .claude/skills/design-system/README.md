# Engineering Design System

A focused color + type system for software engineering web apps —
dashboards, IDEs, observability, CI/CD, repos, and developer docs.

## Palette

### Primary — structural
| Token | Hex | Use |
|---|---|---|
| `--c-indigo` | `#4f46e5` | Primary actions, links, focus rings, brand |
| `--c-slate`  | `#0f172a` | Ink, headers, dark surfaces |
| `--c-mist`   | `#e2e8f0` | Surfaces, dividers, code backgrounds |

### Secondary — semantic
| Token | Hex | Use |
|---|---|---|
| `--c-emerald` | `#10b981` | Success · passing · merge |
| `--c-amber`   | `#f59e0b` | Warning · pending · in-review |
| `--c-coral`   | `#ef4444` | Error · failing · breaking |
| `--c-violet`  | `#8b5cf6` | Accent · highlights · featured |

### Neutrals
Slate scale at `slate-50 / 100 / 300 / 400 / 600 / 900` for backgrounds, borders,
and the three-tier text hierarchy (primary / secondary / muted).

## Type
- **Sans:** Aeonik (commercial) → falls back to DM Sans
- **Mono:** JetBrains Mono — for code, IDs, env vars, version hashes
- 9-step type scale, 5 weights, tight tracking on display sizes

## Rules
- No drop shadows
- No strong gradients
- No decorative outlines
- White text fails contrast on Amber — use slate ink instead
- Hierarchy comes from weight + color, not effects

## Usage
```html
<link rel="stylesheet" href="colors_and_type.css">
```

All tokens exposed as CSS custom properties on `:root`.
