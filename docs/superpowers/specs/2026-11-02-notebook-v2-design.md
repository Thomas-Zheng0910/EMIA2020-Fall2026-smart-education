# Notebook v2: Goodnotes-like course notebook (supersedes 2026-11-01 design)

User decisions (Nov 2): rewrite allowed; UI must be a clean note-taking app (Goodnotes/Notion feel); full ink editor; live AI through official DeepSeek (`deepseek-flash`, multimodal, 1M context) — no separate OCR step and no RAG/embeddings; course material is COMP2211 from the provided Flexcil zip. Agent decides remaining questions and implements without staging.

## Decisions made by the agent
- Identities: three fictional students (no auth). "Thomas" is the default user; "Alex" owns the imported handwritten `COMP2211 notes.pdf` notebook as seeded peer content; "Priya" starts empty.
- Seed all 12 lectures + model-evaluation supplement. Past papers/lab/self-test are not imported (exam material; not lecture evidence).
- Targets: laptop (mouse/trackpad) and tablet browser (stylus, pressure, optional stylus-only mode).
- Server binds loopback; existing systemd/tunnel files remain unchanged.

## Product
1. Library: see "Library v2" below (replaces the course header + lecture grid + "My notebooks" page).
2. Notebook editor: left page thumbnails; center continuous-scroll paper; floating toolbar: pen, highlighter, eraser (stroke), lasso (select, move, delete, ask, quiz), text box, image, colours, widths, undo/redo, zoom, stylus-only. Page types: slide, imported PDF page, blank, ruled, grid; insert page after any page. Autosave with revision checks.
3. Right panel (collapsible), per current page:
   - Classmates: quiet count badge per page; opening lists peer fragments linked to that slide with a crop of the original handwriting, author, kind, confidence; Add to my notes / Dismiss. No AI call needed.
   - Ask: lasso or whole page → "Explain / fill the gap" with optional question. Cards labeled Official slide / Classmate note / AI interpretation, with citations that open the source. Add to my notes / Dismiss.
   - Quiz Me: scope = lecture / this page / lasso selection; 4 MCQs, local grading, explanation and source links.
   Added content becomes a labeled sticky annotation on the page, never mixed into ink and never re-indexed as peer content.

## AI pipeline (no retrieval index)
- Lecture import: `pdftoppm` renders slide PNGs, `pdftotext` per page text. Background job digests slides in batches (images + text) → `{title, summary, formulas, topics}`.
- Page indexing: 6 s after the last save the server renders the page (background + ink + user text, excluding AI annotations) to PNG and sends it with the linked slide digest (or course outline for non-slide pages). The model returns the linked lecture/slide + confidence and the fragments the student added beyond the slide (kind, text with LaTeX, topic, confidence, bbox). A newer revision discards stale results. Fragments < 0.6 confidence or from uncertain links stay private. Non-slide pages show a "Linked to L3 · slide 12 — confirm/change" chip.
- Ask/Quiz: one prompt with the page image (and lasso crop), all slide digests of the lecture, and all visible peer fragments for that lecture. Citations are validated server-side; uncited claims are labeled AI interpretation. Quiz correct answers must cite an official slide; others are dropped.
- Missing key → clear 503 error; no demo fallback.

## Data
courses, students, lectures (pdf file, page count, status), slides (png, text, digest), notebooks (owner, course, lecture?, title), pages (notebook, position, kind, slide ref / background png, size, ink strokes JSON, items JSON, revision, index status, link + confidence + confirmed), fragments (page, owner, lecture, slide, kind, text, topic, confidence, bbox, pageRevision), dismissals, quizzes.

## Multiple courses (user request, Nov 2)
A student can take several courses. `enrollments(studentId, courseId)`; the client sends the selected course as `x-course-id` (remembered per student). Course-scoped routes require enrollment; lecture/slide/quiz routes check the lecture's course; classmates' fragments are visible only to students enrolled in the fragment's course; pages can only link to lectures of their own course, and automatic linking only sees that course's outline. UI (revised on user feedback): the front page is the list of my courses (plus other courses to join, create, leave—notebooks are kept); each course is its own page/URL (`#course=<id>`) with lectures and notebooks; breadcrumb `Notebook / CODE`; a notebook's back button returns to its course. No silent fallback to another course. Existing single-course databases are migrated by enrolling the demo students.

## Library v2 (user decisions, Nov 3)
Reviewed as a clickable prototype (`proto/library/`, served at `/proto/library/`), modelled on Goodnotes/Notability: folders on the left, documents as covers on the right.
- Sidebar: enrolled courses (coloured code chip + name; a course is joined, not created as a folder) → **My notes** (first) and **Lectures**; "Join a course" goes to the front page. Portrait tablet/phone: the sidebar slides over the content.
- My notes: the student's notebooks plus every lecture they have written on ("From slides · N edited slides", cover = latest written page). Newest first. Folders (nested) per student and course: `folders(id, studentId, courseId, parentId, name)`, `notebooks.folderId`. Deleting a folder moves its notes and subfolders up. Notes never cross courses.
- Lectures: official slide PDFs as documents (thumbnail, `L#`, `PDF`, ✎ count when written on). Opening one opens the student's copy in the editor. No classmate counts anywhere in the library.
- Course page: course chip, name, description, classmate count, the two places as tiles, and "Manage sharing" (review/stop sharing).
- No add buttons except "New folder". PDFs are dragged in (onto Lectures → a lecture for the course; onto My notes or a folder → an imported notebook there). New notebook/folder, rename, delete, Move to… come from long-press (touch/pen) or right-click. Long-press then drag files a note; a finger that moves first scrolls.
- URLs: `#course=<id>`, `&view=notes|lectures`, `&folder=<id>`; leaving a notebook returns to the place it was opened from.
