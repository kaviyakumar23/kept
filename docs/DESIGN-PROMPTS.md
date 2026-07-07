# Kept — Design Prompt Kit

Copy-paste prompts for generating every visual surface in Kept, tuned for AI design tools
(v0.dev, Lovable, Claude, Figma AI) and image tools (Ideogram, Midjourney, DALL·E). **Always
prepend §0 (the brand system) to any surface prompt** so output stays consistent.

Surfaces marked **[HTML]** are free-form web pages. Surfaces marked **[BLOCK KIT]** render
inside Slack and are constrained to Slack's component set (no custom CSS) — those prompts ask
for Block Kit JSON. Surfaces marked **[IMAGE]** are for image-generation tools.

> ⚠️ **These are specs, not shipped assets.** They produce strong first drafts, not launch-ready
> files. Treat them as an ~80% start and budget a human art-direction + QA pass — see
> **[Before you ship](#before-you-ship--prompt--production)** at the bottom, which is
> non-negotiable for a Marketplace submission.

---

## §0 — Brand system (prepend to every prompt)

```
BRAND: "Kept" — a Slack-native, human-verified obligation ledger for shared customer channels.
It captures every promise made to a customer, tracks it through a guarded lifecycle, verifies
real-world completion from evidence it gathers, and closes the loop only after a human signs.
POSITIONING: it earns trust by verifying reality, not by shouting. Calm, credible, understated,
anti-hype. The opposite of a neon SaaS dashboard. Think "a well-kept ledger in a quiet study."

COLOR (light):
  --paper      #F4F1EA   page background (warm paper)
  --surface    #FBFAF6   cards / raised surfaces
  --ink        #211E1A   primary text (warm near-black)
  --muted      #6B655C   secondary text / captions
  --teal       #0F6E5C   PRIMARY — CTAs, links, "kept", brand accents
  --teal-dark  #0A5344   hover/pressed
  --teal-wash  #E3EEEA   primary tint backgrounds / pills
  --amber      #C6803B   "at-risk" accent
  --red        #B4463C   "blocked / reality disagrees" accent (use sparingly, high impact)
  --rule       #E0DACE   hairline borders / dividers (paper-toned, never pure gray)
COLOR (dark, via prefers-color-scheme AND a [data-theme] override):
  --paper #17150F  --surface #221F18  --ink #F4F1EA  --muted #A9A296
  --teal #4FB89E   --teal-dark #6FCBB3  --teal-wash #17352E  --rule #35301F
  (keep amber/red, nudge lighter for contrast)

TYPE:
  Display: "Fraunces" (serif, optical sizing, weights 400/500/600; slightly tight tracking on
           large sizes). Used for all headings and the big hero line.
  Body:    "IBM Plex Sans" (400/500/600).
  Mono:    "IBM Plex Mono" (400/500) — eyebrow labels, data, dates, status tags; UPPERCASE with
           0.08em letter-spacing for eyebrows.
  SCALE (desktop → mobile):
    Hero H1   Fraunces 500  64px/1.05  → 40px      Section H2  Fraunces 500 38px/1.1 → 28px
    H3        Fraunces 500  24px       → 20px       Body-L      Plex Sans 400 19px/1.6 → 17px
    Body      Plex Sans 400 16px/1.6                Caption     14px/1.5 --muted
    Eyebrow   Plex Mono 12px UPPERCASE 0.08em --teal
  Text measure max ~65ch. Numbers/dates/refs always in Plex Mono.

LAYOUT & COMPONENTS:
  Spacing scale 4·8·12·16·24·32·48·64·96·128. Section padding 112px desktop / 64px mobile.
  Max content width 1120px; a narrower 720px column for prose.
  Cards: --surface bg, 1px --rule border, radius 14px, padding 24–28px, shadow 0 1px 2px
         rgba(0,0,0,.04) (restrained — no heavy shadows, no glows).
  Buttons: primary = --teal bg / --paper text / radius 8px / 14×24px / Plex Sans 600 16px /
           hover → --teal-dark. secondary = transparent / --teal text / 1px --teal border.
           link = --teal, underline on hover. Focus-visible: 2px --teal outline, 2px offset.
  Status pills: radius-full, Plex Mono 12px, tinted bg + darker text —
           Kept=teal-wash/teal · In-progress=neutral(#EFEBE1/#6B655C) · Verifying=slate(#E7E9EE/#48546B)
           · At-risk=amber tint(#F3E4D3/#8A5A26) · Blocked=red tint(#F1DAD6/#8F2F27).
  Hairline rules (1px --rule) instead of boxes wherever possible. Generous whitespace.

MOTION: 150–200ms ease-out; entrances = 8px slide-up + fade. No bounce, no parallax overload.
        Always honor prefers-reduced-motion (disable transforms).

ACCESSIBILITY: WCAG AA contrast; semantic landmarks; visible focus; alt text on all imagery;
               don't encode meaning in color alone (pair every status color with a label/icon).

VOICE (sample lines you may reuse):
  • "We'll ship the SSO fix by Friday." — Kept catches the promise.
  • Done doesn't mean shipped. Kept checks before you tell the customer.
  • The agent assembles the proof. You sign.
  • Honesty note: Slack and GitHub Actions are live; other proof sources are simulated via MCP.

BRAND COMPLIANCE (non-negotiable — the prompts don't enforce these; you must):
  • "Add to Slack" must be Slack's OFFICIAL button asset — never a generated button.
  • App icon = a real 512×512 that conforms to Slack's brand/logo guidelines.
  • Marketing copy must never imply the simulated proof sources (Linear/Jira/LaunchDarkly/
    Statuspage) are live integrations — that honesty is a submission requirement, not a nicety.
```

---

## ANTI-GENERIC CRAFT LAYER (prepend after §0, before any surface prompt)

Each rule names the AI-default failure it exists to defeat. These lift *every* surface, not just the landing page — treat them as hard constraints, not preferences.

1. **No component-library reflex.** *(Failure: the tool reaches for shadcn/MUI Card, Badge, pill, and lucide/heroicons — the median look.)* Forbid all component-library atoms and icon libraries; forbid emoji-as-UI. Build every element from semantic HTML + hand-written CSS. Structural surfaces use `border-radius ≤ 4px` (the only exception: §0 status pills, radius-full, hand-built to the §0 spec). If the output contains a rounded, drop-shadowed card grid, it has failed.
2. **No symmetric center-stacked hero.** *(Failure: everything resolves to a centered column.)* The first screen is an asymmetric editorial split on a real 12-column grid; copy and product are never centered-and-stacked. Symmetry is permitted only in a masthead nameplate.
3. **Kill the hero→3-cards→CTA skeleton.** *(Failure: the template shape.)* Sections are prose, a captioned exhibit, a lifecycle with hanging numerals, a running index — an *argument*, not a template. Never a 3-up feature-card row.
4. **Rhythm, not uniform spacing.** *(Failure: repeated 24/96/112px blocks everywhere.)* Use a loud/quiet vertical meter and real print margins (96–160px). Separate sections with full-bleed 1px hairline rules, never boxes.
5. **Type must show craft.** *(Failure: untuned system-serif with one weight.)* Fraunces with `font-optical-sizing` + explicit `opsz` + negative display tracking + `text-wrap:balance`; **oldstyle** figures (`onum`,`pnum`) in prose vs **tabular lining** (`tnum`,`lnum`) in every data column; real Fraunces *italic* for emphasis (never faux-slant, never bold body); a true sunk drop cap; tracked-uppercase mono eyebrows. Untuned defaults = fail.
6. **No stock ornament.** *(Failure: a gradient/blob "for visual interest.")* Zero gradients, mesh, blobs, glows, glassmorphism. At most **one** shadow on the page (neutral or teal-tinted, low). Ornament = hairline rules + faint ledger-rules only.
7. **One rationed signature, red as the punchline.** *(Failure: an accent colour smeared across buttons, hovers, and icons.)* Red `#B4463C` is the entire emotional budget — it means "reality disagrees" and appears only on the evidentiary marks (the hero correction, the OFF signal, the Blocked verdict). Never a red button/link/hover/focus ring/decoration. Teal carries all affordance; amber appears at most once.
8. **Real product, real data, honest framing.** *(Failure: a fake decorative dashboard, or a mock claimed as a real screenshot.)* Render the actual artifact (the Evidence Packet), captioned as a *faithful recreation* — never a fabricated dashboard, never claimed as a raw screenshot. Real copy and real refs verbatim, no lorem. Never imply a simulated source (Linear/Jira/LaunchDarkly/Statuspage) is live — only Slack and GitHub Actions are (invariant #7).
9. **Motion like ink drying.** *(Failure: blanket fade-ups, parallax, count-ups, autoplay loops.)* One choreographed beat, run once on scroll-in; 150–200ms ease-out entrances. `prefers-reduced-motion` must preserve the punchline statically.
10. **Self-contained + accessible.** One HTML file, inline CSS, fonts self-hosted/base64 or a tuned fallback stack — **never** a CDN `<link>` (CSP blocks external hosts). Body never scrolls horizontally; wide elements scroll inside their own `overflow-x:auto`. WCAG AA both themes; visible teal focus; meaning never in colour alone (every status pairs a mark with a word). Light/dark via `prefers-color-scheme` **and** a `[data-theme]` override that wins both ways.

---

## Why AI landing pages look average — and what this prompt forces instead

AI design tools produce average pages because, at every point of ambiguity, they resolve toward the statistical median of their training data. Each such resolution is a decision *not* to art-direct:

- **Default atoms.** Left unspecified, the tool reaches for the component library it knows best — shadcn/MUI cards, pill buttons, lucide icons — so the page inherits the exact look of ten thousand other SaaS sites.
- **The template skeleton.** It emits the reflexive shape: a symmetric center-stacked hero, then a 3-up feature-card row, then a CTA. That shape *is* the tell.
- **Timid, uniform spacing.** Everything gets the same 24/96px padding, so the page has no rhythm, no hierarchy, no held breaths — it reads flat.
- **Safe, untuned type.** A system-ish serif at one weight, no optical sizing, no figure styles, no real italics — the invisible craft signals that separate a studio from a first-timer are exactly the first things dropped.
- **Stock ornament.** A gradient, a blob, or a glow gets added "for visual interest," because decoration is easier than composition.
- **No signature and thin content.** No single ownable device, lorem or vague placeholder copy, and — worst for a trust product — a *fake* decorative dashboard instead of the real artifact, because rendering the real thing is harder.

This prompt defeats each failure with an explicit counter-rule stated as a **rejection criterion**, not a preference: it forbids the component library by name, mandates an asymmetric 12-column grid with a mono margin apparatus, replaces the card skeleton with a paginated editorial argument, imposes a loud/quiet spacing meter, pastes the exact Fraunces optical-sizing and oldstyle-vs-tabular figure settings, bans every gradient and caps the page at one shadow, rations red to three marks so "reality disagrees" carries maximum charge, and renders the real Evidence Packet — honestly captioned as a recreation — as the load-bearing hero. The final self-audit makes the model check its own output against the same bar a studio would.

## 1 · Marketing landing page **[HTML]** — flagship (v2, art-directed)

> **PREPEND, in order:** (1) §0 Brand system, (2) the **ANTI-GENERIC CRAFT LAYER**. Both are load-bearing; this prompt assumes their tokens, the red budget, and the component ban are already in force. This prompt is the drop-in replacement for the old surface #1.

````text
Build ONE production-grade, self-contained marketing landing page for Kept as a single HTML
file with inline <style> and a small inline <script>. NO external assets, NO CDN links, NO
build step — our CSP blocks every external host. This is not a "generate a nice SaaS page"
task; it is a directed art-direction brief. Follow it literally. A real design studio's work
is the bar; a component-library default is a rejection.

════════════════════════════════════════════════════════════════════════════
READ FIRST — YOU HAVE FAILED THIS BRIEF IF ANY OF THESE APPEAR
════════════════════════════════════════════════════════════════════════════
• A rounded, drop-shadowed "card grid" or a 3-up feature-card row, anywhere.
• A symmetric, center-stacked hero.
• Any shadcn/MUI/Chakra Card/Badge/Button, any icon library (lucide/heroicons/feather),
  or emoji used as UI chrome.
• text-decoration:line-through used for the hero "correction" (it must be a hand-drawn SVG stroke).
• The Evidence Packet rendered as a generic dashboard/chart mock, OR wrapped in fake Slack chrome
  (workspace rail, channel header) — that reads uncanny. It is a captioned EXHIBIT, not a screenshot.
• Red (#B4463C) used more than THREE times, or on any button/link/hover/focus ring.
• A gradient, mesh, blob, glow, or glassmorphism. More than ONE shadow on the entire page.
• Fraunces rendered untuned (no optical sizing, no negative tracking) or emphasis set with bold body text.
• Any lorem/placeholder, or the real refs (PROJ-118, PR #244, run #1183, sso_v2, 2026-07-02) swapped out.
• The page body scrolling horizontally on mobile.
Do a self-audit against the checklist at the very bottom before returning. Report which items you satisfied.

════════════════════════════════════════════════════════════════════════════
THE ONE JOB OF THE FIRST SCREEN
════════════════════════════════════════════════════════════════════════════
Show, live, the moment Kept overrules a closed ticket. Every upstream signal says Done; one
signal — the feature flag, still OFF in production — says the customer can't actually use it.
The hero is that catch, animated once. Everything below is quiet ledger scaffolding around it.

════════════════════════════════════════════════════════════════════════════
GRID & SPATIAL SYSTEM (this is what separates it from a template — build it exactly)
════════════════════════════════════════════════════════════════════════════
• CSS Grid: `display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); column-gap:24px;`
  Max content width 1240px. Outer page margins (the "print margins"): 96px desktop, 32px mobile.
  These are print margins, not app padding — do not shrink them to 24px.
• ASYMMETRY IS MANDATORY. Body prose lives in `grid-column: 1 / 8`, hard-capped at `max-width:66ch`,
  and NEVER spans full width. A persistent mono "margin apparatus" lives in `grid-column: 9 / 13`
  and holds ONLY Plex-Mono marginalia (footnotes, dates, source tags, running folio) — never body
  copy, never a bordered box. A single 1px --rule vertical hairline runs down the col-8 gutter.
  Do NOT fall back to a centered max-width:720px prose column — that is the template failure.
• LEFT LEDGER SPINE: a 1px --rule vertical line at x=96px running the full page height, with
  Plex-Mono section indices (01 02 03 04 05) hung on it like ledger line numbers, aligned to the
  top of each section. It anchors the whole page to a ruled sheet.
• VERTICAL RHYTHM is a LOUD/QUIET meter, not uniform blocks. Section padding-top tokens, in order:
  hero 128 · the-miss 112 · lifecycle 128 · two-wows 112 · by-the-numbers 72 (a held breath) ·
  honesty 96 · engineering 72 · cta 160. No two adjacent sections share the same value.
• Sections are separated by FULL-BLEED 1px --rule hairlines that run edge to edge, each preceded
  by a Plex-Mono folio line (e.g. "§ II · THE MISS · fol. 02"). Never separate sections with boxes.
• 8px sub-grid; prose leading locked to a 28px baseline (line-height:1.6 on 19px body ≈ 30px — set
  body to 18px/28px so it sits on the baseline). Mono data aligns to a 4px baseline so figures lock
  into columns like an accounts sheet.

════════════════════════════════════════════════════════════════════════════
THE SIGNATURE DEVICE — ONE red gesture at two scales (this is the whole brand)
════════════════════════════════════════════════════════════════════════════
Red = "reality disagrees." It appears EXACTLY THREE TIMES and is the page's only emotional colour:
  (1) THE HERO CORRECTION. In the H1 "Done doesn't mean shipped.", the word "Done" is struck by a
      hand-weight red proofreader's mark. Build it as inline SVG, NOT text-decoration: wrap "Done"
      in a positioned <span>; overlay an <svg> with a single <path>, stroke #B4463C, stroke-width
      2.5, stroke-linecap:round, drawn slightly above vertical-centre, tilted ~1.5° downward, and
      running ~4% past the word on each side so it reads hand-drawn. A small red caret ‸ sits just
      beneath it. In the right margin apparatus, a red Fraunces ITALIC annotation hangs off the
      headline baseline: "not until the evidence agrees." Position it so a diagonal reading path
      runs from the struck "Done" up to the correction.
  (2) THE OFF ROW inside Exhibit A: "Feature flag — sso_v2 OFF in production" — red ✗, red text.
  (3) THE VERDICT: a single "Blocked" status pill (§0 spec: radius-full, Plex-Mono 12px,
      bg #F1DAD6, text #8F2F27, a ⛔/✗ + the word "Blocked") plus the line "not verifiably available".
The hero correction stroke and the card's verdict flip fire on the SAME frame — reality edits the
sentence and stamps the card at once. Nowhere else is red permitted. Teal carries all affordance
(CTAs, links, the four passing checks as teal ✓ TEXT — never green, never icons). Amber #C6803B
appears at most once (the "softening" drift row). The "stalled" drift row is --muted, NOT red.

════════════════════════════════════════════════════════════════════════════
SECTION-BY-SECTION
════════════════════════════════════════════════════════════════════════════

[MASTHEAD / NAV]  Editorial nameplate, not a generic nav bar.
  • 1px --rule across the very top. Beneath it a metadata line, Plex-Mono 12px, --muted, tracked
    0.14em: left "VOL. I · THE OBLIGATION LEDGER", right "SHARED CUSTOMER CHANNELS · MMXXVI".
  • Then a slim top bar: LEFT "Kept" wordmark in Fraunces 600 22px (a 6px teal square sits before
    the K, aligned to the ledger spine). RIGHT: Plex-Mono lowercase links "the miss · how it works ·
    what's real · trust", then the OFFICIAL "Add to Slack" button (see BRAND COMPLIANCE).
  • Sticky: paper/90 with backdrop-blur; a 1px --rule bottom border FADES IN only after scroll.

[HERO]  Asymmetric editorial split, 128px below the masthead. THE PRODUCT IS THE HERO.
  LEFT (grid-column 1 / 7, text measure 64ch):
    • Eyebrow, Plex-Mono 12px, tracked 0.14em, --teal, with a 6px teal square before it:
      "SLACK AGENT · OBLIGATION LEDGER · HUMAN-VERIFIED"
    • H1, Fraunces 500, clamp(44px,6.5vw,76px), line-height 1.05, letter-spacing -0.02em,
      text-wrap:balance: "Done doesn't mean shipped." — with the red Correction on "Done" (above).
    • STANDFIRST with a real 3-line sunk drop cap on "Every" (Fraunces 500, float:left, ~84px,
      line-height:0.8, its baseline resting on the 3rd text line — it must SINK, not float):
      "Every day your team makes promises in shared customer channels — 'we'll ship the SSO fix by
      Friday,' 'the export bug is patched,' 'that's live now.' Kept writes each one into a
      human-verified ledger the moment it's said, then refuses to call it done until the evidence
      agrees." (IBM Plex Sans 18px/28px, --ink, oldstyle figures.)
    • CTA row: the OFFICIAL Add to Slack button (primary) + a text link in --teal, underline-on-hover:
      "Read the 2-minute overview →". No second boxed button — a link, per editorial restraint.
  RIGHT MARGIN (grid-column 9 / 13, hairline down the col-8 gutter): the red Fraunces-italic
    correction annotation "not until the evidence agrees." hanging off the headline, then two
    Plex-Mono footnotes (11px, --muted), each anchored at the block-start of the paragraph it
    annotates (do NOT stack both at the top): "¹ Captured as a derived fact — never the message body.
    Zero-copy by construction." "² Two human gates: one to confirm, one to sign. Everything between
    is the agent."

  THE HERO EXHIBIT — Evidence Packet card (spans grid-column 1 / 13 BELOW the copy on desktop, or
  place it 6/13 beside a shortened copy block — pick whichever holds the 66ch measure; it must feel
  tipped onto the page, not boxed in a column):
    • It is EXHIBIT A: a faithful, brand-styled RECREATION of Kept's in-Slack Gate-2 card — NOT a raw
      screenshot (Slack Block Kit can't render colour/motion; claiming a screenshot would be dishonest,
      and honesty is the product). Render it as a facsimile artifact:
        – surface #FBFAF6 (the SECOND paper tone — must differ from the #F4F1EA page; do NOT use white)
        – one 1px --rule frame, border-radius:0
        – transform: rotate(-0.6deg) so it reads pasted-in
        – exactly ONE shadow on the whole page: 0 20px 40px -24px rgba(0,0,0,.22) (neutral, low).
          Do not use a Tailwind/utility shadow.
        – four printer's CROP MARKS at the corners (pseudo-elements or tiny SVG L-shapes in --rule)
        – faint horizontal "ledger rules" behind the evidence rows at ~6% ink (repeating-linear-gradient
          locked to the 28px row rhythm) — the accounting-paper feel.
    • CARD CONTENTS (reconciled to the real engine — every signal Kept actually reconciles; human-
      readable labels are fine on an exhibit, but keep the data honest and keep GitHub Actions marked
      as the live source). Order the rows for narrative: green corroboration first, the disqualifier last.
        Header (Fraunces 500, ~20px):  Kept · Proof-of-Done evidence packet
        Subject line (Plex Sans):      Acme — Ship the SSO login fix
        Context (Plex Mono, --muted):  The agent gathered this proof. You sign the verdict.
        ── Evidence ──  (each row: teal ✓ / red ✗ mark · label · a Plex-Mono source tag on the right,
                         all figures tabular lining)
          ✓  Ticket — marked Done            JIRA · PROJ-118
          ✓  Code — PR #244 merged           GITHUB
          ✓  CI — workflow run #1183 success GITHUB ACTIONS · live
          ✓  Status — SSO component operational   STATUSPAGE
          ✓  Deploy — shipped to production  2026-07-02
          ✗  Feature flag — sso_v2 OFF in production   LAUNCHDARKLY      ← the ONLY red row
        Verdict: the red "Blocked" pill + "not verifiably available."
        Rationale (Plex Mono, --muted): "Ticket-Done alone is never enough — Kept reconciles flag /
          CI / status / merge / deploy. The flag is OFF, so customers can't reach it yet."
        Actions: primary "Verify it's available" (teal button, animates to disabled) · "Not yet" (secondary).
        CAPTION beneath the card (Plex Mono, --muted, 11px): "EXHIBIT A · a faithful recreation of the
          in-Slack Gate-2 card. Assembled by the agent via MCP; signed by no one, because it isn't true yet."

[§ I / II — THE MISS]  Prose + pull-quote. Do NOT build a second red compare card (that would break the
  red budget and duplicate the exhibit). Reference the exhibit above.
    • Pull-quote, genuine Fraunces ITALIC 30px, hanging opening quote pulled into the left margin:
      "A closed ticket is a claim. Kept treats it as a claim until the evidence agrees."
    • Prose (cols 1/8, ≤66ch): "Ticket-trackers track tickets. The ticket for Acme's SSO fix said Done
      on Thursday. Every upstream signal agreed — issue closed, PR merged, CI green, status operational,
      deploy shipped. Kept gathered them anyway, and found the one that mattered: the feature flag was
      still OFF in production. Done, but not shipped."

[§ III–V — THE LIFECYCLE]  Hanging Fraunces numerals I–V as chapter openers.
    • Set each numeral in Fraunces ~120px and OUTDENT it into the left white margin (negative
      margin-left or absolute), so the figure hangs past column 1 like a book chapter number. Not
      centred, not inline, NOT an <ol>. This is the fastest anti-template signal — do not skip it.
    • I · Heard — a promise is detected in the channel the moment it's said.
      II · Confirmed — a human confirms it's real.  [Gate 1 — a human touch]
      III · Gathered — the agent collects proof via MCP: ticket, PR, CI, deploy, flag, status page.
      IV · Weighed — the Evidence Packet is assembled and a verdict is computed. The LLM proposes; code decides.
      V · Signed — a human signs the verdict; closure posts back in the original thread.  [Gate 2 — a human touch]
    • Tint the "[Gate 1]" / "[Gate 2]" tags teal — the only two human touches; everything between is the agent.

[TWO WOWS — as ledger rows, NOT cards]
  A) PROMISE-DRIFT INDEX — a running ledger ticker, Plex-Mono, dated, hairline-ruled rows:
       ●(teal)  firm       — "SSO live for Northwind"  · owner Amelia · re-affirmed today
       〰️(amber) softening  — "CSV export fix"  · "early next week" → "soon" · last firm 6d ago
       ●(muted) stalled     — "SAML metadata endpoint"  · silent 11d          [muted, NOT red]
     Gloss (Plex Sans): "Certainty decays. 'Next Tuesday' becomes 'soon' becomes silence. Kept
     quantifies the slide and flags it before the channel goes quiet."
  B) A TRUST PAGE PER CUSTOMER — a small, honest, AUDIENCE-SAFE mock (no internal refs — this surface
     is customer-facing): a header "Acme — commitments, kept" and four count tiles Kept 12 · In progress
     3 · Verifying 1 · At risk 1 (big Fraunces numeral + Plex-Mono label, tabular figures), then two
     rows: "SSO login fix — Kept on 2026-07-02" (teal) · "CSV export — In progress". Gloss: "A live,
     human-verified status page you'd be proud to hand a customer."

[BY THE NUMBERS]  A tight strip, tabular lining figures, hairline-separated:
     0 false closures · 100% duplicate suppression · 2 human gates, always · 0 raw messages stored.

[HONESTY COLOPHON]  Full-width band on --teal-wash, set as calm printer's small print. Copy VERBATIM:
     "A note on what is real. Slack is the live surface. GitHub Actions is a genuine live proof source.
     Linear, Jira, LaunchDarkly and Statuspage are simulated via an in-process MCP server with real API
     skeletons, and labeled as such throughout. The honesty is the point."

[ENGINEERING]  Three compact Plex-Mono badges (hand-built, no card component):
     "Zero-copy — we persist derived facts, never your messages" · "Tenant-isolated by construction" ·
     "Two human gates, always".

[CTA FOOTER]  Big Fraunces line (500, clamp(36px,5vw,60px)): "Stop closing tickets you haven't verified."
     + the OFFICIAL Add to Slack button. Footer folio (Plex Mono, --muted): Privacy · Support · Security ·
     the demo · Maintained by Kept.

════════════════════════════════════════════════════════════════════════════
TYPE CRAFT (paste these settings — they are load-bearing; omitting them is a rejection)
════════════════════════════════════════════════════════════════════════════
• Fraunces display (nameplate, H1, H2, numerals, pull-quotes): font-optical-sizing:auto;
  font-variation-settings:"opsz" 144; letter-spacing:-0.02em (H1 -0.03em). Real Fraunces ITALIC for
  the correction note and pull-quotes (NOT a slanted roman). Exactly THREE Fraunces weights: 400
  (honesty/colophon prose, to feel spoken), 500 (headings/numerals), 600 (wordmark only). Never
  font-weight:700 on body — emphasis is italic Fraunces or --teal, never bold.
• Figures: running prose + folios use OLDSTYLE proportional figures
  `font-feature-settings:"onum" 1,"pnum" 1;`. The exhibit rows, the drift index, the trust-page
  tiles, and the by-the-numbers strip use TABULAR LINING figures
  `font-feature-settings:"tnum" 1,"lnum" 1;` so columns of data align to the pixel. This split is
  invisible to laymen and unmistakable to designers — do both.
• Body: IBM Plex Sans 18px/28px, `font-feature-settings:"liga" 1,"kern" 1;`. Superscript footnote
  markers use `"sups" 1`. Every number, date, ref, tag = IBM Plex Mono.
• Eyebrows/folios: Plex Mono, UPPERCASE, tracked 0.08em (folios looser at 0.14em).
• text-wrap:balance on H1 and every H2; text-wrap:pretty on prose. Discourage widows/orphans.

════════════════════════════════════════════════════════════════════════════
COLOUR — from §0, disciplined
════════════════════════════════════════════════════════════════════════════
Page --paper #F4F1EA; the exhibit alone on --surface #FBFAF6. --ink #211E1A text; --muted #6B655C for
the ENTIRE margin apparatus/folios (deliberately quieter than body). --teal #0F6E5C ONLY structural +
semantic: nameplate rules, wordmark, links, the four passing ✓ checks (teal, not green), the Signed/
Kept marks, buttons. Ornament = --rule #E0DACE hairlines + 6%-ink ledger rules behind exhibit rows.
NO gradients/glows/coloured shadows. Focus-visible: 2px --teal outline, 2px offset (never red).
DARK MODE via `@media (prefers-color-scheme:dark)` AND a `:root[data-theme=...]` override that wins
both ways: --paper #17150F, --surface #221F18, --ink #F4F1EA, --muted #A9A296, --teal #4FB89E,
--rule #35301F; keep the SAME 3-mark red budget (nudge red slightly lighter for AA on dark). The
exhibit's second-paper-tone contrast must survive the flip.

════════════════════════════════════════════════════════════════════════════
MOTION — ink drying, not a SaaS reveal. One choreographed beat, run ONCE on scroll-in.
════════════════════════════════════════════════════════════════════════════
On load, hairline rules DRAW: scaleX 0→1 from transform-origin:left, 500ms ease-out, staggered
top-to-bottom (the nameplate double-rule draws first). Section entrances = 8px slide-up + fade,
150–200ms ease-out.
THE HERO TIMELINE (single IntersectionObserver on the exhibit, runs once, no loop, no autoplay carousel),
~2.2s: 0.0 card fades up → 0.3–1.1 the five green rows check in staggered 120ms, each teal ✓ scaling
0.9→1 with the tabular label ticking in → 1.2 a subtle reviewer cursor eases toward "Verify it's
available" → 1.5 the flag-OFF row slides in red LAST with a 2px overshoot-settle → 1.6 the verdict
resolves to the red "Blocked" pill with a restrained ≤2° settle (no bounce) AND, on the same frame,
the hero headline's red Correction stroke draws across "Done" over 260ms; the caret + red margin note
fade in 120ms after → 1.8 the primary button desaturates to disabled (filter:grayscale(1); opacity:.5;
pointer-events:none) and a Plex-Mono caption "Verify is blocked while evidence is insufficient" fades
in beneath it. A small Plex-Mono "Replay" control (teal, underline-on-hover) re-runs it.
The one ambient element: the drift "softening" 〰️ glyph breathes opacity 0.55↔1 over 4s. No parallax,
no scroll-jacking, no count-ups.
`@media (prefers-reduced-motion:reduce)`: EVERYTHING static, but the punchline must survive — the
Correction stroke is already fully drawn, the OFF row already present, the verdict already "Blocked",
the primary button already disabled. Meaning with zero motion.

════════════════════════════════════════════════════════════════════════════
RESPONSIVE (mobile is where most traffic lands — give it a real spec, not a stack)
════════════════════════════════════════════════════════════════════════════
Below 900px: the margin apparatus collapses to inline, rule-separated NUMBERED footnotes directly
beneath the paragraph they annotate (numbered, never hidden). Hanging numerals move flush-left but
stay oversized. The exhibit goes 100% width but KEEPS its crop marks, its -0.6° tilt, and its caption;
wrap it in an `overflow-x:auto` container so wide rows scroll inside their own box. The ledger spine
collapses to a top index strip. Nothing becomes a row of identical cards. GUARANTEE the page body
never scrolls horizontally — use clamp()/relative units and wrap any wide element in overflow-x:auto.

════════════════════════════════════════════════════════════════════════════
FONTS, ASSETS, ACCESSIBILITY, BRAND COMPLIANCE
════════════════════════════════════════════════════════════════════════════
• Self-host fonts: embed Fraunces (opsz axis, 400/500/600, italic) + IBM Plex Sans + IBM Plex Mono as
  base64 woff2 @font-face rules inline in <style>. Do NOT <link> Google Fonts or any CDN (CSP blocks
  external hosts). If you cannot embed the binaries, use this fallback stack and keep ALL feature-
  settings so the craft survives a later swap: Fraunces→"Fraunces",Georgia,"Times New Roman",serif;
  body→"IBM Plex Sans",system-ui,-apple-system,sans-serif; mono→"IBM Plex Mono",ui-monospace,
  "SFMono-Regular",monospace.
• "Add to Slack": paste Slack's OFFICIAL button asset inline (the official SVG markup) — never a
  generated lookalike, never a remote <img src>. Link it to /slack/install. Do not restyle it.
• A11y: WCAG AA contrast in both themes; semantic landmarks (header/main/section/footer); alt text
  on any imagery; visible teal focus; NEVER encode meaning in colour alone — every ✓/✗ pairs a mark
  with a word, the verdict says "Blocked" in text. The animated card's DOM holds its final real text
  so screen readers reach the verdict regardless of motion.
• Honesty (invariant #7): marketing copy must never imply Linear/Jira/LaunchDarkly/Statuspage are
  live. Only Slack and GitHub Actions are live — the colophon and the "GITHUB ACTIONS · live" tag
  are the only "live" claims. QA every line.

════════════════════════════════════════════════════════════════════════════
FINAL SELF-AUDIT — verify each, fix any miss, then report which you satisfied
════════════════════════════════════════════════════════════════════════════
[ ] No rounded card grid / no 3-up feature cards / no component-library atoms.
[ ] Hero is asymmetric (copy 1/7, apparatus 9/13, hairline down col-8) — never centred, never 720px-centred.
[ ] The Correction is an inline SVG stroke (not text-decoration); caret + red italic margin note present.
[ ] Exhibit is on #FBFAF6 (not white), rotated -0.6°, with crop marks + ledger rules + the ONE shadow.
[ ] Exhibit captioned a "recreation" (not a screenshot); rows reconcile to the engine's real signals;
    GitHub Actions tagged live; no fake Slack chrome.
[ ] Red appears EXACTLY 3× (correction, OFF row, Blocked verdict) and on no button/link/hover/focus.
[ ] Four checks are teal ✓ text; drift "stalled" is muted (not red); amber used at most once.
[ ] Fraunces has opsz + negative tracking; oldstyle figures in prose, tabular in every data column;
    real italic pull-quotes; drop cap sinks 3 lines; hanging numerals outdent into the margin.
[ ] Spacing follows the loud/quiet meter; sections divided by full-bleed hairlines, not boxes.
[ ] Motion runs once on scroll-in; reduced-motion shows the final BLOCKED state statically.
[ ] Mobile keeps crop marks/tilt/caption; body never scrolls horizontally.
[ ] Light + dark both styled; teal focus; AA contrast; official Add-to-Slack asset; honesty copy verbatim.
[ ] All real copy present, no lorem, real refs intact (PROJ-118, PR #244, run #1183, sso_v2, 2026-07-02).
````

---

## 2 · Customer trust page **[HTML]** — audience-safe

```
Design the per-account trust page a vendor shares with ONE customer via a private link. This is
CUSTOMER-FACING: it must never show internal ticket IDs, PR/commit refs, tool names, or evidence
internals — only the outcome, the date, and the status. Self-contained responsive HTML + inline
CSS, light/dark aware, no external assets. It must look intentional and calm even with only 1–2
items, and degrade gracefully to a friendly empty state with 0 items.

[HEADER] Small Plex Mono eyebrow "MAINTAINED BY KEPT". H1 (Fraunces): "{Customer name} — commitments,
      kept." A one-line --muted subtitle: "A live, human-verified view of what we've committed to
      you." A subtle "as of {date}" in Plex Mono, right-aligned.

[SUMMARY STRIP] Four count tiles across the top: Kept ✓ (teal), In progress, Verifying, At-risk
      (amber). Each = big Fraunces number + Plex Mono label. If a count is 0, show it muted, not
      hidden.

[BUCKETS] Four stacked sections in this order: "Kept", "In progress", "Verifying", "At risk".
      Each section = a header with its count, then a list of rows. Each ROW shows ONLY: a short
      outcome line (Plex Sans 500), a due date (Plex Mono --muted), a status pill, and for kept
      items a "Kept on {date}" line in --teal. Hairline --rule between rows, no heavy cards.
      NEVER render anything that looks like an internal reference (no "PROJ-118", no repo names).
      If the source data trips a leak filter, the row will already have a generic label like
      "Commitment #3" — render it as-is, don't editorialize.

[EMPTY STATE] If there are no commitments at all: a calm centered message "No open commitments
      right now — you're all caught up." with the Kept wordmark.

[FOOTER] "Every closure on this page was verified by a person before it was marked done.
      Maintained by Kept." Plus small print: this page is private, do not share.

Constraints: NO images of internal tooling, NO logos of Jira/Linear/etc., NO evidence details.
The whole vibe: a receipt you'd be proud to hand a customer. Deliver production HTML.

IMPORTANT (compliance, not just design): this is a TEMPLATE. Ship it wired through the code
sanitizer (`sanitizeForAudience` + `detectLeaks` in `src/server/trustPage.ts`) — never render the
generated HTML with raw data standalone. The safety (no internal ref ever reaching a customer) is
enforced in code; the prompt only handles the look.
```

---

## 3 · Post-install / onboarding success page **[HTML]**

```
Design the page a Slack admin lands on immediately after clicking "Add to Slack" and approving
the OAuth screen. GOAL: convert install → first real use within 30 seconds, so the workspace
becomes an *active* install. Self-contained responsive HTML + inline CSS, light/dark aware.

[CONFIRM] A calm celebratory header (no confetti overload): a teal check, H1 (Fraunces)
      "Kept is in your workspace." Sub: "Here's the 30-second way to see what it does."

[ONE NEXT STEP] A single, prominent numbered card: "1 · Post a promise in a customer channel."
      Show the exact line to try in a copyable code chip: "we'll ship the SSO fix by Friday".
      Then "2 · Watch Kept catch it." — with a small mock of the Gate-1 confirm card DM'ing the
      owner. Keep it to these two steps; do not overload.

[SECONDARY] Quiet links: "Open the Kept Home tab" · "How verification works" · "Read the 2-min
      overview". A reassurance line in --muted: "Kept only ever stores derived facts — never your
      message text."

[FOOTER] Kept wordmark + Support link.

Warm, confident, single-focus. The failure mode we're preventing is a blank App Home after
install. Deliver production HTML.
```

---

## 4 · App Home **[BLOCK KIT]**

```
NOTE: renders in Slack Block Kit — sections, header, context, divider, actions, fields, buttons
only; NO custom CSS/HTML/colors. Design the LAYOUT + exact COPY and return valid Block Kit JSON
(<=50 blocks, section text <=3000 chars). This is the Kept Home tab a team member opens.

Structure:
  1. header: "Kept — your obligation ledger"
  2. context: "Answered live from the human-verified event log."
  3. section with fields (2-col): *Open* N · *Overdue* N · *At-risk* N · *Awaiting verify* N
     (use :red_circle:/:large_yellow_circle:/:eyes: emoji as leading markers).
  4. divider
  5. header: "Promise-drift radar"  → then up to 5 section rows, each:
     "{drift emoji} *{outcome}* — {customer} · _{bucket}_ ({reasons})" where drift emoji =
     :red_circle: stalled / :large_orange_circle: slipping / 〰️ softening / :large_green_circle: firm.
     If nothing is drifting: a single context line "Nothing is drifting — every open commitment is firm."
  6. divider
  7. header: "Open commitments" → grouped by customer. For each customer a section row
     "*{Customer}* — {n} open{, m overdue}" then its items as "• *{outcome}* — {state}{, due {date}}".
     Cap rows and append "_…and N more_" past the cap.
  8. A final actions block with buttons: "What's slipping?" and "Give me a summary" (these map to
     Assistant intents).
Return only the JSON. Keep emoji as the status language (Block Kit has no color).
```

---

## 5 · Evidence Packet card **[BLOCK KIT]** — the money shot

```
NOTE: Slack Block Kit only; return valid JSON. This is THE card — the moment Kept blocks a close
because reality disagrees with the ticket. It appears at Gate 2 when the agent has assembled proof.

Structure:
  1. header: "Ready to verify?"
  2. section: "*{outcome}* — for *{customer}*"  (e.g. "Ship the SSO login fix — for Acme")
  3. context: "The agent gathered this proof. You sign the verdict."
  4. divider
  5. section titled "*Evidence*" followed by one line per signal, each prefixed with ✓ or ✗:
        ✓ Jira — issue marked Done (PROJ-118)      [internal refs are OK here: this is the
        ✓ GitHub — PR #244 merged                   internal reviewer's private card, NOT the
        ✓ CI — workflow run success                 customer trust page]
        ✓ Deploy — shipped to production
        ✗ Feature flag — *OFF in production*
     Use :white_check_mark: and :x:. Make the failing row visually the punchline (bold the reason).
  6. section: a verdict callout — ":no_entry: *Not actually available.* The feature flag is OFF in
     production, so customers can't use this yet — even though the ticket says Done."
  7. actions: primary button "Verify & close" (style: primary) and "Not yet" (default). Note in a
     context line that Verify is blocked while evidence is insufficient.
Also produce a SECOND variant of the same card for the happy path (flag flipped ON): all rows ✓,
verdict ":white_check_mark: Verified available — safe to close.", Verify button active.
Return both JSON variants.
```

---

## 6 · Marketplace gallery images **[IMAGE]** — 5 × 1600×1000

```
Create a cohesive set of FIVE Slack Marketplace gallery images, each EXACTLY 1600×1000 px (8:5).
Shared system across all five: warm paper background #F4F1EA, deep teal-green #0F6E5C, one --red
#B4463C accent reserved for the "blocked" idea, Fraunces serif headlines + IBM Plex Sans/Mono
supporting text, generous margins (min 96px), a small "Kept" wordmark bottom-left on each, and a
consistent grid so the five feel like a family. Each image = ONE idea: a short Fraunces headline
(top) + a clean, believable UI mock (center) + one Plex Mono caption. Must be legible as a
thumbnail. The five:

  1. "Done doesn't mean shipped."  — the Evidence Packet card with the red 'Feature flag: OFF in
     production' row and a 'Blocked' verdict chip. (The hero image.)
  2. "The agent assembles the proof. You sign."  — the 5-step Proof-of-Done flow, gates 1 & 5
     highlighted as the human touches.
  3. "See a promise soften before it goes quiet."  — the promise-drift radar: 🟢 firm / 〰️
     softening / 🔴 stalled rows with a subtle timeline.
  4. "A trust page for every customer."  — the customer trust page (surface #2) in a browser frame,
     buckets Kept / In progress / Verifying / At-risk.
  5. "Human-verified. Zero-copy. Tenant-isolated."  — three quiet Plex Mono badges over a calm
     ledger motif; the engineering-credibility slide.

No stock-photo people, no neon, no 3D blobs. Editorial, warm, trustworthy. Export PNG, sRGB.
(If your tool renders text poorly, generate the frames/background and I'll set the type in Figma —
so also give me a version with the headline/caption areas left as clean empty space.)
```

---

## 7 · Demo video cold-open + thumbnail **[IMAGE]**

```
A) THUMBNAIL — 1280×720. Center concept: a green "DONE" ticket/badge with a bold --red "BLOCKED"
   stamp slammed diagonally across it. Headline (Fraunces, top or bottom third): "The ticket lied.
   Kept caught it." Warm paper #F4F1EA background, deep teal #0F6E5C for the wordmark, the single
   --red #B4463C accent on the stamp only. High contrast, readable on a phone. Kept wordmark small.
B) COLD-OPEN TITLE CARD — same design as a clean 1920×1080 still for the first 3 seconds of the
   video, plus a motion note: the "BLOCKED" stamp presses on at ~0.4s with a subtle 2° rotate and a
   short shake, everything else still. Provide the static still + the one-line motion description.

Editorial, cinematic, no clutter. The whole idea in one glance: a confident "Done" being overruled
by reality.
```

---

## 8 · Social / OG image + favicon **[IMAGE]**

```
A) OPEN-GRAPH image — 1200×630. Kept wordmark (Fraunces) + the line "Done doesn't mean shipped."
   + a small Evidence Packet fragment showing the red OFF row. Warm paper, teal, one red accent.
   Safe margins for platform cropping. PNG sRGB.
B) FAVICON / app icon — a simple mark that reads at 32px: a small serif "K" or a minimal "kept"
   ledger-check glyph (a check inside a soft square), --teal on --paper (and an inverted --paper-on-
   teal variant for dark tabs / the Slack app icon at 512×512). Flat, no gradients, crisp at 16px.
```

---

### How to use
- Web pages (1,2,3): paste §0 + the surface prompt into **v0.dev** or **Lovable**; ask for a single
  self-contained file. Then drop the trust page into `src/server/trustPage.ts` and the landing into `docs/`.
- Block Kit (4,5): paste into **Slack's Block Kit Builder** (or Claude) to get JSON, wire into
  `src/slack/blocks.ts`.
- Images (6,7,8): **Ideogram** or **DALL·E 3** handle text-in-image best; **Midjourney** for the
  richest look (then set type in Figma). Generate at the exact pixel sizes noted.
- Keep the palette + type identical across all of them — that consistency is most of the polish.

---

## Before you ship — prompt → production

These prompts are an excellent **~80% starting point, not finished assets.** For a real Marketplace
launch, budget a human art-direction + QA pass on top:

1. **AI output isn't clean.** v0/Lovable HTML needs a human polish pass; text-in-image tools
   (Ideogram/DALL·E) frequently mangle type — generate the frames/backgrounds and set headline
   type in Figma.
2. **Slack brand rules are mandatory.** Use Slack's **official "Add to Slack" button asset** (never
   a generated one); the app icon must be a proper **512×512** per Slack's brand guidelines. These
   prompts don't enforce Slack branding — you must.
3. **Real screenshots beat mockups.** Once the app is live, build the gallery from **real captures**
   (Evidence Packet card, App Home, trust page); use the mockup prompts only as fallback/marketing
   frames. Reviewers and buyers trust actual product shots.
4. **The trust page is a compliance surface, not just a design.** The look can come from the prompt,
   but its safety (no internal ref leaking to a customer) is enforced by the code sanitizer — ship
   the generated markup wired through `sanitizeForAudience` + `detectLeaks`, never standalone.
5. **QA before submit:** WCAG AA + cross-device pass, and an **honesty check** on all generated
   marketing copy — never let it imply the simulated integrations are live.

**Fonts are safe:** Fraunces and IBM Plex are both open-source (OFL) — no licensing risk for a paid app.
