# Kept — landing page assets (`index-cinematic.html`)

Drop the generated images here. Every reference degrades gracefully: if a file is
missing, the page falls back to a procedural CSS / WebGL equivalent and never looks broken.

## Files the cinematic page looks for

| File | Size / format | Used for | Fallback if absent |
|------|---------------|----------|--------------------|
| `fallback-bg.jpg` | ~1920×1080 JPG (desktop) | Static background shown **only** when WebGL is unavailable or fails, or on very weak devices. Should read as a dark ledger-horizon still (composed teal grid + the DONE→BLOCKED beat, so the punchline survives with zero motion). | A CSS radial-gradient (ink + teal glow) painted by `#bg-fallback`. The page still renders correctly. |
| `fallback-bg-mobile.jpg` | ~1080×1920 JPG (portrait) | Same as above, on screens ≤ 820px wide. | Same CSS gradient fallback. |
| `og.png` | **1200×630** PNG, sRGB | Social / OpenGraph share preview. | The page currently points `og:image` at the existing `/og.png` (repo root of `docs/`). Once you generate `assets/og.png`, update the `<meta property="og:image">` + `twitter:image` URLs in `index-cinematic.html` to `https://kept-iota.vercel.app/assets/og.png`. |
| `favicon.png` | 180×180 (or 512×512) PNG | `apple-touch-icon`; higher-res tab icon. | An inline SVG favicon (teal ledger-check on ink) is always embedded in the `<head>`, so the tab icon is never blank. |

## Notes

- **Honesty:** if you render the Evidence Packet into `og.png` or `fallback-bg.jpg`,
  keep the source tags honest — `GITHUB ACTIONS · live`, and `STATUSPAGE · sim` /
  `LAUNCHDARKLY · sim`. Never imply a simulated source is a live integration, and never
  present the recreation as a real screenshot.
- **Palette to match:** ink `#17150F`, surface `#221F18`, text `#F4F1EA`, teal `#4FB89E`,
  teal-deep `#0F6E5C`, red (reality-disagrees only) `#D9776C` / `#B4463C`.
- **Type:** Fraunces (display), IBM Plex Sans (body), IBM Plex Mono (data/eyebrows).
- After dropping `og.png` / `favicon.png`, remember to flip the two `<meta>` image URLs
  (og + twitter) and — if you want the PNG icon to win — the favicon `<link>` in the head.
