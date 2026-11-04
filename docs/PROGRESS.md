# Progress

Latest handoff: `docs/HANDOFF.md`.

## v2 rewrite — 2026-11-02 (current)

User decisions: UI and backend may be rewritten; Goodnotes/Notion-like note-taking app with a full ink editor; official DeepSeek `deepseek-flash` (multimodal, so no separate OCR); no RAG; COMP2211 Flexcil export as course material; implement end-to-end without staging. The v1 code is archived at `~/notebook-v1-backup.tar.gz` (the repo had no commits).

Agent decisions (spec §"Decisions made by the agent"): three demo students with Alex owning the imported handwritten notes; all 12 lectures + model-evaluation supplement seeded; past papers/lab/self-test not imported; laptop + tablet targets; loopback only.

Done:
- Backend rewrite: pages/ink/items data model, PDF rendering via poppler, slide digests (batched multimodal), automatic page indexing with per-fragment slide linking, confident-only sharing, revision-safe writes, annotation-only edits skip re-indexing, Explain and Quiz with validated citations and basis labels.
- Frontend rewrite: library, notebook editor (pen/highlighter/eraser/lasso/text/image, undo/redo, zoom, stylus-only, thumbnails, insert/delete pages, autosave), per-page chips (organizing, contributing, link confirm/change, classmate count), study panel (Classmates, Explain, Quiz), source viewer.
- Live seed on real data: 13 lectures / 636 slides digested; Alex's 48 handwritten pages → 416 fragments, 401 shared across 237 slides. Live checks: classmate note on L2 slide 5, Explain on a lasso of L2 slide 6 (~6 s, official-slide citations), quiz with slide citations, typed KNN note auto-linked to L4 slide 11 (0.68, unconfirmed).
- Verification: 13 unit/API tests, 6 Playwright scenarios (mock model), typecheck and production build pass.

Multi-course (follow-up requests): enrollments; front page = all my courses, each course a subpage with its own URL (replaced the earlier top-bar switcher); join/leave/create; per-course isolation of lectures, notebooks, classmate notes, links and quizzes; seed `--code/--name`. 14 unit/API tests and 7 browser scenarios pass.

Design review (docs/DESIGN_REVIEW.md): sharing disclosure at join/create, course sharing bar + review dialog, per-item Stop sharing persisted across re-reads, private reasons, slide-restatement filter and direct-content transcription prompt (Alex re-indexed), no bare confidence %, quiet panel, Continue row and last-page resume, lecture cards show my progress (no duplicate lecture notebooks), one-row editor header with floating zoom, touch-only stylus toggle, closable menus/dialogs, multi-slide chip, annotations placed beside the selection, lazy-render fix. 17 unit/API tests, 7 browser scenarios.

Library v2 (Nov 3, user-reviewed prototype): sidebar of courses → My notes (with nested, per-student folders) and Lectures; lecture notebooks appear in My notes once written on; no classmate counts in the library; drag-in PDFs instead of import buttons; long-press/right-click menus, long-press drag and Move to… for tablets; portrait slide-over sidebar. New `folders` table and `notebooks.folderId`; folder routes with ownership/enrollment/same-course checks. 21 unit/API tests, 8 browser scenarios.

File tree, phase 1 (Nov 4, per `docs/superpowers/specs/2026-11-04-knowledge-base-inline-suggestions.md`): the fixed My notes/Lectures sidebar is replaced by a free per-course file tree. Every student's course is seeded once with two ordinary folders, Lectures and Quizzes (recorded in `course_seeds`, so renaming or deleting them sticks and they are never re-created); decks are one shared `lectures` row and only become a student's own notebook when opened or filed (`fileLectureNotebook` creates the row empty, `openLectureNotebook` materialises the pages on first open), so no per-student deck copies exist up front. Two smart views sit above the tree — My notes (files with ink or text) and All files (the whole tree flattened, decks first in lecture order) — and placement is a URL (`#course=…&folder=…`, `&view=notes|all`). A PDF dropped on the seeded Lectures folder becomes official slides for everyone; dropped anywhere else it is a private notebook. Sharing UI (Manage sharing, review dialog) is removed per the Nov 4 decision; the join/create dialogs still disclose sharing. 22 unit/API tests, 9 browser scenarios.

Bug fixes found by running the full suite (not by the typecheck): folder seeding hung off HTTP handlers, so any enrollment path that did not go through a route (test setup, `ensureStudents`) left a student with an empty tree — it now lives in `Store.enroll`; dropping a PDF while standing inside the Lectures folder made a private notebook instead of official slides; clicking the current course in the sidebar collapsed the tree instead of returning to the course root; decks in a folder sorted by edit time instead of lecture number. Playwright/Vite ports are now configurable (`E2E_WEB_PORT`/`E2E_API_PORT`, `PORT`/`API_PORT`/`WEB_PORT`), so the suite runs alongside a dev server instead of fighting it for 5173.

Knowledge base and inline suggestions, phases 2–5 (Nov 4, per `docs/superpowers/specs/2026-11-04-knowledge-base-inline-suggestions.md`): a note now reaches a classmate as a *suggestion*, not a raw fragment. `knowledge_entries` groups the notes on a slide into points of knowledge with an AI summary (a single source is kept verbatim), `entry_sources` tracks which notes feed which point, `lecture_topics` names 5–15 topics per lecture, and `page_gaps` records where a page is missing something. The merge-and-check job runs when a student leaves a notebook (`POST /api/notebooks/:id/close`), costs one call per changed slide (a source hash skips unchanged ones), and is swept every 10 minutes; a reported point is rechecked immediately and stays hidden until then. The page-indexing call also finds gaps, and each is offered in the order peer → slide → AI. On the client the Classmates/Explain/Quiz panel is replaced by quiet margin markers, a card that opens in place at the gap (Add / Dismiss / Not helpful / Looks wrong), a lasso popover with Explain / Example / Why? and a typed question, and a slim suggestions panel that also lists the author's own notes as shared, private (with reason) or disputed (with the AI's explanation). Sharing routes and controls are gone by user decision; `withheld` stays dormant. Prompts carry the knowledge base as `[E<id>]` with server-side citation validation. 22 unit/API tests, 9 browser scenarios.

Bugs the suites found while implementing this (all fixed): an edited note was deleted rather than superseded, so an old citation could not resolve; gap ids changed on every re-read, so an open card vanished and dismissals did not stick; gaps never refreshed after a classmate's new note because the content hash skipped the re-read; and after a re-read nothing told the client to refetch, so a gap kept saying "From slide 12" until the student happened to write again (now `suggestVersion` on page status). Also: `cite()` upper-cased refs while entry ids are lowercase UUIDs.

Known limits / next:
- Text boxes have no resize handle; images cannot be resized after insertion; no shape tool or page templates beyond ruled/blank/grid.
- Bounding boxes from the model are approximate; crops occasionally include neighboring lines.
- Explain/quiz latency depends on the provider (seconds to a minute); no streaming yet.
- No human evaluation of transcription accuracy or usefulness yet.
- The systemd unit and Cloudflare hostname from v1 (`docs/DEPLOYMENT.md`) were left untouched; restart the service to serve v2 (`npm run build` first).

## v1 — 2026-11-01 (superseded)

Typed Tiptap notebook with FTS/embedding retrieval and demo fixtures. Replaced by v2 at the user's request because the UI was poor and the flows felt fake (no live AI was configured).
