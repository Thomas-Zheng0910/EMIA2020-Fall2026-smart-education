import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AskMessage,
  AskSession,
  AskSessionSummary,
  Course,
  CourseSummary,
  Folder,
  Fragment,
  Item,
  Lecture,
  Notebook,
  NotebookMember,
  NotebookShare,
  Page,
  PageKind,
  PageLink,
  PaperKind,
  Slide,
  SlideDigest,
  Stroke,
  Student,
} from '../shared/types';

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const id = () => randomUUID();
export const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const now = () => new Date().toISOString();
type Row = Record<string, any>;

/** Object identity for a three-way page merge: compare what was drawn, not who last touched it. */
const META_KEYS = new Set(['authorId', 'origin', 'sourceId', 'localModified', 'lastEditedBy']);
const contentOf = (o: any) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !META_KEYS.has(k)).sort(([a], [b]) => a.localeCompare(b))));
const sameContent = (a: any, b: any) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && contentOf(a) === contentOf(b));
type DrawObject = (Stroke | Item) & Record<string, any>;
const byId = (list: DrawObject[]) => new Map(list.map((o) => [o.id, o]));

const PAPER_KINDS: PaperKind[] = ['ruled', 'grid', 'blank'];
/**
 * The paper a notebook writes on. New notebooks record it explicitly; rows created before that
 * column existed read their first paper page, so an old grid notebook keeps making grid sheets.
 */
const paperOf = (r: Row): PaperKind => (PAPER_KINDS.includes(r.paper) ? r.paper : PAPER_KINDS.includes(r.firstPaper) ? r.firstPaper : 'ruled');

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, code TEXT, name TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY, name TEXT, initials TEXT, color TEXT, role TEXT DEFAULT 'student');
CREATE TABLE IF NOT EXISTS enrollments(studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE, joinedAt TEXT,
  role TEXT DEFAULT 'student', PRIMARY KEY(studentId, courseId));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, path TEXT, mime TEXT, name TEXT, hash TEXT, createdAt TEXT, uploadedBy TEXT);
CREATE TABLE IF NOT EXISTS lectures(id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id), number INTEGER, title TEXT,
  fileId TEXT, pageCount INTEGER DEFAULT 0, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS slides(id TEXT PRIMARY KEY, lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE, page INTEGER,
  width REAL, height REAL, image TEXT, text TEXT, digest TEXT, UNIQUE(lectureId,page));
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, courseId TEXT, studentId TEXT, lectureId TEXT, title TEXT, kind TEXT,
  createdAt TEXT, updatedAt TEXT, revision INTEGER DEFAULT 0, shareId TEXT, sourceNotebookId TEXT, sourceRevision INTEGER DEFAULT 0,
  shareMode TEXT, deletedSourcePages TEXT DEFAULT '[]');
CREATE UNIQUE INDEX IF NOT EXISTS lecture_notebook ON notebooks(studentId, lectureId) WHERE kind='lecture';
CREATE TABLE IF NOT EXISTS notebook_members(notebookId TEXT REFERENCES notebooks(id) ON DELETE CASCADE, studentId TEXT,
  role TEXT, status TEXT, folderId TEXT, invitedBy TEXT, createdAt TEXT, updatedAt TEXT, PRIMARY KEY(notebookId,studentId));
CREATE INDEX IF NOT EXISTS notebook_members_student ON notebook_members(studentId,status);
CREATE TABLE IF NOT EXISTS notebook_presence(notebookId TEXT, studentId TEXT, pageId TEXT, updatedAt TEXT, PRIMARY KEY(notebookId,studentId));
CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, notebookId TEXT REFERENCES notebooks(id) ON DELETE CASCADE, position REAL,
  kind TEXT, slideId TEXT, background TEXT, width REAL, height REAL, strokes TEXT, items TEXT, revision INTEGER DEFAULT 1,
  indexStatus TEXT DEFAULT 'idle', indexError TEXT, indexedRevision INTEGER DEFAULT 0, contentHash TEXT,
  linkLectureId TEXT, linkSlideId TEXT, linkConfidence REAL DEFAULT 0, linkConfirmed INTEGER DEFAULT 0, updatedAt TEXT,
  origin TEXT DEFAULT 'own', sourcePageId TEXT, sourceRevision INTEGER, sharedTombstones TEXT DEFAULT '[]');
CREATE INDEX IF NOT EXISTS pages_nb ON pages(notebookId, position);
CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY, pageId TEXT REFERENCES pages(id) ON DELETE CASCADE, studentId TEXT,
  courseId TEXT, lectureId TEXT, slideId TEXT, kind TEXT, text TEXT, topic TEXT, confidence REAL, bbox TEXT, shared INTEGER,
  pageRevision INTEGER, createdAt TEXT);
CREATE INDEX IF NOT EXISTS frag_slide ON fragments(slideId);
CREATE INDEX IF NOT EXISTS frag_lecture ON fragments(lectureId);
CREATE TABLE IF NOT EXISTS withheld(pageId TEXT, textHash TEXT, PRIMARY KEY(pageId, textHash));
CREATE TABLE IF NOT EXISTS dismissals(studentId TEXT, fragmentId TEXT, PRIMARY KEY(studentId, fragmentId));
CREATE TABLE IF NOT EXISTS quizzes(id TEXT PRIMARY KEY, studentId TEXT, scope TEXT, questions TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS asks(id TEXT PRIMARY KEY, studentId TEXT, pageId TEXT, pageRevision INTEGER, cards TEXT, createdAt TEXT);
-- Ask conversations: a notebook can have many sessions, each with a thread of messages.
CREATE TABLE IF NOT EXISTS ask_sessions(id TEXT PRIMARY KEY, notebookId TEXT REFERENCES notebooks(id) ON DELETE CASCADE,
  studentId TEXT, title TEXT, createdAt TEXT, updatedAt TEXT);
CREATE INDEX IF NOT EXISTS ask_sessions_nb ON ask_sessions(notebookId, studentId, updatedAt);
CREATE TABLE IF NOT EXISTS ask_messages(id TEXT PRIMARY KEY, sessionId TEXT REFERENCES ask_sessions(id) ON DELETE CASCADE,
  role TEXT, text TEXT, cards TEXT, pageId TEXT, pageLabel TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS ask_messages_session ON ask_messages(sessionId, createdAt);
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  parentId TEXT, name TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS folders_owner ON folders(studentId, courseId);
-- Remembers the two folders a course starts with, so seeding runs once even after a student
-- renames or deletes them (with no folders yet, a tree is seeded; after that, never again).
-- The ids are what make the folders ordinary: renaming or moving them keeps lecture decks filed.
CREATE TABLE IF NOT EXISTS course_seeds(studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lecturesId TEXT, quizzesId TEXT, sharedId TEXT, seededAt TEXT, PRIMARY KEY(studentId, courseId));
-- Direct shares: a copy of a notebook (or one page) for one recipient. The source link lets a
-- pullable copy fetch later changes; a snapshot copy ignores the link after it is made.
CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, courseId TEXT, fromStudentId TEXT, toStudentId TEXT,
  sourceNotebookId TEXT, sourcePageId TEXT, copyNotebookId TEXT, title TEXT, mode TEXT, sourceRevision INTEGER DEFAULT 0,
  createdAt TEXT, updatedAt TEXT, notifiedAt TEXT, viewedAt TEXT, sourceDeleted INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS shares_to ON shares(toStudentId, notifiedAt);
CREATE INDEX IF NOT EXISTS shares_source ON shares(sourceNotebookId, toStudentId);
-- A live handout is a broadcast of the host's current page. When it ends, each enrolled student gets
-- a normal copy through the same share machinery, pullable or snapshot as the host chose.
CREATE TABLE IF NOT EXISTS live_sessions(id TEXT PRIMARY KEY, courseId TEXT, hostId TEXT, notebookId TEXT,
  title TEXT, currentPageId TEXT, pullable INTEGER DEFAULT 0, startedAt TEXT, endedAt TEXT);
-- The course knowledge base: one row per point of knowledge on a slide, fed by the fragments
-- that make it. Summaries are written by the merge job; the sources stay internal.
CREATE TABLE IF NOT EXISTS knowledge_entries(id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE, slideId TEXT REFERENCES slides(id) ON DELETE CASCADE,
  title TEXT, summary TEXT, createdAt TEXT, updatedAt TEXT, checkedAt TEXT,
  excludedReason TEXT, disputeExplanation TEXT, sourceHash TEXT);
CREATE INDEX IF NOT EXISTS entry_slide ON knowledge_entries(slideId);
CREATE TABLE IF NOT EXISTS entry_sources(entryId TEXT REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  fragmentId TEXT REFERENCES fragments(id) ON DELETE CASCADE, PRIMARY KEY(entryId, fragmentId));
CREATE TABLE IF NOT EXISTS lecture_topics(id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE, name TEXT, slideIds TEXT);
CREATE INDEX IF NOT EXISTS topic_lecture ON lecture_topics(lectureId);
-- A place in a student's notes where something is missing, found by the page-indexing call.
CREATE TABLE IF NOT EXISTS page_gaps(id TEXT PRIMARY KEY, pageId TEXT REFERENCES pages(id) ON DELETE CASCADE,
  pageRevision INTEGER, bbox TEXT, missing TEXT, entryIds TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS gaps_page ON page_gaps(pageId);
CREATE TABLE IF NOT EXISTS gap_dismissals(studentId TEXT, gapId TEXT, PRIMARY KEY(studentId, gapId));
CREATE TABLE IF NOT EXISTS entry_reports(entryId TEXT, studentId TEXT, reason TEXT, createdAt TEXT, PRIMARY KEY(entryId, studentId));
-- What a slide's notes looked like when the merge job last ran, so unchanged slides cost nothing.
CREATE TABLE IF NOT EXISTS slide_merges(slideId TEXT PRIMARY KEY, sourceHash TEXT, mergedAt TEXT);
-- What a page's slide looked like when its gaps were last checked, so opening a page re-reads it
-- only when a classmate's note actually changed the knowledge behind those gaps.
CREATE TABLE IF NOT EXISTS gap_checks(pageId TEXT PRIMARY KEY, entryHash TEXT, checkedAt TEXT);
`;

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Additive migrations for databases created before these columns existed.
    for (const sql of [
      `ALTER TABLE fragments ADD COLUMN reason TEXT`,
      `ALTER TABLE notebooks ADD COLUMN folderId TEXT`,
      `ALTER TABLE notebooks ADD COLUMN paper TEXT`,
      `ALTER TABLE fragments ADD COLUMN entryId TEXT`,
      `ALTER TABLE fragments ADD COLUMN supersededBy TEXT`,
      `CREATE INDEX IF NOT EXISTS fragments_entry ON fragments(entryId)`,
      `ALTER TABLE students ADD COLUMN role TEXT DEFAULT 'student'`,
      `ALTER TABLE enrollments ADD COLUMN role TEXT DEFAULT 'student'`,
      `ALTER TABLE notebooks ADD COLUMN revision INTEGER DEFAULT 0`,
      `ALTER TABLE notebooks ADD COLUMN shareId TEXT`,
      `ALTER TABLE notebooks ADD COLUMN sourceNotebookId TEXT`,
      `ALTER TABLE notebooks ADD COLUMN sourceRevision INTEGER DEFAULT 0`,
      `ALTER TABLE notebooks ADD COLUMN shareMode TEXT`,
      `ALTER TABLE notebooks ADD COLUMN deletedSourcePages TEXT DEFAULT '[]'`,
      `ALTER TABLE pages ADD COLUMN origin TEXT DEFAULT 'own'`,
      `ALTER TABLE pages ADD COLUMN sourcePageId TEXT`,
      `ALTER TABLE pages ADD COLUMN sourceRevision INTEGER`,
      `ALTER TABLE pages ADD COLUMN sharedTombstones TEXT DEFAULT '[]'`,
      `ALTER TABLE course_seeds ADD COLUMN sharedId TEXT`,
      `ALTER TABLE files ADD COLUMN uploadedBy TEXT`,
    ])
      try {
        this.db.exec(sql);
      } catch {
        /* column exists */
      }
    // Interrupted background work resumes on restart rather than lingering.
    this.db.exec(`UPDATE pages SET indexStatus='queued' WHERE indexStatus='indexing'`);
  }
  close() {
    this.db.close();
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private all(sql: string, ...p: any[]) {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private get(sql: string, ...p: any[]) {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  run(sql: string, ...p: any[]) {
    return this.db.prepare(sql).run(...p);
  }

  // ---------- course & people
  upsertCourse(c: Course) {
    this.run(
      `INSERT INTO courses VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,description=excluded.description`,
      c.id,
      c.code,
      c.name,
      c.description,
    );
  }
  courses(): Course[] {
    return this.all('SELECT id,code,name,description FROM courses ORDER BY code') as Course[];
  }
  course(cid: string): Course {
    const c = this.get(
      `SELECT c.id,c.code,c.name,c.description,
        (SELECT s.name FROM enrollments e JOIN students s ON s.id=e.studentId
          WHERE e.courseId=c.id AND e.role='instructor' ORDER BY e.joinedAt LIMIT 1) instructorName
       FROM courses c WHERE c.id=?`,
      cid,
    );
    if (!c) throw new AppError(404, 'Course not found.');
    return c as Course;
  }
  /** Courses with what the home page needs: counts, a cover slide and this student's last activity. */
  courseSummaries(studentId: string): CourseSummary[] {
    return this.all(
      `SELECT c.id,c.code,c.name,c.description,
        (SELECT COUNT(*) FROM lectures l WHERE l.courseId=c.id) lectureCount,
        (SELECT COUNT(*) FROM notebooks n WHERE n.courseId=c.id AND (
           (n.studentId=? AND n.kind<>'lecture') OR
           (n.kind='group' AND EXISTS (SELECT 1 FROM notebook_members m WHERE m.notebookId=n.id AND m.studentId=? AND m.status='active')))
        ) notebookCount,
        (SELECT COUNT(*) FROM enrollments e WHERE e.courseId=c.id AND e.role='student') memberCount,
        (SELECT s.name FROM enrollments e JOIN students s ON s.id=e.studentId
          WHERE e.courseId=c.id AND e.role='instructor' ORDER BY e.joinedAt LIMIT 1) instructorName,
        (SELECT e.role FROM enrollments e WHERE e.courseId=c.id AND e.studentId=?) myRole,
        (SELECT s.image FROM lectures l JOIN slides s ON s.lectureId=l.id
          WHERE l.courseId=c.id AND EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.courseId=c.id AND e2.studentId=?)
          ORDER BY l.number, s.page LIMIT 1) cover,
        (SELECT MAX(n.updatedAt) FROM notebooks n WHERE n.courseId=c.id AND (
           n.studentId=? OR (n.kind='group' AND EXISTS (SELECT 1 FROM notebook_members m WHERE m.notebookId=n.id AND m.studentId=? AND m.status='active'))
        )) lastActive
       FROM courses c ORDER BY c.code`,
      studentId,
      studentId,
      studentId,
      studentId,
      studentId,
      studentId,
    ).map((r) => ({ ...(r as any), cover: r.cover ? `/api/assets/${r.cover}` : null }));
  }
  enrolledCourseIds(studentId: string): string[] {
    return this.all('SELECT courseId FROM enrollments WHERE studentId=? ORDER BY joinedAt', studentId).map((r) => r.courseId as string);
  }
  isEnrolled(studentId: string, courseId: string) {
    return Boolean(this.get('SELECT 1 FROM enrollments WHERE studentId=? AND courseId=?', studentId, courseId));
  }
  courseRole(studentId: string, courseId: string) {
    return (this.get('SELECT role FROM enrollments WHERE studentId=? AND courseId=?', studentId, courseId)?.role ?? null) as 'student' | 'instructor' | null;
  }
  isInstructor(studentId: string, courseId: string) {
    return this.courseRole(studentId, courseId) === 'instructor';
  }
  /** A professor account is the instructor when a course has no other instructor. */
  ensureInstructorForCourse(studentId: string, courseId: string) {
    if (!this.isEnrolled(studentId, courseId)) return false;
    const other = this.get(`SELECT 1 FROM enrollments WHERE courseId=? AND role='instructor' AND studentId<>? LIMIT 1`, courseId, studentId);
    if (other) return false;
    this.run(`UPDATE enrollments SET role='instructor' WHERE studentId=? AND courseId=?`, studentId, courseId);
    return true;
  }
  /** Joining a course is what gives the student its two starting folders, however they joined. */
  enroll(studentId: string, courseId: string, role: 'student' | 'instructor' = 'student') {
    this.run('INSERT INTO enrollments(studentId,courseId,joinedAt,role) VALUES(?,?,?,?) ON CONFLICT(studentId,courseId) DO NOTHING', studentId, courseId, now(), role);
    this.seedCourseFolders(courseId, studentId);
  }
  unenroll(studentId: string, courseId: string) {
    // A group note must not be left with an owner who can no longer enter the course. Hand it to
    // the oldest active member who is still enrolled; otherwise the owner row stays for a rejoin.
    const groups = this.all(
      `SELECT n.id, m.role FROM notebooks n JOIN notebook_members m ON m.notebookId=n.id AND m.studentId=?
       WHERE n.courseId=? AND n.kind='group'`,
      studentId,
      courseId,
    ) as { id: string; role: string }[];
    for (const g of groups) {
      if (g.role === 'owner') {
        const next = this.handOverNotebook(g.id, studentId);
        if (next) this.removeNotebookMember(g.id, studentId);
      } else {
        this.removeNotebookMember(g.id, studentId);
      }
    }
    this.run('DELETE FROM enrollments WHERE studentId=? AND courseId=?', studentId, courseId);
    this.run('UPDATE live_sessions SET endedAt=? WHERE hostId=? AND courseId=? AND endedAt IS NULL', now(), studentId, courseId);
  }
  upsertStudent(s: Student) {
    this.run(
      `INSERT INTO students(id,name,initials,color,role) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,initials=excluded.initials,color=excluded.color,role=excluded.role`,
      s.id,
      s.name,
      s.initials,
      s.color,
      s.role ?? 'student',
    );
  }
  students(): Student[] {
    return this.all('SELECT * FROM students ORDER BY rowid') as Student[];
  }
  student(sid: string): Student {
    const s = this.get('SELECT * FROM students WHERE id=?', sid);
    if (!s) throw new AppError(400, 'Unknown student identity.');
    return s as Student;
  }
  /** Everyone enrolled in a course, with their role; the share sheet filters to students. */
  courseMembers(courseId: string) {
    return this.all(
      `SELECT s.id,s.name,s.initials,s.color,s.role,e.role courseRole
       FROM enrollments e JOIN students s ON s.id=e.studentId WHERE e.courseId=? ORDER BY e.role DESC, s.name`,
      courseId,
    ) as (Student & { courseRole: string })[];
  }

  // ---------- files
  addFile(path: string, mime: string, name: string, digest: string, uploadedBy: string | null = null) {
    const fid = id();
    this.run('INSERT INTO files(id,path,mime,name,hash,createdAt,uploadedBy) VALUES(?,?,?,?,?,?,?)', fid, path, mime, name, digest, now(), uploadedBy);
    return fid;
  }
  file(fid: string) {
    return this.get('SELECT * FROM files WHERE id=?', fid) as
      | { id: string; path: string; mime: string; name: string; uploadedBy: string | null }
      | undefined;
  }
  /** An uploaded image is readable by its uploader or by someone with a page that uses it. */
  canAccessFile(fileId: string, studentId: string) {
    const f = this.file(fileId);
    if (!f) return false;
    if (f.uploadedBy === studentId) return true;
    const uses = this.all(`SELECT DISTINCT p.notebookId FROM pages p WHERE p.items LIKE ?`, `%"fileId":"${fileId}"%`) as {
      notebookId: string;
    }[];
    return uses.some((u) => {
      const nb = this.notebook(u.notebookId);
      return this.isEnrolled(studentId, nb.courseId) && this.canAccessNotebook(u.notebookId, studentId);
    });
  }

  // ---------- lectures & slides
  addLecture(courseId: string, number: number, title: string, fileId: string) {
    const lid = id();
    this.run(
      'INSERT INTO lectures(id,courseId,number,title,fileId,status) VALUES(?,?,?,?,?,?)',
      lid,
      courseId,
      number,
      title,
      fileId,
      'rendering',
    );
    return lid;
  }
  setLecture(lid: string, patch: { status?: string; error?: string | null; pageCount?: number }) {
    for (const [k, v] of Object.entries(patch)) this.run(`UPDATE lectures SET ${k}=? WHERE id=?`, v, lid);
  }
  lectures(courseId: string): Lecture[] {
    return this.all(
      `SELECT l.id,l.courseId,l.number,l.title,l.pageCount,l.status,l.error,
       (SELECT COUNT(*) FROM slides s WHERE s.lectureId=l.id AND s.digest IS NOT NULL) digested
       FROM lectures l WHERE courseId=? ORDER BY number`,
      courseId,
    ) as Lecture[];
  }
  /** Per-lecture progress for one student: their notebook, slides written on, classmates' notes. */
  lectureProgress(courseId: string, studentId: string) {
    return this.all(
      `SELECT l.id lectureId, n.id notebookId, n.updatedAt, n.folderId,
        (SELECT COUNT(*) FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]')) written,
        (SELECT p.id FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]') ORDER BY p.updatedAt DESC LIMIT 1) lastPageId,
        (SELECT COUNT(*) FROM fragments f WHERE f.lectureId=l.id AND f.shared=1 AND f.studentId<>?
           AND f.id NOT IN (SELECT fragmentId FROM dismissals WHERE studentId=?)
           AND NOT EXISTS (SELECT 1 FROM enrollments er WHERE er.studentId=f.studentId AND er.courseId=l.courseId AND er.role='instructor')) peerNotes
       FROM lectures l LEFT JOIN notebooks n ON n.lectureId=l.id AND n.studentId=? AND n.kind='lecture' WHERE l.courseId=?`,
      studentId,
      studentId,
      studentId,
      courseId,
    ) as { lectureId: string; notebookId: string | null; updatedAt: string | null; folderId: string | null; written: number; lastPageId: string | null; peerNotes: number }[];
  }
  /** Recently edited notebooks across a student's courses (lecture notebooks only once written in). */
  recentNotebooks(studentId: string, limit = 4) {
    return this.all(
      `SELECT n.id, n.title, n.kind, n.courseId, c.code courseCode, n.updatedAt,
        (SELECT p.id FROM pages p WHERE p.notebookId=n.id ORDER BY p.updatedAt DESC LIMIT 1) lastPageId
       FROM notebooks n JOIN courses c ON c.id=n.courseId
       JOIN enrollments e ON e.courseId=n.courseId AND e.studentId=?
       WHERE (n.studentId=? OR (n.kind='group' AND EXISTS (SELECT 1 FROM notebook_members m WHERE m.notebookId=n.id AND m.studentId=? AND m.status='active')))
         AND (n.kind<>'lecture' OR EXISTS (SELECT 1 FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]')))
       ORDER BY n.updatedAt DESC LIMIT ?`,
      studentId,
      studentId,
      studentId,
      limit,
    ) as { id: string; title: string; kind: string; courseId: string; courseCode: string; updatedAt: string; lastPageId: string | null }[];
  }
  lecture(lid: string): Lecture & { fileId: string } {
    const l = this.get(
      `SELECT l.*, (SELECT COUNT(*) FROM slides s WHERE s.lectureId=l.id AND s.digest IS NOT NULL) digested FROM lectures l WHERE id=?`,
      lid,
    );
    if (!l) throw new AppError(404, 'Lecture not found.');
    return l as any;
  }
  addSlide(lectureId: string, page: number, width: number, height: number, image: string, text: string) {
    const sid = id();
    this.run(
      'INSERT INTO slides(id,lectureId,page,width,height,image,text) VALUES(?,?,?,?,?,?,?)',
      sid,
      lectureId,
      page,
      width,
      height,
      image,
      text,
    );
    return sid;
  }
  private slideRow = (r: Row): Slide & { image: string } => ({
    id: r.id,
    lectureId: r.lectureId,
    page: r.page,
    width: r.width,
    height: r.height,
    text: r.text,
    image: r.image,
    digest: r.digest ? JSON.parse(r.digest) : null,
  });
  slides(lectureId: string) {
    return this.all('SELECT * FROM slides WHERE lectureId=? ORDER BY page', lectureId).map(this.slideRow);
  }
  slide(sid: string) {
    const r = this.get('SELECT * FROM slides WHERE id=?', sid);
    return r ? this.slideRow(r) : null;
  }
  setDigest(sid: string, d: SlideDigest) {
    this.run('UPDATE slides SET digest=? WHERE id=?', JSON.stringify(d), sid);
  }
  /** Compact outline of every lecture, used to link non-slide pages. */
  outline(courseId: string) {
    return this.all(
      `SELECT l.number, s.page, s.id slideId, l.id lectureId, l.title lectureTitle, s.digest, substr(s.text,1,90) text
       FROM slides s JOIN lectures l ON l.id=s.lectureId WHERE l.courseId=? ORDER BY l.number, s.page`,
      courseId,
    ).map((r) => ({
      lectureNumber: r.number as number,
      lectureId: r.lectureId as string,
      lectureTitle: r.lectureTitle as string,
      page: r.page as number,
      slideId: r.slideId as string,
      title: r.digest ? (JSON.parse(r.digest).title as string) : String(r.text ?? '').replace(/\s+/g, ' '),
    }));
  }

  // ---------- the course file tree
  /**
   * Every file a student can see in a course, flattened: their notebooks (with where each is filed)
   * and the official decks. A deck is one shared `lectures` row; the student's own editable copy
   * (`notebooks.kind='lecture'`) exists only once they open it, so it is reported separately and the
   * client files the untouched deck in the course's Lectures folder.
   */
  courseFiles(courseId: string, studentId: string) {
    const prog = new Map(this.lectureProgress(courseId, studentId).map((p) => [p.lectureId, p]));
    const decks = this.all(
      `SELECT l.id lectureId, l.courseId, l.number, l.title, l.pageCount, l.status FROM lectures l WHERE l.courseId=? ORDER BY l.number`,
      courseId,
    ) as { lectureId: string; courseId: string; number: number; title: string; pageCount: number; status: string }[];
    const seated = this.lecturesFolder(courseId, studentId) ?? null;
    return {
      lecturesFolderId: seated,
      sharedFolderId: this.sharedFolder(courseId, studentId),
      unreadShares: this.unreadShares(courseId, studentId),
      folders: this.folders(courseId, studentId),
      // A deck is listed with the decks, not again as one of the student's own notebooks.
      notes: this.notebooks(courseId, studentId).filter((n) => n.kind !== 'lecture'),
      decks: decks.map((d) => {
        const p = prog.get(d.lectureId);
        return {
          ...d,
          notebookId: p?.notebookId ?? null,
          // An unopened deck sits in the course's Lectures folder; once opened, wherever the student put it.
          folderId: p?.notebookId ? p.folderId : seated,
          written: p?.written ?? 0,
          lastPageId: p?.lastPageId ?? null,
          updatedAt: p?.updatedAt ?? null,
        };
      }),
    };
  }

  notebooks(courseId: string, studentId: string): Notebook[] {
    return this.all(
      `SELECT n.*, (SELECT COUNT(*) FROM pages p WHERE p.notebookId=n.id) pageCount,
       (SELECT COALESCE(p.background, s.image) FROM pages p LEFT JOIN slides s ON s.id=p.slideId WHERE p.notebookId=n.id ORDER BY position LIMIT 1) cover,
       (SELECT COUNT(*) FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]')) written,
       (SELECT p.id FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]') ORDER BY p.updatedAt DESC LIMIT 1) lastPageId,
       (SELECT p.kind FROM pages p WHERE p.notebookId=n.id AND p.kind NOT IN ('slide','pdf') ORDER BY position LIMIT 1) firstPaper,
       CASE WHEN n.studentId=? THEN 'owner' WHEN m.role IS NOT NULL THEN m.role ELSE 'owner' END role,
       COALESCE(NULLIF((SELECT COUNT(*) FROM notebook_members x WHERE x.notebookId=n.id AND x.status='active'),0),1) memberCount,
       CASE WHEN n.studentId=? THEN COALESCE(m.folderId,n.folderId) ELSE m.folderId END effectiveFolderId,
       sh.sourceDeleted shareSourceDeleted, sh.sourcePageId shareSourcePageId,
       (SELECT revision FROM pages sp WHERE sp.id=sh.sourcePageId) shareSourcePageRevision,
       src.revision sourceCurrentRevision, ss.name shareFromName
       FROM notebooks n
       LEFT JOIN notebook_members m ON m.notebookId=n.id AND m.studentId=?
       LEFT JOIN shares sh ON sh.copyNotebookId=n.id AND sh.toStudentId=?
       LEFT JOIN notebooks src ON src.id=n.sourceNotebookId
       LEFT JOIN students ss ON ss.id=sh.fromStudentId
       WHERE n.courseId=? AND (n.studentId=? OR (n.kind='group' AND m.status='active'))
       ORDER BY n.updatedAt DESC`,
      studentId,
      studentId,
      studentId,
      studentId,
      courseId,
      studentId,
    ).map((r) => {
      const pageSource = Boolean(r.shareSourcePageId);
      const currentSourceRevision = pageSource ? (r.shareSourcePageRevision ?? 0) : (r.sourceCurrentRevision ?? r.sourceRevision ?? 0);
      return {
        ...(r as any),
        ownerId: r.studentId,
        folderId: r.effectiveFolderId ?? null,
        paper: paperOf(r),
        cover: r.cover ? `/api/assets/${r.cover}` : null,
        share: r.shareId
          ? {
              id: r.shareId,
              mode: r.shareMode === 'pull' ? 'pull' : 'snapshot',
              fromName: r.shareFromName ?? 'A classmate',
              sourceNotebookId: r.sourceNotebookId,
              sourceRevision: r.sourceRevision ?? 0,
              currentSourceRevision,
              updatesAvailable: r.shareMode === 'pull' && !r.shareSourceDeleted && currentSourceRevision > (r.sourceRevision ?? 0),
              sourceDeleted:
                Boolean(r.shareSourceDeleted) || (pageSource ? r.shareSourcePageRevision == null : r.sourceCurrentRevision == null),
            }
          : null,
      };
    });
  }
  notebook(nid: string): Notebook {
    const r = this.get(
      `SELECT n.*, (SELECT COUNT(*) FROM pages p WHERE p.notebookId=n.id) pageCount,
       (SELECT p.kind FROM pages p WHERE p.notebookId=n.id AND p.kind NOT IN ('slide','pdf') ORDER BY position LIMIT 1) firstPaper
       FROM notebooks n WHERE id=?`,
      nid,
    );
    if (!r) throw new AppError(404, 'Notebook not found.');
    return { ...(r as any), ownerId: r.studentId, folderId: r.folderId ?? null, paper: paperOf(r), cover: null };
  }
  /** The notebook as one particular member sees it: membership, role, group size and share provenance. */
  notebookFor(nid: string, studentId: string): Notebook {
    const n = this.notebook(nid);
    const m = this.notebookMember(nid, studentId);
    if (n.studentId !== studentId && !(n.kind === 'group' && m?.status === 'active'))
      throw new AppError(403, 'This notebook belongs to other students.');
    const share = n.shareId ? this.shareForCopy(nid, studentId) : null;
    return {
      ...n,
      ownerId: n.studentId,
      role: n.studentId === studentId ? 'owner' : m?.role === 'owner' ? 'owner' : 'editor',
      memberCount: Math.max(1, this.notebookMembers(nid).filter((x) => x.status === 'active').length),
      members: n.kind === 'group' ? this.notebookMembers(nid) : undefined,
      folderId: n.studentId === studentId ? (m?.folderId ?? n.folderId) : (m?.folderId ?? null),
      share,
    };
  }
  canAccessNotebook(nid: string, studentId: string) {
    const n = this.notebook(nid);
    if (n.studentId === studentId) return true;
    const m = this.notebookMember(nid, studentId);
    return n.kind === 'group' && m?.status === 'active';
  }
  shareForCopy(nid: string, studentId: string): NotebookShare | null {
    const r = this.get(
      `SELECT sh.id, sh.mode, sh.sourceNotebookId, sh.sourcePageId, sh.sourceRevision, sh.sourceDeleted, sh.fromStudentId,
        (SELECT revision FROM pages sp WHERE sp.id=sh.sourcePageId) sourcePageRevision,
        src.revision currentSourceRevision, s.name fromName
       FROM shares sh LEFT JOIN notebooks src ON src.id=sh.sourceNotebookId LEFT JOIN students s ON s.id=sh.fromStudentId
       WHERE sh.copyNotebookId=? AND sh.toStudentId=? LIMIT 1`,
      nid,
      studentId,
    );
    if (!r) return null;
    const currentSourceRevision = r.sourcePageId ? (r.sourcePageRevision ?? 0) : (r.currentSourceRevision ?? r.sourceRevision ?? 0);
    return {
      id: r.id,
      mode: r.mode === 'pull' ? 'pull' : 'snapshot',
      fromName: r.fromName ?? 'A classmate',
      sourceNotebookId: r.sourceNotebookId,
      sourceRevision: r.sourceRevision ?? 0,
      currentSourceRevision,
      updatesAvailable: r.mode === 'pull' && !r.sourceDeleted && currentSourceRevision > (r.sourceRevision ?? 0),
      sourceDeleted:
        Boolean(r.sourceDeleted) || (r.sourcePageId ? r.sourcePageRevision == null : Boolean(r.sourceNotebookId) && r.currentSourceRevision == null),
    };
  }
  createNotebook(n: {
    courseId: string;
    studentId: string;
    lectureId: string | null;
    title: string;
    kind: Notebook['kind'];
    folderId?: string | null;
    paper?: PaperKind;
  }) {
    const nid = id();
    this.run(
      'INSERT INTO notebooks(id,courseId,studentId,lectureId,title,kind,createdAt,updatedAt,folderId,paper) VALUES(?,?,?,?,?,?,?,?,?,?)',
      nid,
      n.courseId,
      n.studentId,
      n.lectureId,
      n.title,
      n.kind,
      now(),
      now(),
      n.folderId ?? null,
      n.paper ?? 'ruled',
    );
    return nid;
  }
  /** Filing a notebook does not count as editing it, so the "newest first" order stays put. */
  setNotebookFolder(nid: string, folderId: string | null) {
    this.run('UPDATE notebooks SET folderId=? WHERE id=?', folderId, nid);
  }
  /** The paper new sheets are made from; existing pages keep the paper they were made with. */
  setNotebookPaper(nid: string, paper: PaperKind) {
    this.run('UPDATE notebooks SET paper=? WHERE id=?', paper, nid);
  }
  setNotebookKind(nid: string, kind: Notebook['kind']) {
    this.run('UPDATE notebooks SET kind=?, updatedAt=? WHERE id=?', kind, now(), nid);
  }
  /** Copies and group notes keep the source link for pullable updates. */
  setNotebookShare(nid: string, share: { shareId: string | null; sourceNotebookId: string | null; sourceRevision: number; shareMode: string | null }) {
    this.run(
      'UPDATE notebooks SET shareId=?, sourceNotebookId=?, sourceRevision=?, shareMode=? WHERE id=?',
      share.shareId,
      share.sourceNotebookId,
      share.sourceRevision,
      share.shareMode,
      nid,
    );
  }
  bumpNotebookRevision(nid: string) {
    this.run('UPDATE notebooks SET revision=revision+1, updatedAt=? WHERE id=?', now(), nid);
  }
  deletedSourcePages(nid: string): string[] {
    const r = this.get('SELECT deletedSourcePages FROM notebooks WHERE id=?', nid);
    try {
      return JSON.parse((r?.deletedSourcePages as string) || '[]');
    } catch {
      return [];
    }
  }
  addDeletedSourcePage(nid: string, sourcePageId: string) {
    const list = this.deletedSourcePages(nid);
    if (!list.includes(sourcePageId)) this.run('UPDATE notebooks SET deletedSourcePages=? WHERE id=?', JSON.stringify([...list, sourcePageId]), nid);
  }

  // ---------- co-owned notebooks
  notebookMember(nid: string, studentId: string) {
    return this.get('SELECT notebookId,studentId,role,status,folderId FROM notebook_members WHERE notebookId=? AND studentId=?', nid, studentId) as
      | { notebookId: string; studentId: string; role: 'owner' | 'editor'; status: 'active' | 'invited' | 'declined'; folderId: string | null }
      | undefined;
  }
  notebookMembers(nid: string): NotebookMember[] {
    return this.all(
      `SELECT s.id,s.name,s.initials,s.color,m.role,m.status,p.pageId,p.updatedAt
       FROM notebook_members m JOIN students s ON s.id=m.studentId
       LEFT JOIN notebook_presence p ON p.notebookId=m.notebookId AND p.studentId=m.studentId
       WHERE m.notebookId=? AND m.status IN ('active','invited') ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.createdAt`,
      nid,
    ).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      initials: r.initials as string,
      color: r.color as string,
      role: (r.role as 'owner' | 'editor') ?? 'editor',
      status: (r.status as 'active' | 'invited') ?? 'active',
      pageId: (r.pageId ?? null) as string | null,
      updatedAt: (r.updatedAt ?? null) as string | null,
    }));
  }
  ensureNotebookOwner(nid: string, ownerId: string) {
    const existing = this.notebookMember(nid, ownerId);
    if (existing) {
      if (existing.status !== 'active' || existing.role !== 'owner')
        this.run(`UPDATE notebook_members SET role='owner',status='active',updatedAt=? WHERE notebookId=? AND studentId=?`, now(), nid, ownerId);
      return;
    }
    this.run(
      `INSERT INTO notebook_members(notebookId,studentId,role,status,folderId,invitedBy,createdAt,updatedAt)
       VALUES(?,?, 'owner','active',NULL,NULL,?,?)`,
      nid,
      ownerId,
      now(),
      now(),
    );
  }
  inviteNotebookMember(nid: string, studentId: string, invitedBy: string) {
    this.run(
      `INSERT INTO notebook_members(notebookId,studentId,role,status,folderId,invitedBy,createdAt,updatedAt)
       VALUES(?,?, 'editor','invited',NULL,?,?,?)
       ON CONFLICT(notebookId,studentId) DO UPDATE SET
         status=CASE WHEN notebook_members.status='active' THEN 'active' ELSE 'invited' END,
         invitedBy=excluded.invitedBy, updatedAt=excluded.updatedAt`,
      nid,
      studentId,
      invitedBy,
      now(),
      now(),
    );
  }
  acceptNotebookInvite(nid: string, studentId: string) {
    this.run(`UPDATE notebook_members SET status='active',updatedAt=? WHERE notebookId=? AND studentId=? AND status='invited'`, now(), nid, studentId);
  }
  declineNotebookInvite(nid: string, studentId: string) {
    this.run(`UPDATE notebook_members SET status='declined',updatedAt=? WHERE notebookId=? AND studentId=? AND status='invited'`, now(), nid, studentId);
  }
  removeNotebookMember(nid: string, studentId: string) {
    this.run('DELETE FROM notebook_members WHERE notebookId=? AND studentId=?', nid, studentId);
    this.run('DELETE FROM notebook_presence WHERE notebookId=? AND studentId=?', nid, studentId);
  }
  setMemberFolder(nid: string, studentId: string, folderId: string | null) {
    this.run('UPDATE notebook_members SET folderId=?,updatedAt=? WHERE notebookId=? AND studentId=?', folderId, now(), nid, studentId);
  }
  /** If the owner leaves, the oldest active editor takes over rather than orphaning the note. */
  handOverNotebook(nid: string, from: string) {
    const next = this.get(
      `SELECT m.studentId FROM notebook_members m JOIN notebooks n ON n.id=m.notebookId
       JOIN enrollments e ON e.studentId=m.studentId AND e.courseId=n.courseId
       WHERE m.notebookId=? AND m.studentId<>? AND m.status='active' ORDER BY m.createdAt LIMIT 1`,
      nid,
      from,
    )?.studentId as string | undefined;
    if (!next) return null;
    this.run(`UPDATE notebook_members SET role='owner',updatedAt=? WHERE notebookId=? AND studentId=?`, now(), nid, next);
    // The old folder id belongs to the departed owner's tree, so the new owner starts at the top.
    this.run('UPDATE notebooks SET studentId=?, folderId=NULL WHERE id=?', next, nid);
    return next;
  }
  touchPresence(nid: string, studentId: string, pageId: string | null) {
    this.run('INSERT OR REPLACE INTO notebook_presence VALUES(?,?,?,?)', nid, studentId, pageId, now());
  }
  presence(nid: string) {
    return this.all(
      `SELECT p.studentId, p.pageId, p.updatedAt, s.name, s.initials, s.color
       FROM notebook_presence p JOIN students s ON s.id=p.studentId WHERE p.notebookId=? ORDER BY p.updatedAt DESC`,
      nid,
    ) as { studentId: string; pageId: string | null; updatedAt: string; name: string; initials: string; color: string }[];
  }

  // ---------- direct shares
  getShareFor(sourceNotebookId: string, toStudentId: string, sourcePageId: string | null) {
    return this.get(
      `SELECT id,copyNotebookId,sourceRevision,mode,sourcePageId FROM shares
       WHERE sourceNotebookId=? AND toStudentId=? AND sourcePageId IS ? LIMIT 1`,
      sourceNotebookId,
      toStudentId,
      sourcePageId,
    ) as { id: string; copyNotebookId: string; sourceRevision: number; mode: string; sourcePageId: string | null } | undefined;
  }
  createShare(s: {
    courseId: string;
    fromStudentId: string;
    toStudentId: string;
    sourceNotebookId: string;
    sourcePageId: string | null;
    copyNotebookId: string;
    title: string;
    mode: string;
    sourceRevision: number;
  }) {
    const existing = this.get(
      `SELECT id FROM shares WHERE sourceNotebookId=? AND toStudentId=? AND (sourcePageId IS ? OR sourcePageId=?) LIMIT 1`,
      s.sourceNotebookId,
      s.toStudentId,
      s.sourcePageId,
      s.sourcePageId,
    ) as { id: string } | undefined;
    const sid = existing?.id ?? id();
    if (existing) {
      this.run(
        'UPDATE shares SET copyNotebookId=?, title=?, mode=?, sourceRevision=?, updatedAt=?, notifiedAt=NULL, viewedAt=NULL, sourceDeleted=0 WHERE id=?',
        s.copyNotebookId,
        s.title,
        s.mode,
        s.sourceRevision,
        now(),
        sid,
      );
    } else {
      this.run(
        `INSERT INTO shares(id,courseId,fromStudentId,toStudentId,sourceNotebookId,sourcePageId,copyNotebookId,title,mode,sourceRevision,createdAt,updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        sid,
        s.courseId,
        s.fromStudentId,
        s.toStudentId,
        s.sourceNotebookId,
        s.sourcePageId,
        s.copyNotebookId,
        s.title,
        s.mode,
        s.sourceRevision,
        now(),
        now(),
      );
    }
    return sid;
  }
  shareByCopy(copyNotebookId: string) {
    return this.get('SELECT * FROM shares WHERE copyNotebookId=? LIMIT 1', copyNotebookId) as
      | { id: string; courseId: string; fromStudentId: string; toStudentId: string; sourceNotebookId: string; sourcePageId: string | null; copyNotebookId: string; title: string; mode: string; sourceRevision: number; sourceDeleted: number }
      | undefined;
  }
  shareById(shareId: string) {
    return this.get('SELECT * FROM shares WHERE id=?', shareId) as
      | { id: string; courseId: string; fromStudentId: string; toStudentId: string; sourceNotebookId: string; sourcePageId: string | null; copyNotebookId: string; title: string; mode: string; sourceRevision: number; sourceDeleted: number }
      | undefined;
  }
  /** A source that becomes a group note must not keep feeding old private copies silently. */
  detachSharesFrom(notebookId: string) {
    const rows = this.all(`SELECT id, copyNotebookId FROM shares WHERE sourceNotebookId=? AND mode='pull'`, notebookId) as {
      id: string;
      copyNotebookId: string;
    }[];
    for (const row of rows) {
      this.run(`UPDATE shares SET mode='snapshot', updatedAt=? WHERE id=?`, now(), row.id);
      this.run(`UPDATE notebooks SET shareMode='snapshot' WHERE id=?`, row.copyNotebookId);
    }
    return rows.length;
  }
  updateShareSync(shareId: string, sourceRevision: number, sourceDeleted = false) {
    this.run('UPDATE shares SET sourceRevision=?, sourceDeleted=?, updatedAt=? WHERE id=?', sourceRevision, sourceDeleted ? 1 : 0, now(), shareId);
  }
  setShareMode(shareId: string, mode: string) {
    this.run('UPDATE shares SET mode=?, updatedAt=? WHERE id=?', mode, now(), shareId);
  }
  markShareNotified(shareId: string) {
    this.run('UPDATE shares SET notifiedAt=? WHERE id=?', now(), shareId);
  }
  markShareViewed(shareId: string) {
    this.run('UPDATE shares SET viewedAt=? WHERE id=?', now(), shareId);
  }
  /** Opening a received copy counts as seeing its notice, even if it was reached from the folder. */
  markCopySeen(copyNotebookId: string, studentId: string) {
    this.run(
      'UPDATE shares SET notifiedAt=COALESCE(notifiedAt,?), viewedAt=COALESCE(viewedAt,?) WHERE copyNotebookId=? AND toStudentId=?',
      now(),
      now(),
      copyNotebookId,
      studentId,
    );
  }
  /** Who this sender has already sent a copy of this notebook to (no read receipts). */
  sharesFrom(notebookId: string, fromStudentId: string) {
    return this.all(
      `SELECT sh.toStudentId, sh.mode, sh.createdAt, s.name toName
       FROM shares sh JOIN students s ON s.id=sh.toStudentId
       WHERE sh.sourceNotebookId=? AND sh.fromStudentId=? ORDER BY sh.createdAt DESC`,
      notebookId,
      fromStudentId,
    ) as { toStudentId: string; mode: string; createdAt: string; toName: string }[];
  }
  pendingShares(studentId: string) {
    return this.all(
      `SELECT sh.id shareId, sh.copyNotebookId notebookId, sh.courseId, sh.title, sh.mode, sh.createdAt, s.name fromName
       FROM shares sh JOIN students s ON s.id=sh.fromStudentId JOIN notebooks n ON n.id=sh.copyNotebookId
       JOIN enrollments e ON e.courseId=sh.courseId AND e.studentId=sh.toStudentId
       WHERE sh.toStudentId=? AND sh.notifiedAt IS NULL AND sh.copyNotebookId IS NOT NULL ORDER BY sh.createdAt`,
      studentId,
    ) as { shareId: string; notebookId: string; courseId: string; title: string; mode: string; createdAt: string; fromName: string }[];
  }
  pendingInvites(studentId: string) {
    return this.all(
      `SELECT m.notebookId, n.courseId, n.title, m.updatedAt createdAt, s.name fromName
       FROM notebook_members m JOIN notebooks n ON n.id=m.notebookId JOIN students s ON s.id=m.invitedBy
       JOIN enrollments e ON e.courseId=n.courseId AND e.studentId=m.studentId
       WHERE m.studentId=? AND m.status='invited' AND n.kind='group' ORDER BY m.updatedAt`,
      studentId,
    ) as { notebookId: string; courseId: string; title: string; createdAt: string; fromName: string }[];
  }
  unreadShares(courseId: string, studentId: string) {
    return (this.get(
      `SELECT COUNT(*) n FROM shares WHERE courseId=? AND toStudentId=? AND viewedAt IS NULL AND copyNotebookId IS NOT NULL`,
      courseId,
      studentId,
    )?.n ?? 0) as number;
  }
  // ---------- live handouts
  createLiveSession(s: { courseId: string; hostId: string; notebookId: string; title: string; currentPageId: string | null; pullable: boolean }) {
    const lid = id();
    this.run(
      'INSERT INTO live_sessions(id,courseId,hostId,notebookId,title,currentPageId,pullable,startedAt) VALUES(?,?,?,?,?,?,?,?)',
      lid,
      s.courseId,
      s.hostId,
      s.notebookId,
      s.title,
      s.currentPageId,
      s.pullable ? 1 : 0,
      now(),
    );
    return lid;
  }
  liveSession(lid: string) {
    const r = this.get('SELECT * FROM live_sessions WHERE id=?', lid);
    if (!r) throw new AppError(404, 'That live session has ended.');
    return r as { id: string; courseId: string; hostId: string; notebookId: string; title: string; currentPageId: string | null; pullable: number; startedAt: string; endedAt: string | null };
  }
  activeLive(courseId: string) {
    const r = this.get('SELECT * FROM live_sessions WHERE courseId=? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1', courseId);
    return r as { id: string; courseId: string; hostId: string; notebookId: string; title: string; currentPageId: string | null; pullable: number; startedAt: string; endedAt: string | null } | undefined;
  }
  updateLivePage(lid: string, pageId: string | null) {
    this.run('UPDATE live_sessions SET currentPageId=? WHERE id=?', pageId, lid);
  }
  endLive(lid: string) {
    this.run('UPDATE live_sessions SET endedAt=? WHERE id=? AND endedAt IS NULL', now(), lid);
  }
  audience(courseId: string, hostId: string) {
    return (this.get(`SELECT COUNT(*) n FROM enrollments WHERE courseId=? AND role='student' AND studentId<>?`, courseId, hostId)?.n ?? 0) as number;
  }

  /** The loose folder that received copies land in; created on the first share and never re-seeded. */
  sharedFolder(courseId: string, studentId: string) {
    const row = this.get('SELECT sharedId FROM course_seeds WHERE studentId=? AND courseId=?', studentId, courseId);
    if (!row) return null;
    const fid = row.sharedId as string | null;
    if (!fid) return null;
    // The id stays even if the folder was deleted, so a later share does not silently recreate it.
    return (this.get('SELECT id FROM folders WHERE id=? AND studentId=? AND courseId=?', fid, studentId, courseId)?.id as string | undefined) ?? null;
  }
  ensureSharedFolder(courseId: string, studentId: string) {
    this.seedCourseFolders(courseId, studentId);
    const row = this.get('SELECT sharedId FROM course_seeds WHERE studentId=? AND courseId=?', studentId, courseId);
    if (row?.sharedId) return this.sharedFolder(courseId, studentId);
    const fid = this.createFolder({ courseId, studentId, parentId: null, name: 'Shared with me' });
    this.run('UPDATE course_seeds SET sharedId=? WHERE studentId=? AND courseId=?', fid, studentId, courseId);
    return fid;
  }

  // ---------- folders (a student's own organization inside "My notes" of one course)
  folders(courseId: string, studentId: string): Folder[] {
    return this.all('SELECT id,courseId,parentId,name FROM folders WHERE courseId=? AND studentId=? ORDER BY name COLLATE NOCASE', courseId, studentId) as Folder[];
  }
  folder(fid: string): Folder & { studentId: string } {
    const f = this.get('SELECT id,courseId,studentId,parentId,name FROM folders WHERE id=?', fid);
    if (!f) throw new AppError(404, 'Folder not found.');
    return f as Folder & { studentId: string };
  }
  createFolder(f: { courseId: string; studentId: string; parentId: string | null; name: string }) {
    const fid = id();
    this.run('INSERT INTO folders VALUES(?,?,?,?,?,?)', fid, f.studentId, f.courseId, f.parentId, f.name, now());
    return fid;
  }
  renameFolder(fid: string, name: string) {
    this.run('UPDATE folders SET name=? WHERE id=?', name, fid);
  }
  /** Deleting a folder never deletes notes: its notebooks and subfolders move up to its parent. */
  deleteFolder(fid: string) {
    this.tx(() => {
      const f = this.folder(fid);
      this.run('UPDATE folders SET parentId=? WHERE parentId=?', f.parentId, fid);
      this.run('UPDATE notebooks SET folderId=? WHERE folderId=?', f.parentId, fid);
      this.run('UPDATE notebook_members SET folderId=? WHERE folderId=?', f.parentId, fid);
      this.run('DELETE FROM folders WHERE id=?', fid);
    });
  }

  // ---------- the two folders a course starts with
  /**
   * A free tree still starts somewhere: every student's course gets an ordinary "Lectures" folder
   * (holding the decks) and an empty "Quizzes" folder. They are plain folders — renameable,
   * deletable, movable — so this runs once per student per course and never re-creates one.
   */
  seedCourseFolders(courseId: string, studentId: string) {
    const seeded = this.get('SELECT 1 FROM course_seeds WHERE studentId=? AND courseId=?', studentId, courseId);
    if (seeded) return;
    this.tx(() => {
      const lecturesId = this.createFolder({ courseId, studentId, parentId: null, name: 'Lectures' });
      const quizzesId = this.createFolder({ courseId, studentId, parentId: null, name: 'Quizzes' });
      this.run(
        `UPDATE notebooks SET folderId=? WHERE courseId=? AND studentId=? AND kind='lecture' AND folderId IS NULL`,
        lecturesId,
        courseId,
        studentId,
      );
      this.run('INSERT INTO course_seeds(studentId,courseId,lecturesId,quizzesId,sharedId,seededAt) VALUES(?,?,?,?,?,?)', studentId, courseId, lecturesId, quizzesId, null, now());
    });
  }
  /** The folder the course's deck was seeded into, while it still exists. */
  lecturesFolder(courseId: string, studentId: string) {
    return this.get(
      `SELECT f.id FROM folders f JOIN course_seeds s ON s.lecturesId=f.id
       WHERE f.courseId=? AND f.studentId=?`,
      courseId,
      studentId,
    )?.id as string | undefined;
  }
  renameNotebook(nid: string, title: string) {
    this.run('UPDATE notebooks SET title=?, updatedAt=? WHERE id=?', title, now(), nid);
  }
  deleteNotebook(nid: string) {
    // Copies survive the source; they become snapshots and keep a "From …" provenance. Deleting
    // the copy itself removes its incoming share row.
    this.run('UPDATE shares SET sourceDeleted=1, mode=\'snapshot\', updatedAt=? WHERE sourceNotebookId=?', now(), nid);
    this.run('DELETE FROM shares WHERE copyNotebookId=?', nid);
    this.run('UPDATE live_sessions SET endedAt=? WHERE notebookId=? AND endedAt IS NULL', now(), nid);
    this.run('DELETE FROM notebooks WHERE id=?', nid);
  }
  deleteShare(sid: string) {
    this.run('DELETE FROM shares WHERE id=?', sid);
  }
  lectureNotebook(studentId: string, lectureId: string) {
    return this.get(`SELECT id FROM notebooks WHERE studentId=? AND lectureId=? AND kind='lecture'`, studentId, lectureId)
      ?.id as string | undefined;
  }
  addPage(p: {
    notebookId: string;
    position: number;
    kind: PageKind;
    slideId?: string | null;
    background?: string | null;
    width: number;
    height: number;
    link?: Partial<PageLink>;
  }) {
    const pid = id();
    this.run(
      `INSERT INTO pages(id,notebookId,position,kind,slideId,background,width,height,strokes,items,linkLectureId,linkSlideId,linkConfidence,linkConfirmed,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,'[]','[]',?,?,?,?,?)`,
      pid,
      p.notebookId,
      p.position,
      p.kind,
      p.slideId ?? null,
      p.background ?? null,
      p.width,
      p.height,
      p.link?.lectureId ?? null,
      p.link?.slideId ?? null,
      p.link?.confidence ?? 0,
      p.link?.confirmed ? 1 : 0,
      now(),
    );
    this.run('UPDATE notebooks SET revision=revision+1, updatedAt=? WHERE id=?', now(), p.notebookId);
    return pid;
  }
  private pageRow = (r: Row): Page & {
    notebookStudentId: string;
    notebookKind: Notebook['kind'];
    courseId: string;
    contentHash: string | null;
    indexedRevision: number;
    image: string | null;
  } => ({
    id: r.id,
    notebookId: r.notebookId,
    position: r.position,
    kind: r.kind,
    slideId: r.slideId,
    background: r.background ? `/api/assets/${r.background}` : r.image ? `/api/assets/${r.image}` : null,
    image: r.background ?? r.image ?? null,
    width: r.width,
    height: r.height,
    strokes: JSON.parse(r.strokes),
    items: JSON.parse(r.items),
    revision: r.revision,
    indexStatus: r.indexStatus,
    indexError: r.indexError,
    link: {
      lectureId: r.linkLectureId,
      slideId: r.linkSlideId,
      confidence: r.linkConfidence,
      confirmed: Boolean(r.linkConfirmed),
      slidePage: r.linkSlidePage ?? null,
    },
    sharedCount: r.sharedCount ?? 0,
    linkedSlides: r.linkedSlides ?? 0,
    origin: r.origin === 'shared' ? 'shared' : 'own',
    sourcePageId: (r.sourcePageId ?? null) as string | null,
    sourceRevision: (r.sourceRevision ?? null) as number | null,
    sharedTombstones: JSON.parse((r.sharedTombstones as string) || '[]') as string[],
    notebookStudentId: r.studentId,
    notebookKind: r.notebookKind as Notebook['kind'],
    courseId: r.courseId,
    contentHash: r.contentHash,
    indexedRevision: r.indexedRevision,
  });
  private PAGE_SQL = `SELECT p.*, s.image, n.studentId, n.kind notebookKind, n.courseId, (SELECT page FROM slides x WHERE x.id=p.linkSlideId) linkSlidePage,
    (SELECT COUNT(*) FROM fragments f WHERE f.pageId=p.id AND f.shared=1) sharedCount,
    (SELECT COUNT(DISTINCT f.slideId) FROM fragments f WHERE f.pageId=p.id AND f.slideId IS NOT NULL) linkedSlides
    FROM pages p JOIN notebooks n ON n.id=p.notebookId LEFT JOIN slides s ON s.id=p.slideId`;
  pages(nid: string) {
    return this.all(`${this.PAGE_SQL} WHERE p.notebookId=? ORDER BY position`, nid).map(this.pageRow);
  }
  page(pid: string) {
    const r = this.get(`${this.PAGE_SQL} WHERE p.id=?`, pid);
    if (!r) throw new AppError(404, 'Page not found.');
    return this.pageRow(r);
  }
  savePage(pid: string, baseRevision: number, strokes: Stroke[], items: Item[]) {
    return this.tx(() => {
      const cur = this.get('SELECT revision, notebookId FROM pages WHERE id=?', pid);
      if (!cur) throw new AppError(404, 'Page not found.');
      if (cur.revision !== baseRevision)
        throw new AppError(409, 'This page changed in another window. Reload to get the latest version.');
      this.run(
        'UPDATE pages SET strokes=?, items=?, revision=revision+1, updatedAt=? WHERE id=?',
        JSON.stringify(strokes),
        JSON.stringify(items),
        now(),
        pid,
      );
      this.run('UPDATE notebooks SET updatedAt=?, revision=revision+1 WHERE id=?', now(), cur.notebookId);
      return baseRevision + 1;
    });
  }
  /**
   * A received copy has one editor, but a pull can replace the shared layer underneath them.
   * Diff against the server's last version: changing a shared object marks it local, erasing one
   * leaves a tombstone so a later fetch does not bring it back. The recipient's own objects are
   * stamped with their author and are never touched by the source.
   */
  savePageCopy(pid: string, baseRevision: number, strokes: Stroke[], items: Item[], editorId: string) {
    return this.tx(() => {
      const cur = this.get('SELECT revision, notebookId, strokes, items, sharedTombstones FROM pages WHERE id=?', pid);
      if (!cur) throw new AppError(404, 'Page not found.');
      if (cur.revision !== baseRevision)
        throw new AppError(409, 'This page changed in another window. Reload to get the latest version.');
      const stored = [...(JSON.parse(cur.strokes) as DrawObject[]), ...(JSON.parse(cur.items) as DrawObject[])];
      const storedMap = new Map(stored.map((o) => [o.id, o]));
      const incoming = [...(strokes as DrawObject[]), ...(items as DrawObject[])];
      const incomingIds = new Set(incoming.map((o) => o.id));
      const tombstones = new Set<string>(JSON.parse(cur.sharedTombstones || '[]'));
      for (const o of incoming) {
        const before = storedMap.get(o.id);
        if (o.origin === 'shared') {
          o.sourceId = o.sourceId ?? before?.sourceId ?? o.id;
          o.authorId = o.authorId ?? before?.authorId;
          o.lastEditedBy = editorId;
          if (before && !sameContent(before, o)) o.localModified = true;
          // Present again (e.g. undo restored an erased shared object): drop its tombstone.
          tombstones.delete(o.sourceId);
        } else {
          o.origin = 'own';
          o.authorId = o.authorId ?? editorId;
          o.lastEditedBy = editorId;
        }
      }
      for (const o of stored) {
        if (o.origin !== 'shared' || incomingIds.has(o.id)) continue;
        // The erase is the latest local decision, whether or not the object had been edited first.
        tombstones.add(o.sourceId ?? o.id);
      }
      this.run(
        'UPDATE pages SET strokes=?, items=?, revision=revision+1, updatedAt=?, sharedTombstones=? WHERE id=?',
        JSON.stringify(strokes),
        JSON.stringify(items),
        now(),
        JSON.stringify([...tombstones]),
        pid,
      );
      this.run('UPDATE notebooks SET updatedAt=?, revision=revision+1 WHERE id=?', now(), cur.notebookId);
      return baseRevision + 1;
    });
  }
  /**
   * Co-owned pages merge three versions: the last server state the editor saw (base), the editor's
   * current page, and the server's stored page. Unchanged local objects follow the server; edited
   * local objects win. This is object-level last-write-wins and works for free-form ink because every
   * stroke and item already has an id.
   */
  savePageMerged(pid: string, baseStrokes: Stroke[], baseItems: Item[], strokes: Stroke[], items: Item[], editorId: string) {
    return this.tx(() => {
      const cur = this.get('SELECT revision, notebookId, strokes, items, sharedTombstones FROM pages WHERE id=?', pid);
      if (!cur) throw new AppError(404, 'Page not found.');
      const tombstones = new Set<string>(JSON.parse(cur.sharedTombstones || '[]'));
      const base = [...(baseStrokes as DrawObject[]), ...(baseItems as DrawObject[])].map((o) => ({ ...o }));
      const current = [...(strokes as DrawObject[]), ...(items as DrawObject[])].map((o) => ({ ...o }));
      const stored = [...(JSON.parse(cur.strokes) as DrawObject[]), ...(JSON.parse(cur.items) as DrawObject[])].map((o) => ({ ...o }));
      const b = byId(base);
      const c = byId(current);
      const s = byId(stored);
      const out: DrawObject[] = [];
      for (const oid of new Set([...b.keys(), ...c.keys(), ...s.keys()])) {
        const bo = b.get(oid);
        const co = c.get(oid);
        const so = s.get(oid);
        if (sameContent(bo, co)) {
          if (so) out.push(so);
          continue;
        }
        if (!co) {
          // A local erase of a shared object must also survive a later pull from the source.
          if (so?.origin === 'shared') tombstones.add(so.sourceId ?? so.id);
          continue;
        }
        co.lastEditedBy = editorId;
        co.authorId = so?.authorId ?? co.authorId ?? editorId;
        co.origin = co.origin ?? so?.origin ?? 'own';
        if (co.origin === 'shared' && !sameContent(bo, co)) co.localModified = true;
        out.push(co);
      }
      for (const o of out) if (o.origin === 'shared' && o.sourceId) tombstones.delete(o.sourceId);
      const nextStrokes = out.filter((o) => !('type' in o)) as Stroke[];
      const nextItems = out.filter((o) => 'type' in o) as Item[];
      this.run(
        'UPDATE pages SET strokes=?, items=?, sharedTombstones=?, revision=revision+1, updatedAt=? WHERE id=?',
        JSON.stringify(nextStrokes),
        JSON.stringify(nextItems),
        JSON.stringify([...tombstones]),
        now(),
        pid,
      );
      this.run('UPDATE notebooks SET updatedAt=?, revision=revision+1 WHERE id=?', now(), cur.notebookId);
      return cur.revision + 1;
    });
  }
  /** Insert a page copied from a direct share, with every object tagged as coming from the source. */
  addCopiedPage(p: {
    notebookId: string;
    position: number;
    kind: PageKind;
    slideId: string | null;
    background: string | null;
    width: number;
    height: number;
    link: PageLink;
    strokes: Stroke[];
    items: Item[];
    sourcePageId: string;
    sourceRevision: number;
  }) {
    const pid = id();
    this.run(
      `INSERT INTO pages(id,notebookId,position,kind,slideId,background,width,height,strokes,items,linkLectureId,linkSlideId,linkConfidence,linkConfirmed,updatedAt,origin,sourcePageId,sourceRevision,sharedTombstones)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '[]')`,
      pid,
      p.notebookId,
      p.position,
      p.kind,
      p.slideId,
      p.background,
      p.width,
      p.height,
      JSON.stringify(p.strokes),
      JSON.stringify(p.items),
      p.link.lectureId,
      p.link.slideId,
      p.link.confidence,
      p.link.confirmed ? 1 : 0,
      now(),
      'shared',
      p.sourcePageId,
      p.sourceRevision,
    );
    return pid;
  }
  /** Replace the shared layer of an existing copied page; the recipient's own objects stay. */
  replaceCopiedPage(pid: string, strokes: Stroke[], items: Item[], sourceRevision: number) {
    this.run(
      'UPDATE pages SET strokes=?, items=?, sourceRevision=?, revision=revision+1, updatedAt=? WHERE id=?',
      JSON.stringify(strokes),
      JSON.stringify(items),
      sourceRevision,
      now(),
      pid,
    );
  }
  setPageOrigin(pid: string, origin: 'own' | 'shared', sourcePageId: string | null, sourceRevision: number | null) {
    this.run('UPDATE pages SET origin=?, sourcePageId=?, sourceRevision=? WHERE id=?', origin, sourcePageId, sourceRevision, pid);
  }
  deletePage(pid: string) {
    const p = this.get('SELECT notebookId FROM pages WHERE id=?', pid);
    this.run('DELETE FROM pages WHERE id=?', pid);
    if (p) this.run('UPDATE notebooks SET revision=revision+1, updatedAt=? WHERE id=?', now(), p.notebookId);
  }
  /** Changes one sheet's paper. Strokes and items keep their page coordinates, so nothing is lost. */
  setPagePaper(pid: string, kind: PaperKind, width: number, height: number) {
    const p = this.get('SELECT notebookId FROM pages WHERE id=?', pid);
    this.run('UPDATE pages SET kind=?, width=?, height=?, revision=revision+1, updatedAt=? WHERE id=?', kind, width, height, now(), pid);
    if (p) this.run('UPDATE notebooks SET revision=revision+1 WHERE id=?', p.notebookId);
  }
  setIndex(pid: string, status: string, error: string | null = null) {
    this.run('UPDATE pages SET indexStatus=?, indexError=? WHERE id=?', status, error, pid);
  }
  setLink(pid: string, link: PageLink) {
    this.run(
      'UPDATE pages SET linkLectureId=?, linkSlideId=?, linkConfidence=?, linkConfirmed=? WHERE id=?',
      link.lectureId,
      link.slideId,
      link.confidence,
      link.confirmed ? 1 : 0,
      pid,
    );
  }
  queuedPages() {
    return this.all(`SELECT id FROM pages WHERE indexStatus='queued'`).map((r) => r.id as string);
  }

  // ---------- fragments
  replaceFragments(
    pid: string,
    revision: number,
    contentHash: string,
    frags: Omit<Fragment, 'id' | 'pageId' | 'authorName' | 'authorColor' | 'createdAt' | 'entryId'>[],
  ) {
    this.tx(() => {
      const cur = this.get('SELECT revision FROM pages WHERE id=?', pid);
      if (!cur || cur.revision !== revision) return; // a newer edit supersedes this result
      // Re-reads keep the id of a fragment whose text did not change, so classmates' dismissals survive.
      const previous = new Map<string, string[]>();
      for (const row of this.all('SELECT * FROM fragments WHERE pageId=? AND supersededBy IS NULL', pid))
        previous.set(row.text as string, [...(previous.get(row.text as string) ?? []), row.id as string]);
      // Notes this read no longer produces are superseded, not destroyed: a citation already in a
      // classmate's notes must still open. They keep their row, stop being shared, and the new note
      // in the same position is recorded as their replacement.
      const live = this.all('SELECT * FROM fragments WHERE pageId=? AND supersededBy IS NULL', pid);
      const stale = live.filter((r) => !frags.some((f) => f.text === r.text));
      // Deleting/reinserting a fragment cascades its entry_sources link away even when the id and
      // text are reused. Remember those links and restore them for the unchanged live rows.
      const entryLinks = this.all(
        `SELECT es.entryId, es.fragmentId FROM entry_sources es JOIN fragments f ON f.id=es.fragmentId WHERE f.pageId=?`,
        pid,
      ) as { entryId: string; fragmentId: string }[];
      // Only the two most recent generations are kept: enough for a citation to resolve, not a history.
      this.run('DELETE FROM fragments WHERE pageId=? AND supersededBy IS NOT NULL', pid);
      this.run('DELETE FROM fragments WHERE pageId=? AND supersededBy IS NULL', pid);
      const withheld = new Set(this.all('SELECT textHash FROM withheld WHERE pageId=?', pid).map((r) => r.textHash as string));
      for (const f of frags) {
        // An item the author stopped sharing stays private when the page is read again.
        const reason = f.reason ?? (withheld.has(hash(f.text)) ? 'withheld' : null);
        this.run(
          'INSERT INTO fragments(id,pageId,studentId,courseId,lectureId,slideId,kind,text,topic,confidence,bbox,shared,pageRevision,createdAt,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          previous.get(f.text)?.shift() ?? id(),
          pid,
          f.studentId,
          f.courseId,
          f.lectureId,
          f.slideId,
          f.kind,
          f.text,
          f.topic,
          f.confidence,
          JSON.stringify(f.bbox),
          reason ? 0 : 1,
          revision,
          now(),
          reason,
        );
      }
      for (const link of entryLinks) {
        const kept = this.get('SELECT 1 FROM fragments WHERE id=? AND pageId=? AND supersededBy IS NULL', link.fragmentId, pid);
        if (!kept) continue;
        this.run('INSERT OR IGNORE INTO entry_sources(entryId,fragmentId) VALUES(?,?)', link.entryId, link.fragmentId);
        this.run('UPDATE fragments SET entryId=? WHERE id=?', link.entryId, link.fragmentId);
      }
      if (stale.length) {
        const fresh = this.all('SELECT id, rowid FROM fragments WHERE pageId=? ORDER BY rowid', pid);
        stale.forEach((row, i) => {
          // The note at the same position is this one's replacement; otherwise the first new note.
          const replacement = (fresh[i] ?? fresh[0])?.id as string | undefined;
          if (!replacement) return;
          this.run(
            'INSERT INTO fragments(id,pageId,studentId,courseId,lectureId,slideId,kind,text,topic,confidence,bbox,shared,pageRevision,createdAt,reason,supersededBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)',
            row.id,
            pid,
            row.studentId,
            row.courseId,
            row.lectureId,
            row.slideId,
            row.kind,
            row.text,
            row.topic,
            row.confidence,
            row.bbox,
            row.pageRevision,
            row.createdAt,
            row.reason ?? null,
            replacement,
          );
        });
      }
      this.run(
        `UPDATE pages SET indexStatus='indexed', indexError=NULL, indexedRevision=?, contentHash=? WHERE id=?`,
        revision,
        contentHash,
        pid,
      );
    });
  }
  private fragRow = (r: Row): Fragment & { pageRevision: number } => ({
    id: r.id,
    pageId: r.pageId,
    studentId: r.studentId,
    authorName: r.authorName,
    authorColor: r.authorColor,
    courseId: r.courseId,
    lectureId: r.lectureId,
    slideId: r.slideId,
    kind: r.kind,
    text: r.text,
    topic: r.topic,
    confidence: r.confidence,
    bbox: JSON.parse(r.bbox),
    shared: Boolean(r.shared),
    reason: r.reason ?? null,
    entryId: (r.entryId ?? null) as string | null,
    createdAt: r.createdAt,
    pageRevision: r.pageRevision,
  });
  /** A note that becomes a group note or an instructor's note stops being peer evidence. Keep the
   * rows so citations still resolve, but take them out of the bank. */
  retirePageFragments(pid: string) {
    this.tx(() => {
      const frags = this.all('SELECT id, entryId FROM fragments WHERE pageId=?', pid) as { id: string; entryId: string | null }[];
      const entryIds = new Set(frags.map((f) => f.entryId).filter((x): x is string => Boolean(x)));
      this.run('DELETE FROM entry_sources WHERE fragmentId IN (SELECT id FROM fragments WHERE pageId=?)', pid);
      this.run('UPDATE fragments SET shared=0, entryId=NULL WHERE pageId=?', pid);
      for (const eid of entryIds) {
        // Stop offering the retired entry immediately. The rows stay so old citations resolve;
        // the next merge rebuilds the slide from the remaining sources.
        this.run(`UPDATE knowledge_entries SET excludedReason='retired', disputeExplanation=NULL, updatedAt=? WHERE id=?`, now(), eid);
      }
    });
  }
  /** Author control: stop or resume sharing an item. Only items withheld by the author can be re-shared. */
  setWithheld(fid: string, withhold: boolean) {
    const f = this.get('SELECT pageId, text, reason FROM fragments WHERE id=?', fid);
    if (!f) throw new AppError(404, 'Note not found.');
    if (withhold) {
      this.run('INSERT OR IGNORE INTO withheld VALUES(?,?)', f.pageId, hash(f.text));
      if (!f.reason) this.run(`UPDATE fragments SET shared=0, reason='withheld' WHERE id=?`, fid);
    } else {
      if (f.reason && f.reason !== 'withheld') throw new AppError(400, 'This note was kept private because it could not be read or linked reliably.');
      this.run('DELETE FROM withheld WHERE pageId=? AND textHash=?', f.pageId, hash(f.text));
      this.run(`UPDATE fragments SET shared=1, reason=NULL WHERE id=?`, fid);
    }
  }
  /** Everything a student has contributed in a course, for the sharing review. */
  myFragments(courseId: string, studentId: string) {
    return this.all(
      `${this.FRAG_SQL} WHERE f.courseId=? AND f.studentId=? ORDER BY f.shared DESC, f.createdAt DESC`,
      courseId,
      studentId,
    ).map((r) => ({ ...this.fragRow(r), notebookId: r.notebookId as string, lectureNumber: r.lectureNumber as number | null, slidePage: r.slidePage as number | null }));
  }
  private FRAG_SQL = `SELECT f.*, s.name authorName, s.color authorColor, p.notebookId,
    (SELECT number FROM lectures l WHERE l.id=f.lectureId) lectureNumber, (SELECT page FROM slides x WHERE x.id=f.slideId) slidePage
    FROM fragments f JOIN students s ON s.id=f.studentId JOIN pages p ON p.id=f.pageId`;
  /** Shared classmate fragments for a lecture, excluding the viewer's own and dismissed ones. */
  peerFragments(lectureId: string, viewer: string, opts: { slideId?: string; includeDismissed?: boolean } = {}) {
    return this.all(
      `${this.FRAG_SQL} WHERE f.lectureId=? AND f.shared=1 AND f.studentId<>?
       AND NOT EXISTS (SELECT 1 FROM enrollments er WHERE er.studentId=f.studentId AND er.courseId=f.courseId AND er.role='instructor')
       ${opts.slideId ? 'AND f.slideId=?' : ''}
       ${opts.includeDismissed ? '' : 'AND f.id NOT IN (SELECT fragmentId FROM dismissals WHERE studentId=?)'}
       ORDER BY f.confidence DESC`,
      lectureId,
      viewer,
      ...(opts.slideId ? [opts.slideId] : []),
      ...(opts.includeDismissed ? [] : [viewer]),
    ).map(this.fragRow);
  }
  peerCounts(lectureId: string, viewer: string) {
    return Object.fromEntries(
      this.all(
        `SELECT slideId, COUNT(*) n FROM fragments f WHERE lectureId=? AND shared=1 AND studentId<>?
         AND NOT EXISTS (SELECT 1 FROM enrollments er WHERE er.studentId=f.studentId AND er.courseId=f.courseId AND er.role='instructor')
         AND id NOT IN (SELECT fragmentId FROM dismissals WHERE studentId=?) AND slideId IS NOT NULL GROUP BY slideId`,
        lectureId,
        viewer,
        viewer,
      ).map((r) => [r.slideId, r.n]),
    ) as Record<string, number>;
  }
  pageFragments(pid: string) {
    return this.all(`${this.FRAG_SQL} WHERE f.pageId=? ORDER BY f.rowid`, pid).map(this.fragRow);
  }
  fragment(fid: string) {
    const r = this.get(`${this.FRAG_SQL} WHERE f.id=?`, fid);
    return r ? this.fragRow(r) : null;
  }
  dismiss(studentId: string, fragmentId: string) {
    this.run('INSERT OR IGNORE INTO dismissals VALUES(?,?)', studentId, fragmentId);
  }

  // ---------- the course knowledge base
  /** Fragments on a slide that classmates may see: shared and not superseded. */
  slideFragments(slideId: string) {
    return this.all(
      `${this.FRAG_SQL} WHERE f.slideId=? AND f.shared=1 AND f.supersededBy IS NULL
       AND NOT EXISTS (SELECT 1 FROM enrollments er WHERE er.studentId=f.studentId AND er.courseId=f.courseId AND er.role='instructor')
       ORDER BY f.confidence DESC`,
      slideId,
    ).map(this.fragRow);
  }
  /** Entries for a slide, disputed ones included (callers decide whether to hide them). */
  entries(slideId: string) {
    return this.all('SELECT * FROM knowledge_entries WHERE slideId=? ORDER BY createdAt', slideId).map(this.entryRow);
  }
  entry(entryId: string) {
    const r = this.get('SELECT * FROM knowledge_entries WHERE id=?', entryId);
    return r ? this.entryRow(r) : null;
  }
  private entryRow = (r: Row) => ({
    id: r.id as string,
    courseId: r.courseId as string,
    lectureId: r.lectureId as string,
    slideId: r.slideId as string,
    title: r.title as string,
    summary: r.summary as string,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
    checkedAt: (r.checkedAt ?? null) as string | null,
    excludedReason: (r.excludedReason ?? null) as string | null,
    disputeExplanation: (r.disputeExplanation ?? null) as string | null,
  });
  /** The fragments feeding an entry, oldest first. */
  entrySources(entryId: string) {
    return this.all(
      `${this.FRAG_SQL} JOIN entry_sources es ON es.fragmentId=f.id WHERE es.entryId=? ORDER BY f.rowid`,
      entryId,
    ).map(this.fragRow);
  }
  entrySourceCount(entryId: string) {
    return (this.get('SELECT COUNT(*) n FROM entry_sources WHERE entryId=?', entryId)?.n ?? 0) as number;
  }
  upsertEntry(e: {
    id?: string | null;
    courseId: string;
    lectureId: string;
    slideId: string;
    title: string;
    summary: string;
    excludedReason?: string | null;
    disputeExplanation?: string | null;
  }) {
    const existing = e.id ? this.get('SELECT id FROM knowledge_entries WHERE id=?', e.id) : undefined;
    if (existing) {
      // Keep the id so nothing flickers for anyone already looking at this slide.
      this.run(
        'UPDATE knowledge_entries SET title=?, summary=?, updatedAt=?, excludedReason=?, disputeExplanation=? WHERE id=?',
        e.title,
        e.summary,
        now(),
        e.excludedReason ?? null,
        e.disputeExplanation ?? null,
        e.id,
      );
      return e.id!;
    }
    const eid = id();
    this.run(
      'INSERT INTO knowledge_entries(id,courseId,lectureId,slideId,title,summary,createdAt,updatedAt,checkedAt,excludedReason,disputeExplanation) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      eid,
      e.courseId,
      e.lectureId,
      e.slideId,
      e.title,
      e.summary,
      now(),
      now(),
      null,
      e.excludedReason ?? null,
      e.disputeExplanation ?? null,
    );
    return eid;
  }
  /** Point an entry at exactly these fragments; also stamps the fragments with their entry. */
  setEntrySources(entryId: string, fragmentIds: string[]) {
    this.run('DELETE FROM entry_sources WHERE entryId=?', entryId);
    for (const fid of fragmentIds) {
      this.run('INSERT OR IGNORE INTO entry_sources VALUES(?,?)', entryId, fid);
      this.run('UPDATE fragments SET entryId=? WHERE id=?', entryId, fid);
    }
  }
  deleteEntry(entryId: string) {
    this.run('UPDATE fragments SET entryId=NULL WHERE entryId=?', entryId);
    this.run('DELETE FROM knowledge_entries WHERE id=?', entryId);
  }
  /** An entry judged wrong by a report: out of suggestions and prompts until rechecked. */
  setEntryDispute(entryId: string, disputed: boolean, explanation: string | null) {
    this.run(
      'UPDATE knowledge_entries SET excludedReason=?, disputeExplanation=?, checkedAt=? WHERE id=?',
      disputed ? 'disputed' : null,
      disputed ? explanation : null,
      now(),
      entryId,
    );
  }
  reportEntry(entryId: string, studentId: string, reason: string) {
    this.run('INSERT OR REPLACE INTO entry_reports VALUES(?,?,?,?)', entryId, studentId, reason, now());
  }
  hasReported(entryId: string, studentId: string) {
    return Boolean(this.get('SELECT 1 FROM entry_reports WHERE entryId=? AND studentId=?', entryId, studentId));
  }
  /** Slides whose notes changed since their last merge, plus slides nobody has merged yet. */
  dirtySlides() {
    const rows = this.all(
      `SELECT f.slideId slideId, GROUP_CONCAT(f.id || ':' || f.text, '|') src FROM fragments f
       WHERE f.slideId IS NOT NULL AND f.shared=1 AND f.supersededBy IS NULL GROUP BY f.slideId`,
    );
    return rows
      .map((r) => ({ slideId: r.slideId as string, sourceHash: hash(String(r.src ?? '')) }))
      .filter((r) => this.slideMergeHash(r.slideId) !== r.sourceHash);
  }
  markSlideMerged(slideId: string, sourceHash: string) {
    this.run('INSERT OR REPLACE INTO slide_merges VALUES(?,?,?)', slideId, sourceHash, now());
  }
  slideMergeHash(slideId: string) {
    return (this.get('SELECT sourceHash FROM slide_merges WHERE slideId=?', slideId)?.sourceHash ?? null) as string | null;
  }
  /** A note the student wrote was replaced on re-indexing: the old fragment points at the new one. */
  supersedeFragment(oldId: string, newId: string) {
    this.run('UPDATE fragments SET supersededBy=?, shared=0 WHERE id=?', newId, oldId);
  }
  supersededBy(fragmentId: string) {
    return (this.get('SELECT supersededBy FROM fragments WHERE id=?', fragmentId)?.supersededBy ?? null) as string | null;
  }
  topics(lectureId: string) {
    return this.all('SELECT * FROM lecture_topics WHERE lectureId=? ORDER BY rowid', lectureId).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      slideIds: JSON.parse((r.slideIds as string) || '[]') as string[],
    }));
  }
  hasTopics(lectureId: string) {
    return Boolean(this.get('SELECT 1 FROM lecture_topics WHERE lectureId=?', lectureId));
  }
  setTopics(lectureId: string, courseId: string, topics: { name: string; slideIds: string[] }[]) {
    this.tx(() => {
      this.run('DELETE FROM lecture_topics WHERE lectureId=?', lectureId);
      for (const t of topics) this.run('INSERT INTO lecture_topics VALUES(?,?,?,?,?)', id(), courseId, lectureId, t.name, JSON.stringify(t.slideIds));
    });
  }

  // ---------- gaps in a page's notes
  gaps(pageId: string) {
    return this.all('SELECT * FROM page_gaps WHERE pageId=? ORDER BY rowid', pageId).map(this.gapRow);
  }
  private gapRow = (r: Row) => ({
    id: r.id as string,
    pageId: r.pageId as string,
    pageRevision: r.pageRevision as number,
    bbox: JSON.parse(r.bbox) as [number, number, number, number],
    missing: r.missing as string,
    entryIds: JSON.parse((r.entryIds as string) || '[]') as string[],
    createdAt: r.createdAt as string,
  });
  /**
   * Replaces a page's gaps, keeping the id of a gap that names the same thing. Ids must survive a
   * re-read: an open card must not vanish under the student, and a dismissal is remembered by id.
   */
  replaceGaps(pageId: string, revision: number, gaps: { bbox: [number, number, number, number]; missing: string; entryIds: string[] }[]) {
    this.tx(() => {
      const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
      const before = this.gaps(pageId);
      const keep = new Map<string, string>();
      for (const g of gaps) {
        const match = before.find((old) => ![...keep.values()].includes(old.id) && same(old.missing, g.missing));
        if (match) keep.set(g.missing, match.id);
      }
      this.run('DELETE FROM page_gaps WHERE pageId=?', pageId);
      for (const g of gaps)
        this.run(
          'INSERT INTO page_gaps VALUES(?,?,?,?,?,?,?)',
          keep.get(g.missing) ?? id(),
          pageId,
          revision,
          JSON.stringify(g.bbox),
          g.missing,
          JSON.stringify(g.entryIds),
          now(),
        );
    });
  }
  /** True when this page's slide has gained or changed entries since its gaps were last checked. */
  gapsOutdated(pageId: string): boolean {
    const page = this.get('SELECT p.slideId, p.linkSlideId FROM pages p WHERE p.id=?', pageId);
    const slideId = (page?.slideId ?? page?.linkSlideId) as string | null;
    if (!slideId) return false;
    const stale = hash(this.all('SELECT id, updatedAt FROM knowledge_entries WHERE slideId=? ORDER BY id', slideId).map((r) => `${r.id}:${r.updatedAt}`).join('|'));
    return (this.get('SELECT entryHash FROM gap_checks WHERE pageId=?', pageId)?.entryHash ?? null) !== stale;
  }
  markGapsChecked(pageId: string) {
    const page = this.get('SELECT p.slideId, p.linkSlideId FROM pages p WHERE p.id=?', pageId);
    const slideId = (page?.slideId ?? page?.linkSlideId) as string | null;
    const entryHash = slideId
      ? hash(this.all('SELECT id, updatedAt FROM knowledge_entries WHERE slideId=? ORDER BY id', slideId).map((r) => `${r.id}:${r.updatedAt}`).join('|'))
      : '';
    this.run('INSERT OR REPLACE INTO gap_checks VALUES(?,?,?)', pageId, entryHash, now());
  }
  dismissGap(studentId: string, gapId: string) {
    this.run('INSERT OR IGNORE INTO gap_dismissals VALUES(?,?)', studentId, gapId);
  }
  dismissedGaps(studentId: string) {
    return new Set(this.all('SELECT gapId FROM gap_dismissals WHERE studentId=?', studentId).map((r) => r.gapId as string));
  }

  // ---------- study records
  saveQuiz(qid: string, studentId: string, scope: unknown, questions: unknown) {
    this.run('INSERT INTO quizzes VALUES(?,?,?,?,?)', qid, studentId, JSON.stringify(scope), JSON.stringify(questions), now());
  }
  quiz(qid: string) {
    const r = this.get('SELECT * FROM quizzes WHERE id=?', qid);
    if (!r) throw new AppError(404, 'Quiz not found.');
    return { studentId: r.studentId as string, questions: JSON.parse(r.questions) as any[] };
  }
  // ---------- ask conversations
  askSessions(notebookId: string, studentId: string): AskSessionSummary[] {
    return this.all(
      `SELECT s.id, s.notebookId, s.title, s.updatedAt,
        (SELECT COUNT(*) FROM ask_messages m WHERE m.sessionId=s.id) messageCount,
        (SELECT m.pageLabel FROM ask_messages m WHERE m.sessionId=s.id AND m.pageLabel IS NOT NULL
           ORDER BY m.createdAt DESC LIMIT 1) lastPageLabel
       FROM ask_sessions s WHERE s.notebookId=? AND s.studentId=? ORDER BY s.updatedAt DESC`,
      notebookId,
      studentId,
    ) as unknown as AskSessionSummary[];
  }
  askSession(sessionId: string, studentId: string): AskSession {
    const s = this.get('SELECT * FROM ask_sessions WHERE id=? AND studentId=?', sessionId, studentId);
    if (!s) throw new AppError(404, 'Conversation not found.');
    const messages = this.all('SELECT * FROM ask_messages WHERE sessionId=? ORDER BY createdAt, rowid', sessionId).map((r) => ({
      id: r.id as string,
      role: r.role as AskMessage['role'],
      text: r.text as string,
      cards: JSON.parse((r.cards as string) || '[]') as AskMessage['cards'],
      pageId: (r.pageId as string) ?? null,
      pageLabel: (r.pageLabel as string) ?? null,
      createdAt: r.createdAt as string,
    }));
    return {
      id: s.id as string,
      notebookId: s.notebookId as string,
      title: s.title as string,
      updatedAt: s.updatedAt as string,
      messageCount: messages.length,
      lastPageLabel: [...messages].reverse().find((m) => m.pageLabel)?.pageLabel ?? null,
      messages,
    };
  }
  createAskSession(notebookId: string, studentId: string, title: string): AskSession {
    const sid = id();
    const t = now();
    this.run('INSERT INTO ask_sessions VALUES(?,?,?,?,?,?)', sid, notebookId, studentId, title, t, t);
    return this.askSession(sid, studentId);
  }
  addAskMessage(sessionId: string, msg: Omit<AskMessage, 'id' | 'createdAt'>): AskMessage {
    const mid = id();
    const t = now();
    this.run(
      'INSERT INTO ask_messages VALUES(?,?,?,?,?,?,?,?)',
      mid,
      sessionId,
      msg.role,
      msg.text,
      JSON.stringify(msg.cards),
      msg.pageId,
      msg.pageLabel,
      t,
    );
    this.run('UPDATE ask_sessions SET updatedAt=? WHERE id=?', t, sessionId);
    return { id: mid, ...msg, createdAt: t };
  }
  saveAsk(aid: string, studentId: string, pageId: string, rev: number, cards: unknown) {
    this.run('INSERT INTO asks VALUES(?,?,?,?,?,?)', aid, studentId, pageId, rev, JSON.stringify(cards), now());
  }
}
