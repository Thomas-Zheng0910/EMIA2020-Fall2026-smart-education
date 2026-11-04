> **Superseded on 2026-11-02** by `docs/superpowers/specs/2026-11-02-notebook-v2-design.md` (user-approved rewrite). Kept for history.

# Course Notebook Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this authorized inline implementation. Steps use checkboxes for tracking.

**Goal:** Deliver a local, persistent course notebook proving reviewed peer knowledge, manual source-linked inline additions and scoped quizzes.

**Architecture:** React/Tiptap UI calls a Fastify server. SQLite holds revisions, sources, fragments and jobs; a serial worker processes ingestion through a configurable model gateway or explicitly labeled sample-mode pipeline.

**Tech Stack:** Node >=24, TypeScript, React, Vite, Tiptap, Fastify, Zod, SQLite FTS5, PDF.js, Vitest, Playwright.

**Spec:** ../specs/2026-11-01-course-notebook-design.md

## Global Constraints

- Node.js >=24; local app, persistent SQLite and files, no external database required.
- No real course or model access is assumed; sample and live modes are visibly distinct.
- Suggestions require an explicit request and never modify notes before acceptance.
- Beyond-course material is labeled enrichment and never supplies a graded quiz answer.
- AI-inserted content is excluded from automatic peer publication to prevent feedback loops.
- Demo identities are a presentation mechanism, not authentication; bind to loopback by default.

## Review Focus

- Outdated note/source revisions must not overwrite new work or publish stale evidence (tasks 1, 3, 4).
- AI text and malicious uploads must not become instructions or recycled peer evidence (tasks 1, 2).
- Provider outages/invalid JSON/unknown citations must fail visibly, never fabricate success (task 2).
- Course scope and ownership must constrain both retrieval and quiz evidence (tasks 1, 2, 3).
- Browser selection, insertion, undo and save must preserve student text (task 4).

### Task 1: Persistent course knowledge and retrieval

**Files:** shared/types.ts; server/{db,seed,retrieval,content}.ts; tests/core.test.ts; package/config files.
**Interfaces:** Store(dbPath) exposes courses, notes, sources, fragments, jobs; originalText(content: JSONContent): string; retrieve(store, {courseId,lectureId,studentId,query}): Evidence[].

- [x] Write failing tests for persistence, stale revision rejection, exclusion of generated context, scoped approved retrieval, and idempotent publication.
- [x] Run npm test; expected missing implementation failures.
- [x] Implement schema, seed fixtures, optimistic saves, source revisions and FTS5 plus optional vector reciprocal-rank retrieval.
- [x] Run npm test; expected pass. Preserve files locally; commit deferred because Git author identity is unset.

### Task 2: Reviewed ingestion, model gateway and study assistance

**Files:** server/{ai,ingestion,study}.ts; tests/pipeline.test.ts.
**Interfaces:** ModelGateway(config).json(prompt, schema, images?) validates bounded multimodal calls; processJob(store,gateway,jobId) updates persisted stages; suggest(store,gateway,input): Suggestion; makeQuiz(store,gateway,input): Quiz.

- [x] Write failing tests for actual local text ingestion, mocked HTTP multimodal extraction/review, malformed JSON, invalid citations, no-evidence response, scope exclusion and failure/retry states.
- [x] Run npm test; expected new behavior failures.
- [x] Implement provider transport, local PDF extraction, vision transcription/review, atomic publication, mode-labeled suggestions, and 3-question quizzes with course-bound citations.
- [x] Run npm test; expected pass. Preserve files locally; commit deferred because Git author identity is unset.

### Task 3: Local API and file lifecycle

**Files:** server/{app,index}.ts; tests/api.test.ts; .env.example.
**Interfaces:** buildApp({store,gateway,worker?}): FastifyInstance; JSON /api/bootstrap, /courses, /notes, /sources, /suggestions, /quizzes; binary /api/files/:id; multipart /api/imports.

- [x] Write failing API tests for identity/course isolation, invalid uploads, save conflicts, acceptance revision, job polling and retry.
- [x] Run npm test; expected route failures.
- [x] Implement validated routes, bounded file persistence, source access, serial job queue, graceful shutdown, static serving and Vite proxy.
- [x] Run npm test; expected pass. Preserve files locally; commit deferred because Git author identity is unset.

### Task 4: Notebook interface and complete study flow

**Files:** src/{main,App,api,styles}.{ts,tsx,css}; src/components/{Notebook,Knowledge,Quiz,CourseDialog,SourceDialog}.tsx; e2e/notebook.spec.ts.
**Interfaces:** API types from shared/types.ts; Notebook stores Tiptap JSON with contextBlock provenance; UI actions use explicit selected passage and captured note revision.

- [x] Write browser scenarios for selection/request/source view/insertion/undo/reload, cross-student contribution, quiz grading, imports and responsive navigation.
- [x] Run browser scenario; expected missing UI failure.
- [x] Implement notebook, selection toolbar, inline preview, autosave/conflict state, course brief editing, knowledge/jobs/imports, quiz and evidence viewer.
- [x] Run npm run build and npm run test:e2e; expected pass. Preserve files locally; commit deferred because Git author identity is unset.

### Task 5: Verify, document and hand off

**Files:** README.md; docs/VALIDATION.md; AGENTS.md; docs/PROGRESS.md.
**Interfaces:** npm run dev, npm run start after build, npm run check, npm run test:e2e.

- [x] Run full unit/API suite and production build; expected no failures.
- [x] Run browser workflows on desktop/mobile and inspect screenshot; expected readable usable app, no browser errors.
- [x] Review all requirements; fix material issues and record actual provider verification limits.
- [x] Write startup/provider/course-import instructions, architecture and tradeoffs. Preserve the verified result locally; commit deferred because Git author identity is unset.

## Execution record

Implemented inline under the user’s explicit instruction to proceed. Verification and independent-review results are recorded in `../../VALIDATION.md` and `../../PROGRESS.md`. No remote was configured and no deployment was published. The repository remains local on `feat/working-prototype`.
