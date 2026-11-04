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
