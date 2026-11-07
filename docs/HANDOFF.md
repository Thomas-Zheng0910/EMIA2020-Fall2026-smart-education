# Handoff · 4 November 2026

## Where things stand
Notebook v2 is a working local prototype of the concept doc (`docs/reference/original-concept.docx`): a Goodnotes-like course notebook whose notes are read by a multimodal model, linked to lecture slides, distilled into a shared course knowledge base, and offered to classmates as quiet, source-linked suggestions. It runs on live DeepSeek against the real COMP2211 material. The product is called **Notebook**; the UI, browser title, docs and new identifiers use that name only.

The 4 Nov pass implemented the **knowledge base and inline suggestions** spec end to end: the file tree (phase 1), then the shared course knowledge base, inline suggestions, the slim panel and topics (phases 2–5). Notes are no longer shown to classmates as raw fragments; they are merged into `knowledge_entries` per slide, and a student meets them as a quiet margin marker beside the gap they fill. The 5 Nov pass split the panel into **Ask** and **Suggestions**: Ask is a persisted conversation with sessions and history; suggestions are their own tab with This page / Whole notebook scopes, and adding to another page no longer moves the page being read.

- Run: `npm run dev` → http://127.0.0.1:5173. Both halves watch: Vite rebuilds the client, `tsx watch` restarts the API. Use `npm run dev:local` (4312/5174) when the public service already holds 4310.
- Public host: https://notebook.zh-thomas.party → `:4310`, served by `notebook.service` running `npm run serve` (watch + rebuild). **An edit here is live on the public page within seconds — no build, no restart.** Restart the service only after editing `.env`, which `tsx watch` does not reload.
- Verify: `npm run check` (37 unit/API tests + typecheck + build) and `npm run test:e2e` (19 browser scenarios, mock model). Both pass as of this handoff. The e2e run uses its own ports, so it runs alongside the service.
- Live smoke (costs API calls): `node scripts/live-smoke.mjs` against the running server.

## Read first
1. `AGENTS.md` — invariants (sharing, enrollment checks, no RAG, no fabricated AI output, annotations never re-shared) and the library layout rules.
2. `docs/superpowers/specs/2026-11-04-knowledge-base-inline-suggestions.md` — knowledge base, inline suggestions, file tree. `2026-11-02-notebook-v2-design.md` covers the editor. `2026-11-05-sharing-live-and-group-notes.md` covers the named sharing modes, the seeded professor, group notes and the live handout; those three are current where they disagree with earlier specs.
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
- Named sharing (Nov 5): direct shares are raw and named, separate from the anonymous AI bank; a copy is editable and pullable or a snapshot; live is a professor session that ends into a copy; group notes are co-owned and editable by every member; no revoke, no forwarding action, no cross-course shares. The professor is a seeded demo account, not authentication.

## State of data
- `data/` (ignored): SQLite + rendered slides. 13 lectures / 636 slides digested. Alex owns `COMP2211 notes.pdf` (48 pages): 410 fragments, 207 shared, 178 private as "already on the slide", 9 hard to read, 16 lecture unclear. Thomas has written on L2 (2 slides); Priya has test scribbles. Every student now has the two seeded folders (Lectures holding the 13 decks, Quizzes empty) — `course_seeds` records them so renames and deletions stick.
- Schema additions are applied automatically on start, all additive: `folders` + `notebooks.folderId`; `course_seeds`; and for the knowledge base `knowledge_entries`, `entry_sources`, `lecture_topics`, `page_gaps`, `gap_dismissals`, `entry_reports`, `slide_merges`, `gap_checks`, plus `fragments.entryId` and `fragments.supersededBy`; and for Ask conversations `ask_sessions` + `ask_messages`. The sharing pass adds `students.role`, `enrollments.role`, `notebooks.revision/shareId/sourceNotebookId/sourceRevision/shareMode/deletedSourcePages`, `pages.origin/sourcePageId/sourceRevision/sharedTombstones`, `course_seeds.sharedId`, `notebook_members`, `notebook_presence`, `shares` and `live_sessions`. The seeded **Professor** is enrolled as instructor of COMP2211 on upgrade.
- **After upgrading, knowledge entries only exist for slides somebody has merged.** Leave a notebook (or wait for the 10-minute sweep) to populate them; until then suggestions fall back to the official slide.
- Demo identities: Thomas, Alex, Priya and **Professor**; all enrolled in COMP2211 (Professor as instructor). Identity travels as `x-student-id` header plus a `notebook_student` cookie (for images). Not authentication.
- Browser state: localStorage uses `notebook.*`; sessionStorage `notebook.lastLibrary.<course>` remembers where in a course the student was (closing a notebook returns there).
- Re-seed from scratch: delete `data/`, then `npm run seed -- "Flexcil PDFs 2026-11-01 23.58.58.zip"` (~25 min of live model calls). Another course: add `--code X --name "..."`.

## Changes in this pass (Nov 5, sharing, live and group notes)

User direction: extend the course notebook with named sharing that is separate from the anonymous AI bank. Direct sharing is raw and named; a note can be an editable copy, a professor's live handout, or a co-owned group note. No revoke, no forwarding action, no cross-course shares. The professor is a seeded demo account called **Professor**; no registration or real auth.

- **Roles.** `students.role` and `enrollments.role` are additive. Only a professor account can create a course; the creator is its instructor. Only an instructor can add official slides, change the course, re-digest slides or go live. Instructors are excluded from classmate counts, peer-note counts and the AI bank. The demo switcher lists Professor; the course page says "students" for an instructor.
- **Send a copy.** `POST /api/notebooks/:id/share` sends a whole notebook or one page to one or more classmates (or the whole class from an instructor). The recipient gets an editable `kind='shared'` notebook in a loose **Shared with me** folder (created on the first copy; ordinary afterwards). The sender chooses **pullable** or **snapshot**. The sender's original is untouched; there is no revoke. A received copy shows a "From … · Pullable/Snapshot" banner, can fetch source changes (`POST /fetch`) and can be detached to a snapshot (`POST /detach`). Re-sharing the copy is a new share.
- **Live handout.** An instructor can start a live session from their own notebook (`POST /api/notebooks/:id/live`). Students get a live pill and a read-only viewer that follows the current page and refreshes every 2 s. Ending the session (`POST /api/live/:id/end`) creates a copy for every enrolled student, using the same copy machinery and the pullable/snapshot choice made at start. A copy already received from the same source is updated in place, preserving the recipient's own writing.
- **Group notes.** `POST /api/notebooks/:id/invite` turns a standalone or received note into one co-owned note (`kind='group'`) and invites classmates. Invitees get a Join / Not now popup; `notebook_members` stores owner/editor and invited/active status. The note lives in every member's My notes with a Group badge; each member has their own folder. A note can be left by an editor or the owner can remove members; only the owner can delete it. Lecture notebooks cannot be joined because of the one-per-student-per-lecture rule.
- **Collaboration.** Object-level three-way merge, not a page lock and not real-time. The client sends the last server state it saw (`base`) plus the current page; the server merges by object id (local unchanged follows the server, local changed wins, local delete wins). Per-user undo restores only the editor's own objects. Presence is an avatar stack plus page tooltips, polled every 5 s; pages poll every 2.5 s. No cursors, WebSocket or CRDT.
- **AI bank isolation.** Direct shares, group notes and professor notebooks are not ingested. A received copy contributes only the recipient's `origin='own'` additions on slide-anchored pages; the shared layer is removed from the render and the hash. Group notes and professor notebooks are skipped by the index job. The anonymous bank still never names a classmate; direct shares do.
- **Handwriting input.** The index job now sends two images: the page for context and a white-background ink-only render for transcription. This is the local "improver" — the vector strokes, not a learned model. For a received copy, the ink-only image contains only the recipient's own strokes.
- **Schema/API.** Additive `students.role`, `enrollments.role`, `notebooks.revision/shareId/sourceNotebookId/sourceRevision/shareMode/deletedSourcePages`, `pages.origin/sourcePageId/sourceRevision/sharedTombstones`, `course_seeds.sharedId`, plus `notebook_members`, `notebook_presence`, `shares`, `live_sessions`. New client: `ShareDialog`, `NoticeCenter`, `LiveViewer`; new server module `server/shares.ts`.
- **Verification.** `npm run check`: 37 unit/API tests pass, typecheck and production build. `npm run test:e2e`: 19 browser scenarios pass, including a named copy arriving and becoming a group note, and a professor live handout ending in a student copy. Mock provider only.

Known limits of this pass: no true real-time co-editing or cursors; simultaneous typing in one text box is last-write-wins; no revoke or forwarding; no live-session timeout if the host disappears; no learned OCR/enhancement model; PDF backgrounds are copied per received copy; a group note is not in the AI bank. A pull refreshes ink/items but not page paper/background/link changes; a failed PDF background copy is logged and leaves a blank page. Live end retries are per-session, not a durable per-recipient job.

## Walkthrough fixes (Nov 6)

An independent static review and a hands-on walkthrough in a temporary database found real problems in the first sharing pass. Fixed in this follow-up:

- **Stale Home over the Library.** The new `NoticeCenter` used the same React key (`student`) as `Home`, so navigating Home → course left the old Home and its modal in the DOM. It blocked the course page and looked like a broken create-course dialog. `NoticeCenter` is now keyed `notices:<student>`.
- **Live authorization and finalization.** `PATCH /api/live/:id` now accepts only pages of the host's notebook; `page.png` is 404 after the session ends. Ending live saves the host's pending page first and only marks the session ended after every student's copy is written (retryable, not one-shot). Deleting the host notebook or leaving the course finalizes the handout the same way.
- **Group copy provenance.** Inviting a received copy detaches it from the original source and freezes any old pullable copies of a note that becomes a group note. A source page disappears only if the recipient had no own **or locally edited** objects on it.
- **Group privacy and merge.** Group notes return no AI suggestions and `/shared` returns only the viewer's fragments; per-user undo refuses to overwrite a classmate's newer object; group page deletion propagates; saves made while a save is in flight are rebased on the merged server page instead of resurrecting erased objects; a deleted page is dropped on 404; 409 stops retrying.
- **AI-bank cleanup.** Inviting a note retires its fragments and excludes affected entries synchronously; forced merges queue behind an in-flight one; merges and indexes re-check group/instructor status and source set after every await; re-indexing unchanged notes restores `entry_sources`; deleting a page/notebook rebuilds its slides.
- **Security and roles.** Uploaded images require the uploader or a page the viewer can access; share/invite recipients must be students; the seeded Professor is repaired as instructor after leave/rejoin; a group owner leaving a course hands the note to an enrolled editor; PDF/group backgrounds are readable by members.
- **Editor reliability.** Text/memo drafts survive re-renders; `saveAll` waits for in-flight writes; `PageChrome` allows deleting a copied slide page; group members open “Members & invites” on the Members tab; “Later” no longer marks a copy as read; closing an invitation no longer declines it.

Verification after the walkthrough: `npm run check` (37 unit/API tests, typecheck, build) and `npm run test:e2e` (19 browser scenarios) pass. The production bundle was rebuilt and the public service is serving it.

## Changes in this pass (Nov 5, ask and suggestions)

User direction: make Ask like VS Code Copilot Chat, keep suggestions on their own tab, and do not move the page when adding a suggestion to another page.

- **Ask / Suggestions tabs.** The panel header is **Notebook**; the tabs are **Ask** and **Suggestions**. The old "This page" tab mixed an ask box with the page's suggestions; suggestions now live only under Suggestions, with **This page / Whole notebook** as its scope. The page's own notes stay under This page.
- **Ask is a conversation.** `ask_sessions` + `ask_messages` (additive schema) store a thread per student and notebook. The panel opens the latest session; **History** lists every session with its time, message count and last page; **New chat** starts a draft. The composer sends Enter (Shift+Enter for a newline); quick questions appear only before the first message. Each user message records the page it was asked on, so one session can span pages. `POST /api/ask` now returns `sessionId`, `questionMessage` and `message`; `GET /api/notebooks/:id/ask/sessions` and `GET /api/ask/sessions/:id` read history. A lasso ask (a `bbox`) stays ephemeral and does not pollute the panel's history.
- **Adding a suggestion does not navigate.** `Add to that page` in the notebook browser merges on the target page and keeps the current page and scroll position; `Go to page` is the separate action. The e2e suite asserts the active page does not change after adding from another page.
- **Text box fix.** Typed text and memos were only committed on blur; leaving via Back or closing the tab while the box was focused could save the empty box. The page item is now updated as the student types (still one undoable page save via the normal flush), so autosave/Back persist the real text. A regression test types, goes straight Back, reopens, and expects the text.

Verification: `npm run check` (23 unit/API + typecheck + build) and `npm run test:e2e` (17 scenarios) pass. New coverage: sessions/history and ownership; adding from the browser keeps the page; leaving while a text box is focused keeps the text.

## Changes in this pass (Nov 5, visual)

User: "the UI is still pretty ugly". Direction: **a desk, not a dashboard** — warm paper and ink, one strong heading weight, quiet chrome. The existing Inter/system font stack is kept: no webfont and no font files. Palette moved to paper cream + slate ink (`--bg/--surface/--accent` in `src/styles.css`), with a final "visual pass" layer rather than a rewrite. Toolbar glyphs are now lucide icons. Course cards use a typographic course plate instead of a slide screenshot; notebook covers carry their title on the paper; decks are 16:10 previews with L#/PDF/ink badges along the bottom; Home's Continue cards are compact rows. Editor header, thumbnails, page chrome, Ask panel and dialogs restyled.

Two bugs surfaced while looking at real screens: `LazyPage`'s IntersectionObserver missed its first callback at phone width, so pages stayed blank until a scroll (now it checks the initial rect); and at tablet width the library grid still used the touch rule's 300px sidebar column, squeezing the content into it (the narrow-screen rule now wins).

Verification: `npm run check` and all 16 e2e scenarios pass. Before/after screenshots at 1440, 834 and 390 widths are in `.oil-ui/ui-polish/shots/`.

## Changes in this pass (Nov 4, note-writing and suggestions)

The user's complaint was that the writing experience and the suggestions still felt unnatural: how a notebook is created, whether the paper suits handwriting or typing, how a suggestion merges into a note, and what "memo paper" would even be.

### Fixed: adding a suggestion never saved
`addAnnotation` sent `source: 'peer'|'slide'|'ai'` while the server's schema required `basis: 'official'|'peer'|'ai'`, and it passed `{kind:'entry'}` citations that `CitationZ` did not know. Every classmate or slide suggestion was rejected on save and silently lost on reload; only "AI explanation" cards persisted (they happened to use `'ai'`). The e2e test passed because it asserted the annotation on screen from the optimistic local render and never reloaded. The item schema is now `source: 'peer'|'slide'|'ai'` on both sides (the client already rendered `it.source`), `CitationZ` knows entries, and the e2e test reloads and asserts the note is still there.

### Paper: a notebook is made from paper
- **`src/paper.ts`** describes the four papers once — size, rule spacing, writing column, and what each is for: Lined (handwriting), Memo (one thought per small sticky sheet), Grid (equations, diagrams), Plain (typing, pasting). The creation dialog, editor, thumbnails and the server's renderer all read from it.
- **`New notebook` is a button** beside `New folder` in the library header, with the paper cards labelled and each showing a sample of its real ruling. The long-press / right-click path stays for tablets.
- **`notebooks.paper`** (additive column) is the default for new pages, so a memo notebook keeps making memo sheets instead of silently reverting to ruled. `PATCH /api/notebooks/:id/paper` changes it; `PATCH /api/pages/:id/paper` re-papers one sheet, keeping its strokes and items.
- **Memo sheets are real sheets**: 720×720, warm tint, faint rules, drawn smaller on screen than a page (they are a smaller sheet) and shown as a memo cover in the library.
- Typed text is written **on** the paper: on a ruled or memo page a new text box starts inside the writing column, snaps to a rule, takes the column's width and grows downward; it has a drag handle to widen. Page rendering uses the same line height so the PNG sent to the model matches the screen.

### Suggestions: a tab, a card beside the sheet, a quoted merge
- The margin dot became a **small numbered tab** at the gap, coloured by source (orange classmate, blue slide), so the panel and the page refer to the same suggestion.
- The card **opens beside the sheet**, in room the canvas makes for it by narrowing the page; near the window edge it tucks in, and on a tablet in portrait it drops below the sheet. It no longer covers the slide the student is comparing against.
- The card leads with **the gap in the student's own words** ("The step after the gradient."), then the content, with the neutral credit line at the bottom.
- **"Add beside my notes" merges into the page**: the text becomes a quoted note in the page's writing column, below the student's own ink and below anything already there, with the gap it answers as its heading. It stays a separate `annotation` item (never rewritten ink, never re-indexed), but it is draggable, editable, undoable and saved like anything else on the page.

### Verification
`npm run check` (22 unit/API + typecheck + build) and `npm run test:e2e` (11 scenarios) pass. The e2e suite gained two checks that would have caught the old bugs: the added suggestion survives a reload, and a memo notebook keeps making memo pages (and one sheet can be re-papered without losing content).

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
- ~~"New notebook" lives only in the long-press / right-click menus.~~ Resolved Nov 4: it is now a button beside "New folder"; the menus still offer it.
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
- `server/`: `app.ts` routes, enrollment/origin checks, asset authorization, folder + sharing + live + suggestions + close routes · `db.ts` SQLite store (roles, folders, seeds, knowledge entries, gaps, topics, shares, live sessions, members), fragment-id reuse, supersession, migrations · `shares.ts` copy creation, pull merge and local-edit preservation · `jobs.ts` slide digests, topics, page indexing with gap detection, merge/check, sweeps · `suggestions.ts` gaps → cards (peer → slide → AI) · `study.ts` Ask/fill-gap/Quiz with citation validation · `render.ts` page, ink-only and crop renders · `pdf.ts` poppler · `importer.ts` · `seed.ts` · `ai.ts` model gateway.
- `shared/`: types (`Folder`, `Deck`, `CourseFiles`, `KnowledgeEntry`, `Suggestion`, `OwnNote`, `LectureTopic`), ink geometry.
- `src/`: `App.tsx` routes (`#`, `#course=…&view=…&folder=…`, `#nb=`) and header slots · `Home.tsx` (Continue, courses, join/create dialogs, `Menu`, `Dialog`) · `Library.tsx` the file tree (sidebar, smart views, folders, decks, menus, drop-to-import, new-notebook dialog, share action) · `ShareDialog.tsx` send a copy / co-edit invite / go live · `NoticeCenter.tsx` received-copy and invitation popups, live pill · `LiveViewer.tsx` read-only live page · `gestures.ts` long-press/drag/file-drop hooks · `editor/` canvas, toolbar, page chrome, margin markers, group presence/sync · `panel/Panel.tsx` `useSuggestions`, `MarginMarkers`, `SuggestionCard`, `LassoPopover`, `SuggestionsPanel` · `panel/SourceViewer.tsx` · `ui.ts` small hooks, storage migration, `lastLibrary`.
- `scripts/serve.mjs`: the supervisor behind `notebook.service`.
- `proto/library/index.html`: the reviewed static prototype of the earlier library (sample data, saves folders in localStorage).
- Tests: `tests/` (vitest, mock model), `e2e/` (Playwright + `mock-llm.mjs`).

