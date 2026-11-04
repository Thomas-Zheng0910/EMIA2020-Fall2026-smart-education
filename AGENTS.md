# Working on Notebook

A bounded, local prototype of a Goodnotes-like course notebook with peer knowledge. Read `docs/superpowers/specs/2026-11-02-notebook-v2-design.md` (current; the 11-01 spec/plan are superseded) `docs/HANDOFF.md` and `docs/PROGRESS.md` before changing behavior. User decisions outrank earlier proposals. ClassFlowAI is reference-only; this repo imports none of its runtime.

- Node >=24, npm with the checked-in lockfile, poppler-utils. `npm ci`, `npm run seed -- <zip|folder>`, `npm run dev`.
- Run `npm run check` and `npm run test:e2e` before reporting changes as working. E2E uses `e2e/mock-llm.mjs`; never point tests at the live provider.
- Live provider configuration (official DeepSeek, `deepseek-flash`, multimodal) belongs in ignored `.env`; uploads and the database belong in ignored `data/`. Never commit credentials or runtime data.
- Students can take several courses; every course-scoped read/write must check enrollment (`x-course-id` header + lecture/fragment course). Never leak lectures, notes or links across courses.
- Demo identities are explicitly not authentication. Keep the server on loopback.
- No RAG/embeddings by user decision: prompts carry the whole lecture (slide digests + visible classmate fragments). Model citations must be validated server-side against the refs actually supplied.
- Student ink and text are never modified by AI. Suggestions are added only on explicit "Add to my notes", as separate `annotation` items that are excluded from page rendering for indexing, so generated text is never republished as peer evidence.
- Index results are written only if the page revision is unchanged; annotation-only edits must not trigger a new model call (content hash).
- Sharing must stay reversible: let authors stop sharing any item (remembered across re-indexing), from the course page ("Manage sharing") and the page panel. User decision (Nov 3): the library does not show sharing counts or which notes classmates use; the join/create dialogs still explain sharing. Private items carry a reason (`unclear`, `unlinked`, `on_slide`, `withheld`). Notes that merely restate the slide are not shared.
- Library layout (user decision, Nov 3; prototype at `/proto/library/`): sidebar of enrolled courses → **My notes** (first) and **Lectures**. A course is not a folder: it is joined, not created from the sidebar, and it decides which classmates notes connect with. Folders exist only inside My notes, per student and course; notes never move across courses; deleting a folder moves its contents up. Lectures are documents (official slide PDFs), never folders. A lecture notebook appears in My notes once the student has written on it. No add buttons for notebooks/PDFs: PDFs are dropped in, and notebooks/folders come from long-press (touch/pen) or right-click menus; "New folder" is the only button. Tablet is the primary device: every action must work by touch (long-press menu, long-press drag, Move to…).
- Suggestions stay quiet: the study panel is closed until the student opens it.
- Fragments are shared only when the transcription and the slide link are both confident (`SHARE_THRESHOLD`); others stay private and visible to the author.
- Quiz answers must be supported by an official slide; questions without a valid slide citation are dropped. Classmate notes are labeled unverified everywhere.
- Missing AI configuration must produce a clear error, never fabricated content.
- Mock-provider tests establish transport and control flow only; model quality needs representative inputs and human evaluation.
- `npm run dev` uses polling for the frontend because this workstation has exhausted native file-watch handles. Restart it after server changes.
