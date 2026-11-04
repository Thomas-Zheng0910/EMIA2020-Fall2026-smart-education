# Handoff · 4 November 2026

## Where things stand
Notebook v2 is a working local prototype of the concept doc (`docs/reference/original-concept.docx`): a Goodnotes-like course notebook whose notes are read by a multimodal model, linked to lecture slides, and shared with classmates as source-linked, unverified suggestions. It runs on live DeepSeek against the real COMP2211 material. The product is called **Notebook**; the UI, browser title, docs and new identifiers use that name only.

The latest pass replaced the course page with **Library v2**: a sidebar of courses → My notes (with folders) and Lectures, designed tablet-first. It was agreed with the user through a clickable prototype (`proto/library/`, served at `/proto/library/`) and then implemented end to end (see "Changes in this pass").

- Run: `npm run dev` → http://127.0.0.1:5173 (running in the background). The API on `:4310` also serves the built app from `dist/`. After server changes, restart it; the API does not hot-reload. The frontend uses polling (file-watch handles are exhausted on this workstation).
- Public host: https://notebook.zh-thomas.party → `:4310`, i.e. the **built** app. After client changes run `npm run build` for the public site to update (no API restart needed for client-only changes). `ALLOWED_ORIGINS=https://notebook.zh-thomas.party` is set in `.env` so writes from the public hostname are accepted.
- Verify: `npm run check` (21 unit/API tests + typecheck + build) and `npm run test:e2e` (8 browser scenarios, mock model). Both pass as of this handoff. The e2e run starts its own servers on `:5173`/`:4310`/`:4399`, so stop `npm run dev` first and restart it afterwards. Browser binary: `PLAYWRIGHT_CHROMIUM_EXECUTABLE=~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell`.
- Live smoke (costs API calls): `node scripts/live-smoke.mjs` against the running dev server.

## Read first
1. `AGENTS.md` — invariants (sharing, enrollment checks, no RAG, no fabricated AI output, annotations never re-shared) and the library layout rules.
2. `docs/superpowers/specs/2026-11-02-notebook-v2-design.md` — current design, including "Multiple courses" and "Library v2".
3. `docs/DESIGN_REVIEW.md` — the earlier human-centred review and its open decisions.
4. `docs/PROGRESS.md`, `docs/VALIDATION.md` — history and evidence.

## User decisions so far
- Rewrite allowed; Goodnotes/Notion-like UI; full ink editor.
- Official DeepSeek `deepseek-flash` (multimodal; no separate OCR); no RAG/embeddings.
- Course material: COMP2211 Flexcil export (zip in repo root, untracked).
- A student can take several courses; the front page lists my courses and each course is its own page.
- Agent may decide details and implement without staging.
- Product name is **Notebook**; do not reintroduce the old name in UI, docs, or new identifiers.
- Library (Nov 3), reached over several prototype rounds:
  - Follow how note apps (Goodnotes/Notability) organize: folders in a left sidebar, documents as covers on the right. Keep the launched site's visual style.
  - The top level is the **course**, which is not a folder: you join it, and it decides which classmates your notes connect with.
  - Inside a course: **My notes** first, then **Lectures**. Lecture slides are documents (PDFs), not folders.
  - Editing a slide creates a note: a lecture you wrote on appears in My notes.
  - Students can make their own folders (only inside My notes).
  - Do not show which notes classmates use, or sharing counts, in the library. "Sharing does not need to disclose."
  - No add buttons for notebooks / notes / slides: support dragging instead.
  - Tablet is the expected device; everything must work by touch.

## State of data
- `data/` (ignored): SQLite + rendered slides. 13 lectures / 636 slides digested. Alex owns `COMP2211 notes.pdf` (48 pages): 410 fragments, 207 shared, 178 private as "already on the slide", 9 hard to read, 16 lecture unclear. Thomas has written on L2 (2 slides); Priya has test scribbles. No folders exist in the real data (QA created and deleted a temporary one).
- Schema additions are applied automatically on start: `folders` table and `notebooks.folderId` (additive migration).
- Demo identities: Thomas, Alex, Priya; all enrolled in COMP2211. Identity travels as `x-student-id` header plus a `notebook_student` cookie (for images). Not authentication.
- Browser state: localStorage uses `notebook.*`; sessionStorage `notebook.lastLibrary.<course>` remembers where in a course the student was (closing a notebook returns there).
- Re-seed from scratch: delete `data/`, then `npm run seed -- "Flexcil PDFs 2026-11-01 23.58.58.zip"` (~25 min of live model calls). Another course: add `--code X --name "..."`.

## Changes in this pass (Nov 3–4)
- **Library v2** (`src/Library.tsx`):
  - Sidebar of enrolled courses (colour chip with the course number + name) → My notes (with nested folders) and Lectures; "Join a course" goes to the front page.
  - Course page: chip, name, description, classmate count, two tiles, and a "Manage sharing" link (the old review dialog, now the only course-level sharing UI).
  - My notes: notebooks and imported PDFs, plus lecture notebooks once written on ("From slides · N edited slides", cover = latest written page). Newest first.
  - Lectures: the official decks with real thumbnails, `PDF` badge, and a ✎ count when written on. Opening one opens the student's copy in the editor.
  - Breadcrumbs and the narrow-screen sidebar toggle are rendered into the app header through portals (`#lib-crumb-slot`, `#lib-toggle-slot`).
  - URLs: `#course=<id>&view=notes|lectures&folder=<id>`.
- **Touch-first gestures** (`src/gestures.ts`), the same for finger, Apple Pencil and mouse:
  - Long-press opens a menu (right-click with a mouse); long-press then drag moves a note onto a folder.
  - A finger that moves before the lift scrolls.
  - The click a browser sends after the finger lifts is swallowed, because the menu opens next to the finger.
  - Menus: New folder / New notebook / Rename / Delete folder / Open / Move to… / Delete notebook.
  - Dropped PDFs: onto Lectures → a lecture for the course; onto My notes or a folder → an imported notebook there. A hint shows the destination while dragging.
  - Touch screens get 42 px rows and an always-visible "+"; at ≤1000 px wide the sidebar slides over the content.
- **Server**:
  - `folders` table; `notebooks.folderId`.
  - Routes: `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id`. `PATCH /api/notebooks/:id` accepts `{folderId}`, and `POST /api/notebooks` / `POST /api/notebooks/import` accept an optional `folderId`.
  - Rules: folders are per student and course and invisible to others (404); require enrollment; notes can't move to another course's folder (400); deleting a folder moves its notebooks and subfolders up. Filing a notebook does not change its "edited" time.
  - The notebook list now includes `written` and `lastPageId`.
- **Other fixes**:
  - Unknown URLs returned 500: the SPA fallback called an undecorated `sendFile`, and now reads `dist/index.html` directly.
  - `/proto/<name>/` serves static design prototypes, registered only if `proto/` exists.
- **Tests**: a new API test for folders (nesting, moving, cross-student and cross-course isolation, delete-moves-up, leaving a course), giving 21 in total. e2e updated for the new UI (drop-to-import, menus, return-to-place), plus a new folders scenario (create, subfolder, Move to…, mouse drag to the sidebar, rename, delete, PDF dropped on a folder, privacy), giving 8 in total.
- **Docs**: `AGENTS.md` (sharing rule revised; library layout rules added), design spec "Library v2", `PROGRESS.md`, `VALIDATION.md`.

Earlier pass (Nov 2): rename to Notebook; course-isolation fixes when leaving a course; sharing review filters; dismissals survive re-indexing; confirmed lecture links re-index; mobile editor drawer; production static serving fix; 20 tests.

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
1. Library on real hardware: verified in emulated iPad Pro 11 (Chromium touch events, landscape and portrait), not on a physical iPad/Safari. Long-press timing (350 ms), Apple Pencil behaviour and dragging PDFs in from the Files app (Split View) are untested.
2. Folders can't be moved or reordered (only created, renamed, deleted); notebooks can't be multi-selected. No drag of a notebook across courses (blocked by design).
3. The sidebar shows only the open course's folders; other courses show My notes / Lectures without counts until opened.
4. Editor: text boxes and images can't be resized; no shape tool; no multi-device sync; ink only on pages.
5. Handwriting crops use model-estimated boxes and are sometimes loose or off-target (seen on L3 slide 14).
6. Explain/Quiz take seconds to a minute; no streaming or cancel.
7. `restatesSlide` is a word-overlap heuristic (threshold 0.75); tune with real users.
8. No conflict/dispute flow between classmates' notes beyond the model's `conflict` field in Explain; no "report" action.
9. Main JS bundle is ~600 kB (KaTeX + marked); code-split if load time matters. No favicon (harmless 404 in the console).
10. Human evaluation per the concept doc (8–12 students): does sharing feel acceptable, do peer notes help recover gaps, is the quiet panel discoverable, can students find "New notebook" and filing by long-press.

## Code map
- `server/`: `app.ts` routes, enrollment/origin checks, asset authorization, folder routes, `/proto/` static · `db.ts` SQLite store, folders, fragment-id reuse and migrations · `jobs.ts` slide digests, page indexing, sharing reasons, `restatesSlide` · `study.ts` Explain/Quiz with citation validation · `render.ts` page rendering/crops · `pdf.ts` poppler · `importer.ts` · `seed.ts` · `ai.ts` model gateway.
- `shared/`: types (incl. `Folder`, `Notebook.folderId/written/lastPageId`), ink geometry.
- `src/`: `App.tsx` routes (`#`, `#course=…&view=…&folder=…`, `#nb=`) and header slots · `Home.tsx` (Continue, courses, join/create dialogs, `Menu`, `Dialog`) · `Library.tsx` course library (sidebar, My notes/folders, Lectures, menus, drop-to-import, sharing review, new-notebook dialog) · `gestures.ts` long-press/drag/file-drop hooks · `editor/` canvas, toolbar, page chrome · `panel/` Classmates/Explain/Quiz, source viewer · `ui.ts` small hooks, storage migration, `lastLibrary`.
- `proto/library/index.html`: the reviewed static prototype (sample data, saves folders in localStorage).
- Tests: `tests/` (vitest, mock model), `e2e/` (Playwright + `mock-llm.mjs`).
