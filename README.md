# Notebook — a course notebook that quietly learns from your classmates

Take notes the way you already do: write on lecture slides with a pen or mouse, type, paste images, or import notes exported from Goodnotes/Flexcil. While you write, Notebook reads each page with a multimodal model and links it to the right lecture and slide. When you leave a notebook, the notes on its slides are merged into a shared **course knowledge base**: notes that make the same point become one summary, and a note that only one classmate wrote is kept verbatim.

Nobody sees a wall of other people's handwriting. A small marker appears beside the page where your own notes leave something out, and tapping it opens a card in place — what a classmate understood, what the slide says, or an explanation — with a neutral source line and no reliability labels. Nothing changes your notes unless you add it, and sharing is automatic: the demo deliberately has no "stop sharing".

![Classmate note beside a slide](docs/screenshots/classmate-note.png)

## Features

- **Courses first**: the front page lists all your courses (cover, lectures, notebooks, classmates, last edit) plus other courses to join, and lets you create one. Opening a course goes to its file tree (`#course=<id>`); the top bar shows `Notebook / COMP2211`, and leaving a notebook returns to where it was opened. Lectures, notebooks, the knowledge base and suggestions are all scoped to the course, and notes are only shared with students enrolled in it.
- **One free file tree per course**: folders anywhere, files moved by long-press/right-click (`Move to…`) or drag, and two ordinary starting folders, **Lectures** and **Quizzes**, which you can rename or delete. **My notes** (files you have written on) and **All files** are smart views above the tree, not folders. Official decks are ordinary files: they keep their `L#` and `PDF` badge and a ✎ count wherever they are filed, and opening one is what creates your own copy.
- **Notebook editor**: pressure-sensitive pen, highlighter, stroke eraser, lasso (select, move, delete, explain), text boxes, images, undo/redo, zoom, stylus-only mode for tablets, page thumbnails, insert pages after any slide, autosave with revision checks.
- **Course knowledge base**: shortly after you leave a notebook, its slides' notes are grouped into points of knowledge, with an AI-written summary per group; a single classmate's note is shown verbatim, never rewritten. Sources are never listed — cards say *From 3 classmates' notes*, *From slide 12*, or *AI explanation*. A note that contradicts the slide is excluded from every prompt and suggestion, and its author sees why.
- **Automatic sharing, no controls**: joining or creating a course explains that notes are shared, and there is deliberately no Stop sharing or Manage sharing in the demo. Items the model could not read or link stay private, with the reason shown to their author.
- **Inline suggestions**: a small marker appears beside the page where something is missing; tapping it opens a card in place, with *Add to my notes* (a separate sticky note) and *Dismiss* (remembered), plus *Not helpful* and *Looks wrong* (which rechecks the note and hides it while that is decided). Nothing covers the page, and the panel stays closed unless you open it.
- **Circle to ask**: lasso a part and get a popover beside it with *Explain*, *Example*, *Why?* chips and an optional typed question; the answer appears in the same popover with its sources.
- **Quiz me** is a future plan, not part of the demo (see [Future plan](#future-plan-quiz-me)).

No retrieval index: a lecture's slide digests and its knowledge-base entries fit easily in DeepSeek's 1M-token context window, so each request sends the whole lecture context. See `docs/superpowers/specs/2026-11-04-knowledge-base-inline-suggestions.md` (current) and `2026-11-02-notebook-v2-design.md` (editor).

## Run

Requires Node ≥ 24 and poppler-utils (`pdftoppm`, `pdftotext`, `pdfinfo`).

```bash
npm ci
cp .env.example .env          # set LLM_API_KEY (official DeepSeek, model deepseek-flash)
npm run seed -- "Flexcil PDFs 2026-11-01 23.58.58.zip"   # or a folder of PDFs
npm run dev                   # http://127.0.0.1:5173
```

To add another course: `npm run seed -- <folder-or-zip> --code COMP3311 --name "Database Management Systems"` (files named `N-title.pdf` become lecture N; `*notes.pdf` becomes Alex's notebook), or create it in the app and add lecture PDFs there.

The seed imports `N-*-full.pdf` lectures and `supp-model-evaluation-full.pdf`, digests every slide with the model, and imports `COMP2211 notes.pdf` as **Alex's** handwritten notebook (indexed and shared). Switch the demo student at the top right: **Thomas** (you), **Alex** (has notes), **Priya** (empty). Demo identities are not authentication; the server binds to loopback.

Production: `npm run build && npm start` serves the built app on port 4310. `npm run serve` does the same but watches: server edits restart the API and client edits rebuild `dist/`, which is how the hosted demo stays current without a deploy step. `npm run dev:local` (4312/5174) keeps a dev server out of the way of one already on 4310.

The knowledge base fills itself in: leave a notebook (or wait for the 10-minute sweep) and that lecture's slides are merged, one model call per changed slide. On a freshly seeded database suggestions start from the slides alone until somebody's notes have been merged.

## Test

```bash
npm run check                 # unit/API tests (mock model) + typecheck + production build
npm run test:e2e              # Playwright, with a deterministic mock OpenAI server (never calls the live API)
node scripts/live-smoke.mjs   # optional: real DeepSeek smoke run against a running dev server with seeded data
```

If the default Playwright browser is missing, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a cached Chromium (e.g. `~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell`) or run `npx playwright install chromium`.

Current: 22 unit/API tests and 10 browser scenarios. Both suites use the mock model, so they prove transport and control flow, never model quality.

## Layout

- `server/` — Fastify API (`app.ts`), SQLite store with the knowledge base, gaps and topic tables (`db.ts`), model gateway (`ai.ts`), PDF rendering (`pdf.ts`), page rendering/cropping (`render.ts`), background jobs: digests, topics, indexing with gap detection, merge-and-check, sweeps (`jobs.ts`), a page's gaps resolved to cards (`suggestions.ts`), Ask / fill-gap / Quiz with citation validation (`study.ts`), imports (`importer.ts`), seed CLI (`seed.ts`).
- `shared/` — types (`Folder`, `Deck`, `CourseFiles`, `KnowledgeEntry`, `Suggestion`, `OwnNote`, `LectureTopic`) and ink geometry (perfect-freehand), used by both client and server.
- `src/` — React app: `Library.tsx` (the file tree), `editor/` (Editor, PageView, Toolbar, PageChrome, margin markers), `panel/` (`Panel.tsx`: suggestions list, inline card, lasso popover; `SourceViewer.tsx`), `gestures.ts` (long-press, drag, file drop).
- `scripts/serve.mjs` — the supervisor behind `npm run serve`; restarts the service if the API stops answering.

## Future plan: Quiz me

Agreed with the user on 4 Nov 2026. **Not part of the demo.** The demo focuses on the course file tree, the shared course knowledge base and inline suggestions. Quiz me will be built later and leaves the study panel.

The `POST /api/quizzes` and `/api/quizzes/:id/grade` routes are still in place (and tested), so the future UI has something to call, but no screen in the demo reaches them.

- **Entry**: a shortcut in the editor (circle a part → "Quiz me on this", or a header button) opens a quiz builder for the course. It is not a tab in the study panel.
- **Material**: the student picks any files in the course: lecture PDFs (official slides), their own notebooks or pages, imported PDFs, and earlier quiz results. Only the picked files are used; classmates' knowledge is not added automatically.
- **Grounding**: questions are built only from the picked files. Every correct answer must cite one of the supplied materials (validated server-side); uncited questions are dropped. All sources count equally: if a note disagrees with a slide, the quiz tests what the files say. This replaces the earlier rule (still enforced by the current routes) that answers must be supported by an official slide.
- **Question types**: multiple choice (graded locally) and short answer (typed), graded by the model against the cited material, with feedback on what is missing.
- **Flow**: choose how many questions; answer one at a time with immediate feedback and source links.
- **Results are files**: each quiz session is saved automatically in the course's **Quizzes** folder (an ordinary folder, so students can rename, move or delete it). Internally it is stored in a format the model can read (so a past quiz can be material for a new one); in the library the student opens it to review the session: questions, their answers, score and feedback.
- **Memory**: attempts are kept; per-topic results support "Retry my mistakes" and weak-spot quizzes. Topics come from the lecture topic index.
- **Depends on**: the course file tree (with its Lectures and Quizzes folders) and the lecture topic index — both built; topics are on every lecture payload.
- **Still open**: whether a retake adds an attempt to the same quiz file or creates a new one, and how per-topic progress is shown.

## Limits

- **The knowledge base is one model's judgement, unreviewed.** Grouping notes into a point, summarising them, and deciding that a note contradicts the slide are all single-shot outputs. A "Looks wrong" report hides an entry from every student on that verdict alone, so false disputes are the risk to watch before this meets a real class.
- Entries are built per slide, so one idea spread across slides becomes two of them.
- Merging happens when a student leaves a notebook (or on the 10-minute sweep), so a tab left open is not visible to classmates yet.
- Model quality (handwriting transcription, slide linking, gap detection, explanations) has been spot-checked on the real COMP2211 material, not evaluated with students. Tablet behaviour is verified only in browser emulation, never on a physical iPad.
- Single-machine SQLite, no auth, no multi-device sync, no LMS integration. The demo shares notes automatically and does not let a student stop sharing; author control returns in the future plan.
