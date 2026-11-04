# Handoff · 4 November 2026

## Where things stand
Notebook v2 is a working local prototype of the concept doc (`docs/reference/original-concept.docx`): a Goodnotes-like course notebook whose notes are read by a multimodal model, linked to lecture slides, distilled into a shared course knowledge base, and offered to classmates as quiet, source-linked suggestions. It runs on live DeepSeek against the real COMP2211 material. The product is called **Notebook**; the UI, browser title, docs and new identifiers use that name only.

The latest pass (4 Nov) implemented the **knowledge base and inline suggestions** spec end to end: the file tree (phase 1), then the shared course knowledge base, inline suggestions, the slim panel and topics (phases 2–5). Notes are no longer shown to classmates as raw fragments; they are merged into `knowledge_entries` per slide, and a student meets them as a quiet margin marker beside the gap they fill.

- Run: `npm run dev` → http://127.0.0.1:5173. Both halves watch: Vite rebuilds the client, `tsx watch` restarts the API. Use `npm run dev:local` (4312/5174) when the public service already holds 4310.
- Public host: https://notebook.zh-thomas.party → `:4310`, served by `notebook.service` running `npm run serve` (watch + rebuild). **An edit here is live on the public page within seconds — no build, no restart.** Restart the service only after editing `.env`, which `tsx watch` does not reload.
- Verify: `npm run check` (22 unit/API tests + typecheck + build) and `npm run test:e2e` (10 browser scenarios, mock model). Both pass as of this handoff. The e2e run uses `:4311`/`:5174`/`:4399`, so it runs alongside the service.
- Live smoke (costs API calls): `node scripts/live-smoke.mjs` against the running server.

## Read first
1. `AGENTS.md` — invariants (sharing, enrollment checks, no RAG, no fabricated AI output, annotations never re-shared) and the library layout rules.
2. `docs/superpowers/specs/2026-11-04-knowledge-base-inline-suggestions.md` — current design (knowledge base, inline suggestions, file tree). `2026-11-02-notebook-v2-design.md` covers the editor and remains accurate where this spec does not supersede it.
3. `docs/DESIGN_REVIEW.md` — the earlier human-centred review and its open decisions.
4. `docs/PROGRESS.md`, `docs/VALIDATION.md` — history and evidence.

## User decisions so far
- Rewrite allowed; Goodnotes/Notion-like UI; full ink editor.
- Official DeepSeek `deepseek-flash` (multimodal; no separate OCR); no RAG/embeddings.
- Course material: COMP2211 Flexcil export (zip in repo root, untracked).
- A student can take several courses; the front page lists my courses and each course is its own page.
- Agent may decide details and implement without staging.
- Product name is **Notebook**; do not reintroduce the old name in UI, docs, or new identifiers.
- Knowledge base and suggestions (Nov 4):
  - The concept doc's shared topic-level index, with AI-written summaries, duplicate grouping, contradiction detection and version history.
  - No embeddings: the model groups and checks one slide's notes per background call.
  - Summaries, not originals; a single source is the original text verbatim. Sources are not listed in the card.
  - **No reliability labels anywhere**: no "unverified", no Official/AI basis chips — neutral source lines only.
  - The AI judges wrong notes and excludes them silently from summaries, suggestions and prompts; the author gets a marker and an explanation on their own page, and editing triggers a recheck.
  - No classmate names on suggestions: "A classmate's note", with the handwriting crop.
  - Inline suggestions at the gap, found after a pause in writing; circle a part for a popover with Explain / Example / Why? and a typed question.
  - A slim side panel listing this page's suggestions, closed by default. Quiz me leaves the panel and is a future plan.
  - One free file tree per course; students own everything, including the decks; the fixed My notes / Lectures sections are gone.
  - **No stop-sharing in the demo**: sharing is automatic and not reversible. The join/create dialogs still explain sharing.
  - The merge/check job runs when the student leaves the notebook, not on a timer alone.
- Library (Nov 3), superseded by the tree above but still true of its behaviour: documents as covers, courses joined not created, no add buttons (drag instead), tablet-first with touch menus.

## State of data
- `data/` (ignored): SQLite + rendered slides. 13 lectures / 636 slides digested. Alex owns `COMP2211 notes.pdf` (48 pages): 410 fragments, 207 shared, 178 private as "already on the slide", 9 hard to read, 16 lecture unclear. Thomas has written on L2 (2 slides); Priya has test scribbles. Every student now has the two seeded folders (Lectures holding the 13 decks, Quizzes empty) — `course_seeds` records them so renames and deletions stick.
- Schema additions are applied automatically on start, all additive: `folders` + `notebooks.folderId`; `course_seeds`; and for the knowledge base `knowledge_entries`, `entry_sources`, `lecture_topics`, `page_gaps`, `gap_dismissals`, `entry_reports`, `slide_merges`, `gap_checks`, plus `fragments.entryId` and `fragments.supersededBy`.
- **After upgrading, knowledge entries only exist for slides somebody has merged.** Leave a notebook (or wait for the 10-minute sweep) to populate them; until then suggestions fall back to the official slide.
- Demo identities: Thomas, Alex, Priya; all enrolled in COMP2211. Identity travels as `x-student-id` header plus a `notebook_student` cookie (for images). Not authentication.
- Browser state: localStorage uses `notebook.*`; sessionStorage `notebook.lastLibrary.<course>` remembers where in a course the student was (closing a notebook returns there).
- Re-seed from scratch: delete `data/`, then `npm run seed -- "Flexcil PDFs 2026-11-01 23.58.58.zip"` (~25 min of live model calls). Another course: add `--code X --name "..."`.

## Changes in this pass (Nov 3–4)

### File tree (phase 1)
- **`src/Library.tsx`**: sidebar of courses → smart views (My notes, All files) → the course's folders, nested; content area shows folders and files together, decks sorted by lecture number then the student's own files newest first.
- Two ordinary folders seeded once per student per course (`course_seeds`); a deck kept as one shared `lectures` row until opened or filed (`fileLectureNotebook` creates the row empty, `openLectureNotebook` materialises its pages).
- A PDF dropped on the seeded Lectures folder is official slides for everyone; anywhere else it is a private notebook.
- URLs: `#course=<id>&folder=<id>`, `&view=notes|all`.
- Gestures support decks as well as notebooks (`data-deck`); long-press menus, Move to…, drag and drop-to-import all work from the tree.

### Knowledge base, suggestions, panel (phases 2–5)
- **`server/jobs.ts`**: `mergeSlide` groups a slide's notes into `knowledge_entries` (one AI call per slide, skipped when the notes' hash is unchanged), single-source entries verbatim, contradictions marked `disputed`; `topicsForLecture`; gap detection added to the page-indexing call; `markNotebookDirty` on close plus a 10-minute sweep; `refreshGapsOnOpen` re-reads a page once when its slide's knowledge changed.
- **`server/db.ts`**: entries/sources/topics/gaps/reports; `replaceFragments` keeps fragment ids for unchanged text and **supersedes** the rest instead of deleting (an old citation still resolves); `replaceGaps` keeps gap ids stable so an open card does not vanish and dismissals stick.
- **`server/suggestions.ts`**: resolves a page's gaps to cards — peer entry first, then the slide digest, then "AI explanation" filled on demand.
- **`server/study.ts`**: prompts now carry the knowledge base (`[E<id>]`) instead of raw classmate fragments; `fillGap`; citations validated server-side (refs are compared case-insensitively, since entry ids are lowercase UUIDs).
- **Client**: `src/panel/Panel.tsx` is now the suggestions list, the margin marker, the inline `SuggestionCard` and the `LassoPopover`; the Classmates / Explain / Quiz tabs are gone. Leaving the notebook sends `POST /api/notebooks/:id/close` with `keepalive`.
- Sharing routes and UI removed (`POST /api/fragments/:id/sharing`, `GET /api/courses/:id/sharing`, `setWithheld` callers); the `withheld` table and reason remain dormant.

### Deployment
- `notebook.service` installed and enabled (runs `npm run serve`: `tsx watch` + `vite build --watch`), with `scripts/serve.mjs` supervising the API health so a crashed child restarts the unit instead of leaving the origin dark.

### Bug fixes found by running the suites
- Seeding hung off HTTP handlers, so enrollment paths that bypassed routes (test setup, `ensureStudents`) produced an empty tree — moved into `Store.enroll`.
- Dropping a PDF while inside the Lectures folder made a private notebook instead of official slides.
- Clicking the current course collapsed the tree instead of returning to the course root.
- Decks in a folder sorted by edit time instead of lecture number.
- The API never reloaded on edits (`tsx` without `--watch`), so the public page served new UI against a stale API.

## Secrets and repo hygiene
- `.env` (ignored, chmod 600) holds the user's DeepSeek key and `ALLOWED_ORIGINS`; the key was pasted in chat — recommend rotating it.
- The repo has **no commits** (branch `feat/working-prototype`, everything staged/untracked). No git identity is configured; none was invented. v1 is archived at `~/notebook-v1-backup.tar.gz`. Ask the user before committing. New untracked files this pass: `src/gestures.ts`, `proto/library/index.html`.
- `~/.cloudflared/config.yml` (the user's named tunnel, shared with other services) was read but **not changed**. Quick tunnels (`cloudflared tunnel --url`) do not work on this network (edge returns 404), which is why the prototype is served under `/proto/` on the existing hostname.
- Deployment template `deploy/notebook.service`; the older installed user unit is inactive and was not touched. The public hostname works only while `npm run dev` (or the API) is running.

## Open decisions for the user
- Join/create dialogs still explain sharing (`SHARING_NOTICE`). The library no longer mentions it. Remove the notice too?
- "New notebook" lives only in the long-press / right-click menus and is mentioned in empty states. Is that discoverable enough on a tablet, or add a second button next to "New folder"?
- Per-notebook "don't share this notebook" switch (privacy vs. how fast shared notes accumulate).
- Whether authors may force-share items the AI kept private (currently no, to avoid spreading misread math).
- Whether to commit, and under which identity. Whether to keep `proto/` in the repo after review.

## Known limits / suggested next steps
1. Tablet behaviour is verified only in emulation (Chromium touch events, iPad Pro 11 landscape/portrait), never on a physical iPad/Safari. Long-press timing (350 ms), Apple Pencil and dragging PDFs in from the Files app are untested.
2. Folders can't be moved or reordered (created, renamed, deleted only); no multi-select; no dragging a file across courses (blocked by design).
3. The sidebar shows only the open course's tree; other courses show the smart views without counts until opened.
4. Editor: text boxes and images can't be resized; no shape tool; no multi-device sync.
5. Handwriting crops use model-estimated boxes and are sometimes loose (seen on L3 slide 14).
6. Ask / fill-gap take seconds to a minute; no streaming or cancel. Merging a lecture on close costs one call per changed slide.
7. `restatesSlide` is a word-overlap heuristic (0.75); tune with real users.
8. **The knowledge base is only as good as the merge call.** Gap detection, grouping and contradiction judgement are single-shot model outputs with no human review; `disputed` entries hide from everyone on one model verdict. Watch for false disputes with real notes before trusting it on a class.
9. Entries are built per slide, so a point that spans slides becomes two entries; nothing merges across slides yet.
10. Leaving a notebook is the trigger for merging, so a student who never closes the tab (and whose sweep has not run) has notes that classmates cannot see yet.
11. Main JS bundle is ~600 kB (KaTeX + marked); code-split if load time matters. No favicon (harmless 404).
12. Human evaluation per the concept doc (8–12 students): is a quiet margin marker discoverable, do peers' summaries fill real gaps, is one model verdict on a "wrong" note acceptable, and does automatic non-reversible sharing feel honest?

## Code map
- `server/`: `app.ts` routes, enrollment/origin checks, asset authorization, folder + suggestions + close routes · `db.ts` SQLite store (folders, seeds, knowledge entries, gaps, topics), fragment-id reuse, supersession, migrations · `jobs.ts` slide digests, topics, page indexing with gap detection, merge/check, sweeps · `suggestions.ts` gaps → cards (peer → slide → AI) · `study.ts` Ask/fill-gap/Quiz with citation validation · `render.ts` page rendering/crops · `pdf.ts` poppler · `importer.ts` · `seed.ts` · `ai.ts` model gateway.
- `shared/`: types (`Folder`, `Deck`, `CourseFiles`, `KnowledgeEntry`, `Suggestion`, `OwnNote`, `LectureTopic`), ink geometry.
- `src/`: `App.tsx` routes (`#`, `#course=…&view=…&folder=…`, `#nb=`) and header slots · `Home.tsx` (Continue, courses, join/create dialogs, `Menu`, `Dialog`) · `Library.tsx` the file tree (sidebar, smart views, folders, decks, menus, drop-to-import, new-notebook dialog) · `gestures.ts` long-press/drag/file-drop hooks · `editor/` canvas, toolbar, page chrome, margin markers · `panel/Panel.tsx` `useSuggestions`, `MarginMarkers`, `SuggestionCard`, `LassoPopover`, `SuggestionsPanel` · `panel/SourceViewer.tsx` · `ui.ts` small hooks, storage migration, `lastLibrary`.
- `scripts/serve.mjs`: the supervisor behind `notebook.service`.
- `proto/library/index.html`: the reviewed static prototype of the earlier library (sample data, saves folders in localStorage).
- Tests: `tests/` (vitest, mock model), `e2e/` (Playwright + `mock-llm.mjs`).

