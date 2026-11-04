# Knowledge Base and Inline Suggestions — 4 November 2026

**Status:** Agreed with user. Redesigns the Classmates/Explain panel and implements the concept doc's "course knowledge base". Quiz me becomes a future plan.

Supersedes for this pass: the Library v2 section of the 2026-11-02 design, and the "sharing must stay reversible" rule in `AGENTS.md` (see "Reversed decision: author stop-sharing" below).

## User decisions (4 Nov)

1. **Course knowledge base:** implement the concept doc's shared topic-level index with AI-written summaries, duplicate grouping, contradiction detection and version history.
2. **No embeddings:** the model reads each slide's notes and groups/checks them in one background call. No embedding provider.
3. **Summaries, not originals:** each group shows an AI-written summary that keeps the original meaning. Single-source entries show the original text verbatim. Sources are not listed in the card; they are tracked internally.
4. **No reliability labels:** drop "unverified" and basis labels (Official slides / From classmates / AI interpretation). Cards carry a neutral source line instead.
5. **AI judges wrong notes:** notes judged wrong are excluded silently from summaries, suggestions, Explain and Quiz prompts. The author gets a marker on their own page explaining the conflict, and an entry in the panel list. Editing the note triggers a recheck.
6. **No classmate names on suggestions:** sources show "A classmate's note" with the handwriting crop, no name.
7. **Inline suggestions:** after the student pauses, a margin marker appears at each gap; tapping it opens a card in place. Suggestions draw on classmates' notes, the slides and the AI's own knowledge.
8. **Circle to ask:** lasso/circle a part → a popover next to it with Explain/Example/Why? chips plus an optional typed question. The answer appears in the same popover.
9. **Slim side panel:** a list of this page's suggestions, closed by default. The current Quiz me tab is removed.
10. **Course file tree:** one free tree per course. Students own everything, including the lecture decks: they can create folders anywhere, move and rename anything. The fixed "My notes"/"Lectures" sections go away.
11. **Quiz me is future:** see `README.md` "Future plan: Quiz me". Removed from the side panel in this pass.
12. **No stop-sharing in the demo** (decision 4 Nov, immediately before implementation): sharing is automatic and not reversible by the student. See "Reversed decision" below.
13. **The merge/check job runs when the student leaves the notebook** (closes it), not on a timer alone.

## Reversed decision: author stop-sharing

Earlier passes made sharing reversible: a "Stop sharing" control on every item, remembered across re-indexing (`withheld` table), plus "Manage sharing" per course. The user decided on 4 Nov that **the demo does not give students the ability to stop sharing**: notes are shared as part of using the platform.

What this means in code:

- No "Stop sharing"/"Share again" control anywhere; no "Manage sharing" entry on the course page; no withheld items in the panel.
- `POST /api/fragments/:id/sharing` and `GET /api/courses/:id/sharing` are removed, along with the `setWithheld` writer and the `withheld` table's writes. `fragments.reason='withheld'` can no longer occur.
- The remaining privacy reasons stay: `unclear`, `unlinked`, `on_slide`. Items the AI keeps private because it could not read or link them stay private, as now.
- The `withheld` table and reason are left in place, unused, so the control can return without a migration. Their tests move to "dormant behaviour" rather than being deleted.
- `AGENTS.md`'s "Sharing must stay reversible" rule is replaced for this pass by: sharing is automatic and not user-reversible; the AI's privacy reasons are the only thing that keeps an item private; the future plan restores author control.
- The join/create dialogs keep explaining **that** notes are shared (disclosure still matters, more so now that it cannot be undone).

## Product changes

### Course file tree (replaces the Library v2 sidebar)

Library v2 fixed the structure: **My notes** (your notebooks, with folders) and **Lectures** (official decks). This becomes one free tree.

- **Course sidebar:** enrolled courses → the course's tree. At course creation two *ordinary* folders are seeded: **Lectures** (filled with the official decks) and **Quizzes** (empty; future quiz sessions go here). They have no special type: a student can rename, delete or move them like any folder, and can move a lecture deck into a folder of their own. Deleting a folder still moves its contents up.
- **Smart views** above the tree: **My notes** (files you have written on, newest first) and **All files**. These are filters, not folders, and never block moving anything.
- Official decks stay identifiable by their own record (`notebooks.kind='lecture'`, `lectureId`), not by their folder: they keep the `L#` / `PDF` badge and a ✎ count wherever they are filed, and opening one still opens the student's copy in the editor.
- Long-press / right-click menus as today: New folder / New notebook / Rename / Delete folder / Open / Move to… / Delete notebook.
- "New folder" is available at the tree root and inside any folder.
- URLs: `#course=<id>&folder=<id>` for a folder, `&view=notes|all` for the smart views. Leaving a notebook returns to where it was opened.
- No new folder type is needed, so no schema change: `folders` keeps its current shape.

### Shared course knowledge base

**Data model:**

- `knowledge_entries(id, courseId, lectureId, slideId, title, summary, createdAt, updatedAt, checkedAt, excludedReason, disputeExplanation)` — one row per point of knowledge. `excludedReason='disputed'` when the AI judges it wrong; excluded entries stay out of suggestions, Ask and Quiz prompts.
- `entry_sources(entryId, fragmentId)` — which fragments feed an entry. Needed to rebuild a summary when a source is superseded, and for the single-source rule.
- `fragments` gains `entryId` (nullable) and `supersededBy` (nullable → the fragment that replaced it on re-indexing).
- `lecture_topics(id, courseId, lectureId, name, slideIds)` — 5–15 named topics per lecture, built from the slide digests. `slideIds` is a JSON array. Used by coverage views and the future Quiz me topic scope.

**Entry lifecycle:**

1. Page indexing runs as today (6 s after the last stroke): fragments are extracted, linked, and marked shared or private.
2. A new shared fragment is written with `entryId=NULL` and is visible to classmates as a single-source entry (its own text, verbatim) until the next merge. This is how new notes reach classmates without waiting.
3. The **merge and check** job runs for the slides of a notebook when the student leaves that notebook (see "When merge and check runs"). Per slide it:
   - sends the slide digest, the existing entries for that slide (with their source fragment texts) and the new or changed fragments;
   - groups fragments that make the same point, writes a title and a 2–4 sentence summary per group, assigns every fragment to an entry, and marks contradictions (against an entry, or against the slide);
   - uses one source's text verbatim for single-source entries; writes a summary only for groups of two or more;
   - marks entries that contradict the slide as `excludedReason='disputed'` with a one-line explanation;
   - keeps existing entry ids where the point is unchanged, so nothing flickers.
4. A re-indexed page whose fragment text changed: the old fragment gets `supersededBy`, stops being shared, and the new one takes its place in `entry_sources`. The entry's summary is rebuilt at the next merge. Citations already in a classmate's annotation still resolve to the old fragment and open with "since updated by the author".
5. Reported entries are rechecked immediately, outside the merge schedule.

**Merge and check prompt (per slide):**

```
SLIDE: [title, summary, formulas, full text]

EXISTING ENTRIES:
[{id, title, summary, sources: [{fragmentId, text}]}]

NEW OR CHANGED FRAGMENTS:
[{fragmentId, kind, text, topic, confidence}]

TASK:
1. Group fragments that make the same point, even if worded differently.
2. For each group write a title (5-8 words) and a summary (2-4 sentences, LaTeX for math) that keeps the original meaning completely. Never add details no source states.
3. Assign every fragment to an entry, reusing existing ids when the point is unchanged.
4. Mark whichever applies: complements <entryId>, contradicts <entryId>, contradicts "slide".
5. A group with one source uses that source's text verbatim as the summary.
6. When a fragment contradicts the official slide, give a one-sentence explanation of the mismatch.

Return: {entries: [{id?, title, summary, fragmentIds, complements?, contradicts?, disputeExplanation?}]}
```

**Lecture topics (once per lecture, after its slides are digested):**

```
LECTURE: [number, title]
SLIDES: [{page, title, topics}]
TASK: Name 5-15 topics that cover this lecture, each spanning one or more slides.
Return: {topics: [{name, slidePages: [int]}]}
```

### When merge and check runs

The user's rule: **closing the notebook is the moment the update is uploaded.**

- The editor calls `POST /api/notebooks/:id/close` when the student leaves the notebook (route change, back to the library, tab close via `sendBeacon`/`keepalive`, and a periodic flush while the tab is hidden).
- The server marks the notebook's slides dirty and queues the merge for those slides, batched to one call per lecture.
- A periodic sweep (every 10 minutes) picks up slides left dirty by a client that never closed cleanly, so nothing is stranded. This is the production behaviour; the close signal only makes it prompt.
- Unchanged slides are skipped by a hash of their source notes, so a student who closes a notebook without writing costs nothing. Half-finished notes therefore aren't judged until the student actually leaves.
- A report on an entry, or an edit to a disputed note, triggers a recheck of that entry immediately.

### Inline suggestions

**When:**

- After a pause in writing (~10 s since the last stroke, tuned by feel rather than fixed), the page-indexing call also identifies gaps. This replaces the current 6 s delay; it is the same number of calls.
- Opening a page whose slides have gained or changed entries since its last gap check runs one gap check (lazy, once per open, only if changed).

**Gap detection (added to the page-indexing call, pages with a linked slide):**

```
ADDITIONAL TASK:
Find 0-5 gaps in this student's notes for the current slide: a concept they missed, a step left unclear, a claim with no example. For each:
- bbox: [x, y, w, h] normalized 0..1, around where the gap sits on the page
- missing: one sentence naming what is missing
- entryIds: ids of knowledge entries (E<n> below) that already fill this gap, if any
Return: {gaps: [{bbox, missing, entryIds}]}
```

Gaps are stored in `page_gaps(... entryIds, createdAt)`. They are deleted and recomputed when the page is edited or when the linked slides' entries change.

**What a card contains:**

- The entry summary (or the single-source text) when a peer entry fills the gap: source line "From 3 classmates' notes" or "From 1 classmate's note".
- The official slide when only the slides cover it: source line "From slide 12".
- The model's own explanation when no source covers it: source line "AI explanation".
- Actions: **Add to my notes** (a separate annotation at the gap; ink is never modified) and **Dismiss** (personal, remembered).
- A "⋯" menu: **Not helpful** (hides it for me) and **Looks wrong** (hides it for me and rechecks the entry).

Peers first, then slides, then the model's own knowledge: the card prefers what a classmate wrote, then what the lecturer said, and only then the model's own explanation.

**Fill-gap call (only when a marker is tapped and no peer entry and no slide covers the gap):**

```
[page image, the gap crop, slide digests]
The notes are missing: "<missing>".
TASK: fill this gap in 2-4 sentences, using the official slides and your own knowledge. Cite slides as S<page> when used. LaTeX for math.
Return: {title, body, citations: [string]}
```

**Circle to ask:**

- Lasso/circle with pen or finger → a popover next to the selection: **Explain** · **Example** · **Why?** chips, an optional typed question, and the answer in the same popover with Add / Dismiss.
- Same grounding order as cards; citations validated server-side; uncited text is labeled "AI explanation".
- The selection's bbox is used to crop the page for the model, as today.

**Reports and author notices:**

- "Looks wrong" (optional reason) triggers an immediate recheck of that entry:

```
[slide digest, entry summary, source texts]
TASK: does this entry reflect the slide and its sources? If it rests on a misread note or contradicts the slide, return the mismatch in one sentence.
Return: {disputed: boolean, explanation?: string}
```

- A disputed entry drops out of every student's suggestions and prompts; its author gets an amber margin marker on the page where the note sits, with the explanation, and an item in the panel list. Editing the note replaces the fragment (old one `supersededBy`) and rechecks at the next merge.
- No visible flag for other students, consistent with having no reliability labels.

### Slim side panel

- Closed by default. Shows this page's gaps and suggestions as a list; tapping one scrolls to the gap and opens its card (overview and accessibility).
- Header: "Suggestions" with a count; a close button.
- The **Classmates**, **Explain** and **Quiz me** tabs are removed. Peer knowledge now arrives as panels of suggestions; Explain is the lasso popover; Quiz me is a future plan.
- For the author, the list also shows this page's own notes: shared, private (with reason), or disputed (with the AI's explanation).

## Changes to AGENTS.md invariants

- "Sharing must stay reversible" → **sharing is automatic and not user-reversible in the demo**; the AI's privacy reasons are the only thing keeping an item private; author control returns in the future plan.
- "Sharing counts are not shown in the library" stays, and no sharing UI exists at all now.
- "Folders exist only inside My notes" → **one free tree per course**; folders anywhere; lecture decks are ordinary files students can move.
- "Suggestions stay quiet: the study panel is closed until opened" → **the panel is closed by default and quiet margin markers are the indicator**.
- "Classmate notes are labeled unverified everywhere" → **no reliability labels**; neutral source lines only ("From 3 classmates' notes", "From slide 12", "AI explanation").
- "AI text is never republished as peer evidence" stays in spirit: AI-written summaries live in the knowledge base and are never re-indexed as a student's fragment.

## Data schema additions

```sql
CREATE TABLE knowledge_entries(
  id TEXT PRIMARY KEY,
  courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE,
  slideId TEXT REFERENCES slides(id) ON DELETE CASCADE,
  title TEXT, summary TEXT,
  createdAt TEXT, updatedAt TEXT, checkedAt TEXT,
  excludedReason TEXT,           -- 'disputed' when the AI judges it wrong
  disputeExplanation TEXT
);
CREATE INDEX entry_slide ON knowledge_entries(slideId);

CREATE TABLE entry_sources(
  entryId TEXT REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  fragmentId TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  PRIMARY KEY(entryId, fragmentId)
);

CREATE TABLE lecture_topics(
  id TEXT PRIMARY KEY,
  courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE,
  name TEXT, slideIds TEXT       -- JSON array of slide ids
);
CREATE INDEX topic_lecture ON lecture_topics(lectureId);

CREATE TABLE page_gaps(
  id TEXT PRIMARY KEY,
  pageId TEXT REFERENCES pages(id) ON DELETE CASCADE,
  pageRevision INTEGER,
  bbox TEXT,                     -- JSON [x, y, w, h], normalized
  missing TEXT,
  entryIds TEXT,                 -- JSON array of knowledge_entries ids
  createdAt TEXT
);
CREATE INDEX gaps_page ON page_gaps(pageId);

ALTER TABLE fragments ADD COLUMN entryId TEXT;
ALTER TABLE fragments ADD COLUMN supersededBy TEXT;
CREATE INDEX fragments_entry ON fragments(entryId);
```

No change to `folders`; the two seeded folders (`Lectures`, `Quizzes`) are ordinary rows created with the course.

## Implementation plan

### Phase 1 — Course file tree (1–2 days)
- [ ] Seed and course creation add the two ordinary folders; existing courses get them on first open (idempotent, additive).
- [ ] Server: `GET /api/courses/:id/files` (folders + files with `kind`, `lectureNumber`, `written`, `lastPageId`); `PATCH /api/notebooks/:id` already accepts `folderId`, now also from any folder including the seeded ones.
- [ ] Client `Library.tsx`: course page with tree + smart views (My notes / All files), lecture badges regardless of folder, long-press / right-click menus, Move to…, drop-to-import into any folder.
- [ ] Tests: created course has both folders; moving a lecture deck out of Lectures keeps its badge and opens the same notebook; moving a folder's contents up on delete; cross-course moves rejected.

### Phase 2 — Knowledge base backend (2–3 days)
- [ ] Schema + additive migrations; `fragments.entryId/supersededBy`.
- [ ] `jobs.ts`: `markSlidesDirty(notebookId)` on close + 10-minute sweep; `mergeAndCheck(slideId)` per the prompt above; `rebuildSummary(entryId)`; `topicsForLecture(lectureId)` after digesting; per-slide source hash to skip unchanged slides.
- [ ] `db.ts`: `entries(slideId)`, `entrySources(entryId)`, `upsertEntry`, `setSources`, `topics(lectureId)`, superseded handling inside `replaceFragments`.
- [ ] `study.ts`: `lectureContext` reads entries (disputed excluded) instead of raw fragments; citation refs become `E<n>` for entries, `S<n>` for slides.
- [ ] Remove the sharing routes and UI wiring; keep `withheld` dormant.
- [ ] Tests: duplicate grouping, single-source verbatim, disputed marked, superseded fragment keeps its citation, unknown refs dropped, unchanged slide skipped.

### Phase 3 — Inline suggestions (2–3 days)
- [ ] `page_gaps` table; gap detection added to the index call; lazy gap refresh on open; gaps deleted on edit.
- [ ] `study.ts`: `fillGap`, `askSelection` (Explain/Example/Why? + custom question), both grounded peers → slides → AI, with citations validated.
- [ ] `GET /api/pages/:id/suggestions` returns gaps with the entry, slide or AI content, minus dismissed ones.
- [ ] Client: margin markers in page chrome (tap target ≥ 24 px), inline card at the gap, Add / Dismiss, "⋯" menu.
- [ ] Client: lasso → popover with chips and typed question.
- [ ] Tests: marker placement from bbox, card content precedence (peer → slide → AI), dismissal persistence, popover near page edges.

### Phase 4 — Slim panel and reports (1–2 days)
- [ ] `POST /api/entries/:id/report`, `POST /api/entries/:id/recheck`.
- [ ] Client `panel/Panel.tsx`: Suggestions list only; scroll-to-gap; author section (shared / private / disputed with explanation).
- [ ] Client: amber marker on the author's own page; disputed item in the panel list.
- [ ] Tests: report hides for the reporter and rechecks; disputed entry vanishes from other students' suggestions; author sees the explanation.

### Phase 5 — Topics and docs (1 day)
- [ ] Lecture topics job wired after digesting; topics exposed in the course payload.
- [ ] `AGENTS.md` invariants updated (sharing, folders, quiet panel, labels).
- [ ] `README.md` features updated; `HANDOFF.md`, `PROGRESS.md`, `VALIDATION.md` refreshed.

## Implementation details I'll decide myself

Margin marker placement on tall bounding boxes, inline card width, popover flip near edges, disputed items shown inline in the panel list, stale gaps deleted rather than flagged, fill-gap answers returned transiently and not stored, and the exact source-line wording ("From 3 classmates' notes", "From slide 12", "AI explanation").

## Verification

- [ ] `npm run check` and `npm run test:e2e` pass (mock model only).
- [ ] Unit/API: file tree and folder moves; entry merging and single-source rule; disputed exclusion; superseded citations; no sharing route or UI remains.
- [ ] E2E: create a folder in a course, move a lecture deck into it, open it, write on a slide, leave the notebook, see a margin marker, tap it, add the card, dismiss another, circle a part and get a popover answer, report a card and see the author-side marker.
- [ ] Live smoke on COMP2211 (costs calls): two students write overlapping notes on one slide, leave their notebooks, one merge runs, the card reads "From 2 classmates' notes"; a deliberately wrong note is reported, rechecked, then hidden from the other student while the author sees the amber marker.

## Open items for the user

1. `AGENTS.md` currently says sharing must stay reversible; this spec reverses that for the demo. Confirming it's updated with the implementation, not before.
2. The future plan for Quiz me is recorded in `README.md`; nothing in this pass depends on it.
