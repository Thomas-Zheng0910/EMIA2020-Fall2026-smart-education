# Notebook walkthrough review — 5 November 2026

The normal student journey works, but additional interaction and failure checks found bugs that can lose writing, attach suggestions to the wrong page, and break conversational Ask. Fix those before further visual polish.

This is an audit, with no product code changes. The checkout already contained substantial uncommitted work; it was preserved. The public service, its configuration, and its runtime data were not used for the walkthrough.

## Method and coverage

- Read the current design, AGENTS.md, HANDOFF, PROGRESS, and the November 4/5 product decisions.
- Ran `npm run check`: **23 unit/API tests passed**, TypeScript and production build passed. The build reports the existing large JavaScript chunk warning (~635 kB uncompressed).
- Ran `npm run test:e2e`: **17 browser scenarios passed**, using `e2e/mock-llm.mjs`, an isolated database, and separate ports.
- Walked course creation/join, course folders and PDF import, writing on lecture slides, peer-note indexing and merge, inline suggestions, Full note, acceptance, Ask and follow-ups, history, a new lined notebook, typed notes, automatic linking, page paper changes, and tablet layouts. The existing browser suite also exercises lasso Ask, memos, undo, persistence, and adding suggestions from Whole notebook without changing the page being read.
- Added local diagnostic scripts to probe focused drafts, delayed saves, failed saves, delayed Ask responses, tab switching, and suggestion navigation. These are audit artifacts, not new passing regression tests.
- Desktop: 1440 × 1000. Tablet: 834 × 1194 portrait and 1194 × 834 landscape, including a Chromium touch context. The existing suite covers 390 px phone width.
- A separate reviewer inspected actual screenshots without reading implementation code. Its findings were checked against the screenshots and, where applicable, measured controls and browser interaction.

All AI calls in this review went to the deterministic mock. The fixtures establish behavior and layout; they do not establish transcription accuracy, gap relevance, answer quality, or live-provider latency. Physical iPad/Safari and Apple Pencil behavior remain unverified.

Evidence and runnable diagnostic scripts are in `.oil-ui/walkthrough-2026-11-05/`; screenshots are in `shots/`, measurements and request evidence in `logs/`. The mock uses the isolated `/tmp/notebook-walkthrough-20261105` database. No real student data or credentials were copied into these artifacts.

## Confirmed bugs, ordered by impact

### 1. P1 — A focused draft can be lost despite “Saved”

**Reproduce:** Create a lined notebook, choose Text, tap the paper, type one character (`A`), keep the text field focused, wait for Saved, then reload.

**Observed:** Before reload, the textarea contains `A`, but the server stores an empty text item. After reload, the page has no text. This reproduced in two separate runs. A longer typed line did persist in the comparison case; this is a timing-sensitive draft bug, not a claim that every focused draft is lost.

**Cause:** `src/editor/Editor.tsx:62` resets `pagesRef.current` from React state on every editor render. `draftItem` at line 169 updates only that ref. A render between typing and autosave can replace the draft with the older page state. The loader then filters out the empty saved item.

**Recommendation:** Keep one authoritative latest draft for saving, independent of incidental renders. Only show Saved after that exact content is acknowledged. Cover focused single-character and paused drafts with a reload assertion.

**Evidence:** `logs/confirmed.json` (“Focused draft reloaded”); `shots/23-draft-says-saved.png` and `24-draft-missing-after-reload.png`.

### 2. P1 — Changing paper breaks the next save

**Reproduce:** Create a notebook, use the page's Paper menu to change Lined to Grid, then type on the page and leave the text field.

**Observed:** The PUT returns **409**, with “This page changed in another window. Reload to get the latest version.” The UI says “Not saved — retrying.” The server has the grid paper but no newly written text. No second window was involved.

**Cause:** `server/db.ts:593` increments the page revision when changing paper. The paper endpoint returns the kind and dimensions without the new revision, and `src/editor/Editor.tsx:432` updates only the kind and dimensions. The next save therefore uses a stale revision. The 409 handler returns without retrying, so the displayed retry message is also inaccurate.

**Recommendation:** Return and adopt the updated revision as part of the paper mutation, serialize it with pending writes, and distinguish a conflict from a retryable outage. Test writing and reloading **after** a paper change; the existing paper test checks preservation of earlier content.

**Evidence:** `logs/final-probes.json` (“Save after re-papering”); `shots/32-paper-change-save-conflict.png`.

### 3. P1 — Save failure allows work to be abandoned and causes rapid retries

**Reproduce:** Make page PUTs return 503, write and leave the text field, then use Back to course. Reload and reopen the notebook.

**Observed:** Back navigates without requiring recovery of the failed save; after reload the writing is absent. In the same isolated outage check, **43 PUT attempts occurred in 159 ms**. The save label flickers through Saving rather than maintaining a useful failure state.

**Cause:** In `src/editor/Editor.tsx:114`, the failure handler puts the page back in the dirty set and schedules a four-second retry. Execution then also reaches the immediate recursive `flush` at line 123. Separately, `saveAll` does not report failure, and the Back handler at line 510 always continues to navigation.

**Recommendation:** Use one bounded retry mechanism with backoff. Retain a recovery draft, propagate save failure to navigation, and keep the student on their work until it is saved or they explicitly choose to leave with a recoverable copy. Do not label an unresolved conflict as retrying.

**Evidence:** `logs/confirmed.json` (“Failed save and Back”); `shots/27-outage-retry.png` and `28-outage-work-lost.png`. The 503 responses were injected locally, not observed on the public service.

### 4. P1 — An open suggestion can be saved on the wrong slide

**Reproduce:** On Slide 2, open Suggestions → This page → a suggestion. Close the panel if necessary, switch to Slide 1 while the Full note card remains open, then select Add beside my notes.

**Observed:** The card still describes the Slide 2 suggestion, but acceptance adds an annotation to Slide 1. Server-side counts changed from **1 to 2 on Slide 1**, while Slide 2 stayed at **1**. The added annotation persists in the server response.

**Cause:** The open card retains a suggestion snapshot but is rendered under whichever page is currently active (`src/editor/Editor.tsx:644`). Its Add handler at line 653 uses that current page's `p.id` rather than the suggestion's `pageId`. Page changes do not clear or pin the open card.

**Recommendation:** Bind the card and every action to its originating page. Either close it when the active page changes or retain an explicit target page and label. Resizing panels must not silently retarget an action.

**Evidence:** `logs/wrong-page.json`; `shots/34-slide2-card-on-slide1.png` and `35-suggestion-saved-on-wrong-slide.png`.

### 5. P1 — Ask has a saved thread but no conversational model context

**Reproduce:** Ask “Explain gradient descent using a bicycle rolling down a hill,” then, in the same session, ask “In that analogy, what is the learning rate?”

**Observed:** The UI retains both questions and answers, but the second model request contains only the latest question, the lecture, knowledge entries, and current page image. The earlier bicycle question and the preceding conversational answer are not supplied as history. A follow-up cannot reliably refer to the previous exchange.

**Cause:** `server/app.ts:563` loads the session to validate ownership, but the call at line 571 passes only the current question. `server/study.ts:104` constructs a single-question prompt; it has no conversation input.

**Recommendation:** Supply a bounded history of the session's user and assistant messages, preserving their page context and valid source references. Verify the outgoing prompt, not merely that History displays two messages. Similar words appearing in a knowledge entry do not constitute conversation history.

**Evidence:** `logs/model-prompts.jsonl`, and the complete second prompt in `logs/walkthrough.json` (“Ask follow-up context”); `shots/07-ask-desktop.png` shows the UI thread.

### 6. P1 — Join/create disclosure promises a removed sharing control

**Reproduce:** Open Join course or New course and read the notice. The Leave course confirmation repeats the same premise.

**Observed:** The notice says sharing is “under your name” and “you can stop sharing any item at any time.” Current product rules intentionally provide no stop-sharing route or control, and peer suggestions do not identify classmates.

**Cause:** `src/Home.tsx:18` and line 37 retain wording from the earlier sharing design.

**Recommendation:** Describe the current decision plainly: useful additions may be shared automatically within the course, classmate identities are not shown on suggestions, and sharing cannot be undone in this demo. Keep the disclosure at join/create; do not reintroduce the removed controls as a fix.

**Evidence:** `logs/probes.json` (“Join disclosure”); `shots/22-join-disclosure.png`.

### 7. P2 — Full note's Add button can sit behind the thumbnails

**Reproduce:** At 1440 px, leave page thumbnails visible, open the Suggestions panel, and click a This page suggestion to show Full note.

**Observed:** The card starts at **x = 30 px**, while the thumbnail sidebar occupies **x = 0–148 px**. The card is partly hidden, including the Add button's center. An ordinary click is blocked by the sidebar; this was reproduced in two interaction checks.

**Cause:** The reserved card space and `.gap-card.flipped` placement (`src/styles.css:3521`) do not keep the card inside the canvas when both sidebars are present.

**Recommendation:** Lay out the card within the remaining canvas bounds, or show the expanded suggestion inside its already-open panel. Treat both sidebars together when selecting the placement.

**Evidence:** `logs/final-probes.json` (“Suggestion card overlap”); `shots/31-suggestion-card-under-thumbnails.png`.

### 8. P2 — Accepting a suggestion does not settle it in This page

**Reproduce:** Open Suggestions → This page, then accept its inline ghost using the margin plus.

**Observed:** The ghost disappears and the annotation is saved, but This page continues to show the suggestion. Its count stays at one. Whole notebook correctly excludes answered gaps after loading saved content.

**Cause:** The inline ghost filters through `unanswered`, and the notebook endpoint filters annotation `gapId`s. The panel is instead passed raw `suggestions.gaps` at `src/editor/Editor.tsx:698`; `src/panel/Panel.tsx:913` displays all of them.

**Recommendation:** Derive every scope from the same answered/dismissed state, including pending local accepts and undo. The available actions should not invite adding an already-accepted gap again.

**Evidence:** `logs/walkthrough.json` (“Accepted suggestion in page panel”: before 1, after 1, ghost 0); `shots/08-accepted-suggestion-desktop.png` and `09-whole-notebook-desktop.png`.

### 9. P2 — Switching tabs discards an unsent Ask question

**Reproduce:** Type a question without sending, switch to Suggestions, then return to Ask.

**Observed:** The composer is empty. Closing and reopening the panel has the same lifecycle risk.

**Cause:** The conditional at `src/panel/Panel.tsx:580` unmounts AskChat, whose draft is local component state.

**Recommendation:** Keep a per-notebook conversation draft above the tab lifecycle, or persist it deliberately. Opening Suggestions should not erase work in progress.

**Evidence:** `logs/probes.json` (“Ask draft after tab switch”).

### 10. P2 — A late Ask response overrides New chat

**Reproduce:** Hold an Ask response, select New chat while the request is pending, then release the response.

**Observed:** The old question and answer populate the cleared thread, and its title changes back to the old conversation. While waiting, the sent user question is not displayed as a message at all.

**Cause:** `newChat` at `src/panel/Panel.tsx:678` clears local state, but the pending `send` closure at line 686 still appends its result and selects its session. There is no active-request/session generation check.

**Recommendation:** Associate responses with the session/request that started them and ignore them for a newly selected thread. Show the outgoing question immediately with a pending/error state. A completed response can still be saved to its original History session.

**Evidence:** `logs/probes.json` (“New chat during slow Ask”: no pending user message, old answer appears, title returns to “Explain the step.”).

### 11. P2 — Suggestions can obscure the official slide

**Observed:** The inline ghost crosses the printed heading in screenshots 05/07; the accepted annotation covers it with an opaque block in screenshot 08. The independent reviewer identified both. The mock controls the gap location, so this establishes a layout failure when that location overlaps slide content, not how frequently the real model chooses such a location.

**Cause:** The ghost uses the supplied bounding box directly. `addAnnotation` at `src/editor/Editor.tsx:357` avoids ink and page items but does not account for the printed slide background.

**Recommendation:** Preserve a readable official slide when placing both the ghost and the accepted note. Use a clear writing region or an added note area when there is no free space; do not modify the student's writing or the slide.

**Evidence:** `shots/05-slide-inline-desktop.png`, `07-ask-desktop.png`, and `08-accepted-suggestion-desktop.png`.

### 12. P2 — Folders cannot be moved as required by the free-tree design

**Reproduce:** Open a folder's long-press/right-click menu and try to move it into another folder.

**Observed:** Available actions are New folder inside, New notebook here, Rename, and Delete folder. No Move to action exists. The folder PATCH route also accepts only a name. This is already listed as a handoff limitation, but conflicts with the current rule that ordinary folders are movable.

**Recommendation:** Support same-course folder moves with touch-accessible Move to, including cycle prevention and ownership checks. Preserve the seeded folders' ordinary-folder behavior after renaming or moving them.

**Evidence:** `src/Library.tsx:264`; `logs/final-probes.json` (“Folder actions”); `shots/33-folder-menu.png`.

## UI/UX improvements

1. **Increase touch hit areas while preserving compact icons.** Measured toolbar buttons are 32 × 32 px and colour controls are 18 × 18 px in the touch context; the suggestion plus is 22 × 22 px. Provide roughly 44 px touch areas with enough separation, especially for destructive or acceptance actions. Keep pen-oriented precision controls compact visually. Evidence: `logs/probes.json` (“Tablet controls”), screenshots 17–19.
2. **Keep feedback clear of the next action.** The accepted-note toast overlaps the Ask composer in tablet screenshot 10. Position it outside the composer/zoom controls and give it a visible Undo action; the current Ctrl+Z instruction is insufficient as immediate tablet guidance, even though a toolbar Undo exists.
3. **Explain PDF dropping at the course entry point.** Course-root screenshot 02 has space and the prescribed New folder/New notebook buttons, but no cue for importing a PDF. Add a quiet drop hint, with clear language about dropping into Lectures versus elsewhere. Keep the user's two-button creation model.
4. **Make answers easier to read as a conversation.** Ask answers combine uppercase credit text, multiple outlined citations, a title, body, and Add. Use the required neutral credit line more quietly and avoid two reference chips that both open the same slide. Show a sent question immediately, then its loading/answer state.
5. **Help students understand the wait between writing and AI availability.** On a newly typed page, Saved and Organizing can coexist while Ask is disabled pending a lecture link. Explain that specific pending state, and offer the existing manual link action directly. Preserve the clear unlinked-page explanation and never fabricate an answer.

## Preserve

The warm desk/paper palette, distinct paper types, explicit notebook creation, course tree, separate Ask/Suggestions tabs, deliberate acceptance, separate AI annotations, and persisted History are useful foundations. Improve placement and state consistency without replacing those decisions or adding sharing controls, classmate names, reliability labels, RAG, or automatic note rewriting.

## Suggested fix order and verification

1. **Protect writing:** findings 1–3. Add tests that wait for the actual save response, reload, and compare exact content; cover post-paper-change writes, an outage, recovery, and leaving with an in-flight write.
2. **Bind suggestions to their page:** finding 4, then 7–8 and 11. Assert source/target page IDs and saved annotations, not just an optimistic annotation on screen. Verify the card's clickable bounds with both sidebars open, and check undo across scopes.
3. **Make Ask conversational and stable:** findings 5, 9–10. Inspect model history, preserve composer drafts, and test delayed responses while changing sessions/tabs/pages.
4. **Correct the sharing disclosure:** finding 6; check join, create, and leave together against the current irreversible-sharing decision.
5. **Finish tablet interaction and the tree:** finding 12 and the UI recommendations, followed by physical iPad/Safari and representative live-model evaluation.

The baseline suites passed during this audit, but the confirmed failures above remain unfixed. Their absence from the current test suite explains why passing baseline checks do not establish these workflows as reliable.
