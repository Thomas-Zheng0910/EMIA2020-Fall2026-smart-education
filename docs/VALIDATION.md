# Validation · 2 November 2026 (v2)

## Automated
- `npm run check`: 13 tests (ink geometry, safe Markdown/LaTeX, lecture import + multimodal digest, revision conflicts, per-student access, confident-only sharing, crop rendering, dismissals, annotation-only edits skip re-indexing, stale index results discarded, citation validation and basis downgrade, slide-grounded quiz filtering and grading, free-page linking/confirmation, unconfigured-AI error, cross-site write rejection); typecheck and production build.
- `npm run test:e2e`: 6 browser scenarios against a deterministic mock OpenAI server: import lecture PDF; ink save/undo/reload and automatic sharing; classmate pill → crop → add → undo; lasso → Explain with labeled sources → source viewer → quiz grading; blank notebook text + pages + auto-link chip; phone width.

## Live (DeepSeek `deepseek-flash`, COMP2211 material)
- Seed: 636 slides digested; 48 handwritten pages indexed (416 fragments, 401 shared). Transcriptions spot-checked against Alex's pages: accurate including code and comprehension syntax.
- Explain on L2 slide 6 selection: relevant gap-filling cards citing slides 6–7. Quiz: 4 questions, each citing slides.
- Screenshots: `docs/screenshots/`.

## Not validated
Accuracy at scale, contradiction detection quality, usefulness to students, multi-user concurrency beyond revision checks.

## Library v2 · 3–4 November 2026
- `npm run check`: 21 tests, including folders: nesting, filing on create/import/move, other students get 404, cross-course moves rejected (400), deleting a folder moves its contents up, leaving the course closes its folders (403). Typecheck and build pass.
- `npm run test:e2e`: 8 scenarios. Updated for drop-to-import of lectures, return-to-place after closing a notebook, lecture notebooks appearing in My notes, and "Manage sharing". New folders scenario: create, subfolder, Move to…, mouse drag onto the sidebar, rename, delete, notes PDF dropped onto a folder, folders hidden from another student.
- Manual browser checks on the real COMP2211 data (Playwright Chromium):
  - Desktop 1440×900: overview, Lectures (13 decks), My notes; create a folder → drag a note in → delete the folder (note returns); open a lecture → Back returns to Lectures.
  - Emulated iPad Pro 11 with real touch events: long-press menus on notes and empty space, Move to…, "New notebook" dialog, 42 px rows with a visible "+". Portrait: slide-over sidebar opens and closes after choosing a place. The public hostname serves the same build.
- Not validated: a physical iPad / Safari, Apple Pencil, dragging PDFs from the iPad Files app, and whether students discover long-press menus.

## Knowledge base, inline suggestions, file tree · 4 November 2026
- `npm run check`: **22 tests**, typecheck and production build pass.
  - Knowledge base: notes on a slide merge into one entry; only the shared, confidently-read note feeds it; closing again with no edits costs no model call; a second classmate's note joins the same entry and the card stops being verbatim ("From 2 classmates' notes").
  - Disputes: "Looks wrong" rechecks immediately, the entry leaves every student's suggestions and every prompt, and its author sees the explanation on their own page; a student outside the course gets 404.
  - Gaps: sourced from a peer entry, from the slide digest when no note covers it, and filled on demand when neither does; dismissed per student.
  - Supersession: rewording a note marks the old fragment `supersededBy` instead of deleting it, so a citation already in someone's notes still resolves.
  - Sharing is gone: `POST /api/fragments/:id/sharing` and `GET /api/courses/:id/sharing` return 404; the AI's own privacy reasons still hold and are shown to the author.
  - File tree: seeded Lectures/Quizzes, renamed folder still holds the decks, deleting it does not re-create it, filing a deck creates an empty copy that materialises pages only on first open.
- `npm run test:e2e`: **9 scenarios** (mock model), including: a classmate's note arrives as a marker with no panel and no badge, opens a card in place, adds an annotated sticky note, undoes it, and stays dismissed after a reload; lasso → popover answers in place with Explain / Example / Why? and opens a slide source; the file tree scenario (create, subfolder, Move to…, drag, rename, delete, drop a PDF into a folder, folders private to their student).
- Manual checks against the real COMP2211 data through the public hostname: the course tree renders (smart views, seeded folders, 13 decks in L0→L12 order with `L#`, `PDF` and ✎ badges); the notebook editor is unchanged; a string edit reached the public page as a new bundle hash with no rebuild or restart, and vanished again on revert.
- Supervisor: killing the API child left the public origin dark while systemd still reported `active`; `scripts/serve.mjs` now detects it and the unit restarts itself (verified: dead at t+4 s, serving again at t+24 s, unit never inactive).
- **Not validated**: model quality of the merge, gap detection and dispute judgement (mock provider only; needs representative inputs and human evaluation); behaviour on a physical iPad; anything at class scale.
