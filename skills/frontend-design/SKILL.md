---
name: frontend-design
description: Required before creating or changing any user-facing UI (HTML, CSS, JSX/TSX, Vue, Svelte, Astro, templates, email HTML, landing pages, dashboards, components). Gives a fixed process, design direction that avoids templated defaults, a measurable quality floor (type, spacing, contrast, responsive, accessibility, states) and a render-and-check verification loop, so any model ships a good frontend.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Use this for every task that creates or changes something a person sees and uses. Follow the steps in order. Do not skip the plan or the verification. A short task gets a short plan, never no plan.

## 0. Decide which mode you are in

Look at the repository before designing anything.

- **Existing product mode**: the project already has a UI, a design system, a theme, tokens (CSS variables, Tailwind config, theme files) or a component library (MUI, shadcn/ui, Chakra, Radix, Bootstrap, an in-house kit). Consistency wins over novelty. Reuse its tokens, components, spacing, radii, icons and voice. Do not add fonts, colors or libraries unless the user asks. New screens must look like they were always part of the product. Find two or three existing screens or components that are closest to the task and copy their patterns.
- **New design mode**: a new page, site, app or an explicit redesign. Here you are the design lead and must make a distinctive, deliberate choice (sections 1 to 3).

When the brief pins down a visual direction (brand colors, a reference, "make it brutalist"), follow it exactly in either mode. The user's words always win over this skill.

## 1. Ground the design in the subject

Approach this as the design lead at a studio known for giving every client a distinct visual identity. The client has rejected proposals that felt cliché or templated and is paying for a point of view.

If the brief does not say what the product is, who it is for and what the screen's main job is, decide one concrete answer for each, state it in one line, and build on it (ask only if you genuinely cannot proceed). The subject's industry, materials and vernacular are where distinctive choices come from: a toy for children aged 8 to 11 looks nothing like a dashboard for financial analysts. Use the brief's real content and subject matter throughout. Never ship lorem ipsum; write plausible, specific copy.

## 2. Write a design plan before code

Write this plan in your reply or working notes before the first UI edit. Keep it compact.

- **Brief**: subject, audience, the screen's primary job, mode (existing or new).
- **Color**: 4 to 6 named hex values (background, surface, text, muted text, accent, and a state color if needed). In existing product mode, list the tokens you will reuse instead.
- **Type**: one or two families with roles, a type scale (for example 14/16/20/25/31/39 px, ratio about 1.25) and weights. If two families, make them clearly distinct.
- **Layout**: one-sentence concept plus an ASCII wireframe of the main viewport on desktop and on mobile. State alignment (left, centered, justified) and the max content width.
- **Signature**: the one memorable element. Everything else stays quiet.
- **States**: which loading, empty, error, disabled and success states this UI needs.

Then review the plan against the brief. Ask: would I produce nearly the same plan for any similar prompt? If a part is a default rather than a choice made for this brief, revise it and say in one line what you changed and why. Only then write code.

### Defaults that read as generated (avoid unless the brief asks)

1. Warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta accent (near #D97757).
2. Near-black background with one acid-green or vermilion accent.
3. Broadsheet layout with hairline rules, zero radius and dense newspaper columns.
4. The SaaS card kit: everything chopped into identical rounded cards with one radius, the same soft grey shadow, and gradient washes as decoration.
5. Template chrome on every subject: tracked-out ALL-CAPS eyebrows above every heading, meta strings joined with middle dots, "WORD — fragment" labels, #0B0B0B or #111 standing in for black, monospace for small labels, an arrow appended to every link and button.
6. A hero made of a big number, a small label, supporting stats and a gradient accent.
7. Purple-to-blue gradients, glassmorphism and glowing blobs used as filler.
8. One word in a headline accented with italic, bold or a different color.
9. Numbered markers (01 / 02 / 03) on content that is not actually a sequence.
10. Fade-and-slide-up on every section and hover lift on every card.
11. Emoji used as icons or bullet decoration.

All of these are legitimate for some briefs. Where the brief leaves an axis free, do not spend that freedom on one of them.

## 3. Design principles

- **Hero**: for web pages, open with the most characteristic thing in the subject's world, in the most fitting form: a headline, an image, a live demo, an interactive moment.
- **Typography carries personality**: choose typefaces deliberately, not the families you reach for on every project. Use the type treatment itself as part of the design when type is the visual element.
- **Structure is information**: borders, numbering, eyebrows, dividers and labels must encode something about the content, not decorate it.
- **Hierarchy**: one primary action per view. Size, weight, color and space should make the reading order obvious within three seconds.
- **Restraint**: spend boldness in one place. Before finishing, remove one decoration (take one accessory off before leaving the house).
- **Motion**: non-triggered motion is rare and deliberate (at most one orchestrated page-load or reveal). Motion that answers a user action (open, expand, confirm) is welcome when it shows what changed. Durations 120 to 300 ms, ease-out for entering.

## 4. Quality floor (always, without announcing it)

These are measurable. Check each one.

- **Text**: body at least 16 px on mobile; line-height 1.4 to 1.6 for body, 1.05 to 1.25 for large headings; line length 45 to 75 characters (`max-width: 65ch` is a good default); serif body gets slightly more line-height. Sentence case for UI labels.
- **Spacing**: use one scale (4 or 8 px base: 4, 8, 12, 16, 24, 32, 48, 64, 96). Related items sit closer than unrelated ones. Use `gap` in flex and grid instead of margins on children.
- **Color and contrast**: WCAG AA at minimum: 4.5:1 for body text, 3:1 for large text (24 px, or 19 px bold), icons, input borders and focus indicators. Never convey state by color alone. If you add dark mode, define it with tokens and `prefers-color-scheme`, and check contrast in both.
- **Responsive**: works from 320 px to wide desktop with no horizontal scroll. Design mobile first; check at about 360, 768 and 1280 px. Use `min-height: 100dvh` rather than `100vh`, fluid type with `clamp()`, `img { max-width: 100%; height: auto }`, and explicit width and height on media to avoid layout shift.
- **Interaction**: targets at least 44 by 44 px on touch (24 px absolute minimum). Every interactive element has hover, `:focus-visible` (a clearly visible ring, 2 px or more, with offset), active and disabled styles. Cursor and pointer behavior match the element.
- **Accessibility**: semantic HTML first (`header`, `nav`, `main`, `section` with headings, `button` for actions, `a` for navigation, never a clickable `div`). One `h1`, headings in order. Every input has a visible label; errors are announced with text next to the field. Images have meaningful `alt` (empty for decorative). Icon-only buttons have an accessible name. Respect `prefers-reduced-motion`. Keyboard: everything reachable and operable, logical tab order, no focus traps, Escape closes overlays.
- **Forms**: on a failed submit, keep what the user typed, move focus to the first invalid field, link each error to its field with `aria-describedby` and set `aria-invalid="true"`. Repeated actions in a list (Edit, Delete) get accessible names that say which item (`aria-label="Delete Lunch"`). Data a page saves (localStorage, drafts) is validated when read back, and every saved item has a stable id.
- **States**: implement the loading, empty, error, disabled and success states from the plan. Empty states invite the next action. Errors say what happened and how to fix it.
- **Performance**: no unused libraries or fonts; at most two font families and the weights you use, with `font-display: swap`; compress and size images; avoid layout thrash in animations (animate `transform` and `opacity`).

## 5. Build it cleanly

- Put colors, type, spacing, radii and shadows in tokens (CSS custom properties, the Tailwind theme, or the project's theme object) and use them everywhere. No one-off hex values or magic numbers scattered in components.
- Keep CSS specificity flat (single classes). Watch for rules that cancel each other, especially section padding versus component margins. Avoid `!important`.
- Layout with flexbox and grid; use container queries for components that live in varied widths.
- With Tailwind, use the configured theme scale; avoid long chains of arbitrary values. With a component library, use its components and theming API instead of overriding its internals.
- Match the framework's conventions (React state and effects, Vue SFCs, Svelte stores) and the project's file structure and lint rules.

## 6. Verify by looking at it

A UI is not done until it has been rendered and inspected.

1. Run the project's lint, type check and build for the files you touched.
2. Render the UI. With a `ui_check` tool, pass a static page's HTML file (it is served for the check; start no server yourself) or the URL of the dev server a framework app already runs, and render lists and tables filled as well as empty (its `storage` or `setup` input). Otherwise use whatever is available: the dev server plus a browser tool, Playwright or another headless browser (see the `webapp-testing` skill), or a screenshot tool. Capture mobile (about 375 px) and desktop (about 1280 px) at minimum.
3. Inspect the screenshots against the plan and the quality floor: hierarchy, alignment, spacing rhythm, overflow, contrast, truncated text, focus rings (tab through), and every state you implemented.
4. Fix what you find and look again. Critique your own work as a picky senior designer would.
5. If you cannot render in this environment, say so plainly and list exactly what the user should check. Never claim a UI looks right without having seen it.

## 7. Before reporting done

- [ ] Mode decided; existing tokens and components reused where they exist.
- [ ] Plan written and reviewed against the brief and the defaults list.
- [ ] Quality floor checked: text, spacing, contrast, responsive, interaction, accessibility, forms, states, performance.
- [ ] Rendered at mobile and desktop and inspected, or the inability to render stated.
- [ ] Lint, type check and build pass for the touched files.
- [ ] Copy is real, specific and consistent.

## Writing in the interface

Words exist to make the interface easier to understand and use. Write from the user's perspective in plain language: a user manages notifications, not webhook config. Use active voice; a button says exactly what happens ("Save changes", not "Submit"), and an action keeps its name through the flow (the "Publish" button produces a "Published" toast). Errors explain what went wrong and how to fix it, without apologizing or being vague. Keep the tone conversational, sentence case, no filler. Each piece of text does one job.

## Going deeper (bundled skills, load by ID when needed)

- `impeccable`: deeper design craft, audits and polish passes.
- `antislop-ui`: check a finished UI for generic, generated-looking patterns.
- `web-design-guidelines`: review a UI against interface guidelines.
- `accessibility-compliance`, `responsive-design`, `interaction-design`, `visual-design-foundations`.
- Stack specific: `tailwind-design-system`, `mui`, `react-best-practices`, `react-view-transitions`, `design-system-patterns`.
- `webapp-testing`: drive and screenshot the UI with Playwright.

---
Adapted from Anthropic's frontend-design skill (Apache License 2.0, see LICENSE.txt). Modified for InfiniteOC: added existing-product mode, a required written plan, a measurable quality floor, build rules, a render-and-inspect verification loop, a completion checklist, and pointers to bundled skills.
