# Sharing, live handouts and group notes (2026-11-05)

User decisions: direct sharing is named and raw; the AI bank stays a separate anonymous surface. The professor gets a seeded demo account. A direct share is an editable copy, not a read-only view. The sender chooses pullable or snapshot. Live is a professor session, read-only for students while it runs, and ends into a pullable or snapshot copy. A note can also be owned by several people and edited collaboratively. No local AI; all model calls go through the shared API.

This spec extends `2026-11-02-notebook-v2-design.md` and `2026-11-04-knowledge-base-inline-suggestions.md` where it does not contradict them.

## Roles and demo accounts

- `students.role` is `student` or `professor`. `enrollments.role` is `student` or `instructor`.
- Seeded demo accounts are Thomas, Alex, Priya (students) and **Professor** (professor, instructor of COMP2211). They are not authentication.
- Only a professor account can create a course (`POST /api/courses`); the creator is enrolled as `instructor`.
- Only an instructor can add official lecture PDFs, change the course, re-digest slides, or start a live session.
- Instructors are excluded from `memberCount`, peer-note counts and the AI bank. The course page says "students" for an instructor.
- The demo identity switcher lists the Professor; no registration, password or account page is required.

## Three named sharing modes

The page chip "Shared N notes" keeps its automatic-AI-bank meaning. Named sharing uses the verbs **Send a copy**, **Invite to co-edit** and **Go live**; received copies live in a **Shared with me** folder. The named modes are:

### Send a copy

- Whole notebook or the current page (`pageId`).
- One or more classmates. An instructor can send to the whole class.
- The sender chooses **pullable** (recipient can fetch later source changes) or **snapshot** (frozen now).
- The recipient gets a real editable notebook (`notebooks.kind='shared'`) in a loose **Shared with me** folder, created on the first received copy and ordinary afterwards.
- The sender's original is never modified. No revoke. No separate Forward; sharing the copy again is a new share.
- A received copy can be turned into a group note by its owner.

### Go live

- Instructor only, from their own notebook. One live session per course at a time.
- Students see a live pill and a read-only viewer that follows the host's current page and updates as the host writes.
- The host can end from the editor, including after a reload. Ending materialises a copy for every enrolled student for the same source notebook, pullable or snapshot as chosen at start.
- A copy already received from the same source is updated in place; the recipient's own writing is preserved.
- The live session stores `currentPageId`, `pullable`, `startedAt` and `endedAt`. The viewer polls every 2 s.

### Invite to co-edit (group note)

- The owner invites classmates; invitees get a **Join / Not now** popup and join the same note, not a copy.
- `notebook_members` holds `role` (`owner`/`editor`) and `status` (`active`/`invited`/`declined`). Creator is owner; invitees are editors. Only the owner invites/removes. An editor can leave. The owner cannot be removed; if the owner leaves, ownership transfers to the oldest active editor.
- Group notes live in every member's **My notes** with a Group badge. Filing is per member: `notebook_members.folderId` is that member's own choice, and a newly invited member sees the note at the top level until they file it. Folder ids belong to one student's tree, so they are not inherited from the owner.
- Lecture notebooks cannot be invited: their one-notebook-per-student rule would break. A received copy or standalone notebook can.
- Group notes are excluded from the AI bank entirely.

## Collaboration model

Object-level sync with a three-way merge, not a page lock and not real-time CRDT.

- Every stroke, item and page can carry `authorId`, `origin` (`own`/`shared`), `sourceId`, `localModified` and `lastEditedBy`.
- On a group save the client sends `base` (the last server state it saw) plus the current page. The server merges base/current/stored by object id:
  - local unchanged → follow the stored (server) object;
  - local changed/added → local wins;
  - local deleted → delete.
- Per-user undo restores only objects stamped by the current editor; a classmate's newer objects are left alone.
- Text boxes and memos are objects too; the same rule applies. A per-box typing lock is not implemented in this pass; simultaneous typing in one box is last-write-wins.
- Presence: `notebook_presence` heartbeats the current page; the editor shows avatars and page tooltips. No cursors.
- Polling is 2.5 s for pages and 5 s for presence. No WebSocket.

## Pullable copies

- A copy's pages record `sourcePageId` and `sourceRevision`; every stroke/item from the sender is `origin='shared'` with a `sourceId`.
- The recipient's own ink/items are `origin='own'`.
- `POST /api/notebooks/:id/fetch` merges the source into the copy:
  - shared objects the recipient has not edited follow the source (add/edit/delete);
  - shared objects the recipient edited or moved (`localModified`) stay as they are;
  - shared objects the recipient erased leave a tombstone and never return;
  - a source page that disappears is kept as an own page if the recipient wrote on it, otherwise removed;
  - new source pages are appended.
- The editor shows "From Alex · Pullable/Snapshot", "Fetch updates" when `sourceRevision` is behind the source notebook's `revision`, and "Keep a snapshot" to detach.
- `POST /api/notebooks/:id/detach` stops following the source; the copy keeps a `shareId` for provenance but no longer fetches.

## AI bank isolation

- `kind='shared'`, `kind='group'` and an instructor's notebooks are not raw peer knowledge.
- A received copy contributes only the recipient's `origin='own'` additions on a **slide-anchored page** (`page.kind='slide'` or a confirmed `link.slideId`). The shared layer is excluded from the render and from the hash; a source change does not trigger a recipient re-index.
- Group notes and professor notebooks are skipped by the indexing job (`indexStatus='indexed'`, no fragments).
- The anonymous bank never names a classmate. Direct shares and live handouts are named and may show the sender's name.
- The AI reads two images for a normal page: the page (context) and a white-background ink-only render (handwriting transcription). The ink-only image is the local "handwriting improver"; no learned model is added in this pass.

## Storage

Additive tables/columns (applied automatically on start):

- `students.role`, `enrollments.role`.
- `notebooks.revision`, `shareId`, `sourceNotebookId`, `sourceRevision`, `shareMode`, `deletedSourcePages`.
- `pages.origin`, `sourcePageId`, `sourceRevision`, `sharedTombstones`.
- `course_seeds.sharedId`.
- `notebook_members(notebookId,studentId,role,status,folderId,invitedBy,createdAt,updatedAt)`.
- `notebook_presence(notebookId,studentId,pageId,updatedAt)`.
- `shares(id,courseId,fromStudentId,toStudentId,sourceNotebookId,sourcePageId,copyNotebookId,title,mode,sourceRevision,createdAt,updatedAt,notifiedAt,viewedAt,sourceDeleted)`.
- `live_sessions(id,courseId,hostId,notebookId,title,currentPageId,pullable,startedAt,endedAt)`.

PDF page backgrounds are copied into the recipient's notebook folder because `/api/assets/notebooks/*` is owner-only. Slide backgrounds stay on the shared lecture assets.

## API surface

- `GET /api/courses/:id/members`
- `POST /api/notebooks/:id/share` `{students, wholeClass, mode, pageId}`
- `GET /api/notebooks/:id/shares` (the sender's own "already sent" list; no read receipts)
- `POST /api/notebooks/:id/invite` `{students}`
- `POST /api/notebooks/:id/members/accept|decline`
- `DELETE /api/notebooks/:id/members/:studentId`
- `POST /api/notebooks/:id/fetch`, `POST /api/notebooks/:id/detach`
- `POST /api/notebooks/:id/presence`, `GET /api/notebooks/:id/presence`
- `GET /api/pages/:id` (members), `PUT /api/pages/:id` accepts `base` for group notes
- `GET /api/notices`, `POST /api/shares/:id/seen`
- `POST /api/notebooks/:id/live`, `PATCH /api/live/:id`, `POST /api/live/:id/end`, `GET /api/live/active`, `GET /api/live/:id`, `GET /api/live/:id/page.png`

## UI

- Editor header: **Share** opens the share sheet. Tabs adapt: Send a copy, Invite to co-edit / Members, Go live (instructor only).
- Send a copy: recipient avatars, "Only this page" when opened from the editor, pullable/snapshot cards, a named/irreversible notice. Lecturer notebooks hide co-edit.
- Received copy: banner "From … · Pullable/Snapshot", Fetch updates, Keep a snapshot.
- Group note: banner "Group note · N members", presence avatars, members/invites.
- Live: host banner "Live to the class · N students" + End live; student live pill + full-screen read-only viewer.
- Inbox: a received copy popup with Later/Open; a co-edit invitation with Not now/Join; a live pill. No read receipts.
- Library: Shared with me folder with an unread dot; group badge; From … badge; unread shares.

## Known limits in this pass

- A pull refreshes strokes/items and the source revision; it does not yet copy a source page's paper, background or confirmed link change into an existing copy.
- A failed PDF background copy is logged and leaves a blank page rather than failing the whole share.
- Live sessions have no automatic timeout if the host disappears; the host ends them manually. The host's global live control is the editor banner.
- The share sheet's "Already sent" list dedupes by recipient + mode; page and whole-notebook sends to the same person can collapse to one line.

## Non-goals in this pass

- No revocation of sent copies; no forwarding action; no cross-course shares.
- No true real-time co-editing, cursors, comments or presence beyond avatars/page.
- No learned handwriting-enhancement model; the vector ink render is the improver.
- No TAs, groups/sections, multiple instructors, read receipts, or cross-device account auth.
- No AI-bank ingestion of group notes or professor notes.

## Verification

- `npm run check`: 37 unit/API tests (courses/sharing/copies/group/live/bank), typecheck and production build.
- `npm run test:e2e`: 19 browser scenarios, including a named copy arriving and becoming a group note, and a professor live handout ending in a student copy. Mock model only.
- Relevant regression coverage: source unchanged after a copy; fetch preserves local edits and tombstones; group merge keeps both editors' strokes; group/professor notes create no fragments; shared-copy own additions index with two images; live end leaves each student a copy.
