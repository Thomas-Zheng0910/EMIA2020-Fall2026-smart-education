> **Superseded on 2026-11-02** by `docs/superpowers/specs/2026-11-02-notebook-v2-design.md` (user-approved rewrite). Kept for history.

# Collaborative Course Notebook prototype

## Intent and decisions

Build a runnable proof of the user's October 31 concept: personal note-taking automatically contributes source-backed peer fragments; a student selects typed notes and manually asks for context, previews the addition inline, optionally inserts it, and tests understanding with a quiz. The user explicitly requested implementation on November 1; real course materials will follow later. Use replaceable synthetic fixtures now.

Confirmed: this is a prototype, not production software; typed-note suggestions, handwriting OCR followed by AI review before publication, participation implies course sharing, model-judged contradictions, manual trigger, course-level explanations, clearly labeled optional enrichment. Retain original personal work. Native stylus editing, LMS, real authentication, offline sync, instructor moderation, and production hosting are excluded.

## Approaches and implementation calls

Considered: fork ClassFlowAI (useful pipeline but coupled node graph, budgets and agent runtime); fork Open Notebook (existing knowledge workspace but different interaction and database); build a compact app using portable patterns and open-source editor/viewer. Choose the compact app as an implementation call under the user's instruction to proceed. Keep ClassFlowAI untouched. Use React, Tiptap, Vite, Fastify, Zod, Node 24 SQLite/FTS5, PDF.js, and an optional OpenAI-compatible model transport. SQLite replaces proposed PostgreSQL/pgvector for a single-machine prototype; semantic vectors use cosine ranking in process at this scale.

## Global constraints

- Node.js >=24; local app, persistent SQLite and files, no external database required.
- No real course or model access is assumed; sample and live modes are visibly distinct.
- Suggestions require an explicit request and never modify notes before acceptance.
- Beyond-course material is labeled enrichment and never supplies a graded quiz answer.
- AI-inserted content is excluded from automatic peer publication to prevent feedback loops.
- Demo identities are a presentation mechanism, not authentication; bind to loopback by default.

## Experience

A calm desktop-first notebook: left course/lecture navigation, central editable paper with title and formatting, right contextual assistance panel. Tabs: Make notes, Shared knowledge, Quiz me. Top identity switch offers three fictional students. Seed a course on introductory machine learning with 3 lectures, official evidence and complementary peer notes. Course setup allows a name, level, in-scope topics, prerequisites and exclusions, editable later when actual materials arrive.

Select text, click Fill in context, optionally state the gap. The request includes the selection, surrounding note and course brief. Render a preview below the selected block, with expandable source evidence and optional collapsed enrichment. Add inserts an attributed editable context block as one undoable transaction. Dismiss changes nothing. A request records the note revision; changed notes invalidate insertion until refreshed. No automatic ghost completions.

Notes autosave; explicit Save now and retry states handle failures. A source viewer displays evidence text plus original image or PDF when available. Imports accept PDF, PNG, JPEG, WebP, TXT and Markdown, with official/peer type and lecture explicitly selected. Course sharing notice explains the demo assumption. Status displays queued, extracting, reviewing, indexing, ready or failed and retry.

## Data and processing

Entities: course (level, topics, prerequisites, exclusions), lecture, fictional student, note (JSON, revision), source (type, author, original file hash), source revision, fragment (text, page, source version, topic, scope, review and conflict status), ingestion job, suggestion and cited fragment snapshots. Images use source page references; exact bounding-box OCR is deferred. Cite immutable extracted text with original file/page.

Debounced note saving updates editable JSON with optimistic revision checking, derives original-only text by excluding generated context blocks, and queues extraction when that original text changes. Process jobs serially with persisted state, bounded input and retry; mark interrupted jobs failed on restart. Each publication replaces a source's active fragments atomically. Model failures never promote unreviewed imports. A stale job cannot overwrite newer source revisions.

Typed inputs split into meaningful paragraphs. In live mode the reviewer checks course relevance, source faithfulness, uncertain math and conflicting evidence; handwritten inputs send rendered images for transcription and again for review. Report approved, uncertain or rejected plus short reasons. Uncertain/rejected fragments remain inspectable but are not retrieval evidence. A changed source invalidates its previous active fragments until review completes. Official-source label indicates origin, not proven correctness.

## Retrieval and AI

Filter by course and approved active fragments first. Prefer the current lecture, allow other lectures of the same course. Fuse FTS5 keyword rank with optional real semantic embedding rank using reciprocal rank fusion; add neighboring context via source excerpt. Exclude the requesting student's own note source from peer candidates. Model compares candidates with selection, proposes an actual addition, assesses contradictions, and classifies course scope. Validate returned IDs against retrieved evidence. No-evidence result says no relevant course evidence rather than inventing a peer explanation.

Course scope: within-course main answer; concise prerequisite background; beyond-course material only as a separately labeled enrichment. Explicit exclusions override topic matches. Inference from materials is advisory; course brief is editable. The model's knowledge may explain a cited step but cannot be attributed to the lecturer or peer unless their source supports it.

Live mode: configurable base URL, secret API key, text model, vision model and optional embedding model. Keys stay server-side. JSON outputs validated with Zod, one format-repair attempt maximum, timeouts and user-visible errors. Uploaded content is untrusted evidence, never operational instructions. No tool execution by the model. Log bounded job errors without credentials. No silent fixture fallback after live failure.

Demo mode: meaningful local lexical retrieval over seeded peer/official fragments; source-excerpt suggestions and prepared course quiz exercises, clearly labeled as prepared rather than live AI. Uploaded handwritten scans require configured vision AI; they never receive fabricated transcription. Digital PDF extraction works locally using PDF.js; scan/image OCR renders via installed Poppler and a configured vision provider.

Quizzes use only approved within-course sources. Live model generates 3 short multiple-choice questions and reasoning with validated evidence IDs. Submit answers, score locally and display explanations with source links; demo exercises are prepared. No claims about mastery.

## Acceptance and validation

1. Start with npm install / npm run dev, no credentials, see seeded course and demo label.
2. Select an incomplete gradient-descent note, request context, find a complementary peer excerpt, inspect source, accept, undo, reload with persistence.
3. Switch identity, save a novel original typed explanation, observe review/index and retrieve it from another identity.
4. Import text or digital PDF; preserve original, process and show ready fragments. Import image without credentials shows actionable OCR requirement. Mock HTTP provider tests verify genuine multimodal extraction/review and structured suggestions.
5. Wrong-course, unreviewed, rejected, outdated and generated-only fragments never enter peer retrieval; conflict metadata stays visible.
6. Explicitly advanced material stays outside the main addition and quizzes. Empty evidence does not fabricate an answer.
7. Concurrent stale saves or acceptance after editing are rejected without overwriting work; repeated publication is idempotent; failed jobs can retry and survive restart as failed.
8. Unit/integration suite, TypeScript/build, browser workflow and mobile-width usability checks pass. Live provider accuracy remains unverified until credentials and representative handwriting are supplied.

## References

ClassFlowAI local source: packages/agent/src/convert/{convert,reader}.ts, material-review.ts, packages/db/src/access/attachments.ts. Reuse architecture patterns rather than importing its coupled runtime. External candidates checked November 1: github.com/ueberdosis/tiptap (MIT editor), mozilla/pdf.js (Apache-2.0), docling-project/docling (MIT alternative converter), huggingface/sentence-transformers (optional local embeddings), pgvector/pgvector (future server database), lfnovo/open-notebook (reference workflow). No third-party implementation copied.
