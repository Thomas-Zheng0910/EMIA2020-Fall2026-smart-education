import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Course,
  CourseSummary,
  Folder,
  Fragment,
  Item,
  Lecture,
  Notebook,
  Page,
  PageKind,
  PageLink,
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

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, code TEXT, name TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY, name TEXT, initials TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS enrollments(studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE, joinedAt TEXT, PRIMARY KEY(studentId, courseId));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, path TEXT, mime TEXT, name TEXT, hash TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS lectures(id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id), number INTEGER, title TEXT,
  fileId TEXT, pageCount INTEGER DEFAULT 0, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS slides(id TEXT PRIMARY KEY, lectureId TEXT REFERENCES lectures(id) ON DELETE CASCADE, page INTEGER,
  width REAL, height REAL, image TEXT, text TEXT, digest TEXT, UNIQUE(lectureId,page));
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, courseId TEXT, studentId TEXT, lectureId TEXT, title TEXT, kind TEXT,
  createdAt TEXT, updatedAt TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS lecture_notebook ON notebooks(studentId, lectureId) WHERE kind='lecture';
CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, notebookId TEXT REFERENCES notebooks(id) ON DELETE CASCADE, position REAL,
  kind TEXT, slideId TEXT, background TEXT, width REAL, height REAL, strokes TEXT, items TEXT, revision INTEGER DEFAULT 1,
  indexStatus TEXT DEFAULT 'idle', indexError TEXT, indexedRevision INTEGER DEFAULT 0, contentHash TEXT,
  linkLectureId TEXT, linkSlideId TEXT, linkConfidence REAL DEFAULT 0, linkConfirmed INTEGER DEFAULT 0, updatedAt TEXT);
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
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  parentId TEXT, name TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS folders_owner ON folders(studentId, courseId);
-- Remembers the two folders a course starts with, so seeding runs once even after a student
-- renames or deletes them (with no folders yet, a tree is seeded; after that, never again).
-- The ids are what make the folders ordinary: renaming or moving them keeps lecture decks filed.
CREATE TABLE IF NOT EXISTS course_seeds(studentId TEXT, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lecturesId TEXT, quizzesId TEXT, seededAt TEXT, PRIMARY KEY(studentId, courseId));
`;

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Additive migrations for databases created before these columns existed.
    for (const sql of [`ALTER TABLE fragments ADD COLUMN reason TEXT`, `ALTER TABLE notebooks ADD COLUMN folderId TEXT`])
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
    const c = this.get('SELECT id,code,name,description FROM courses WHERE id=?', cid);
    if (!c) throw new AppError(404, 'Course not found.');
    return c as Course;
  }
  /** Courses with what the home page needs: counts, a cover slide and this student's last activity. */
  courseSummaries(studentId: string): CourseSummary[] {
    return this.all(
      `SELECT c.id,c.code,c.name,c.description,
        (SELECT COUNT(*) FROM lectures l WHERE l.courseId=c.id) lectureCount,
        (SELECT COUNT(*) FROM notebooks n WHERE n.courseId=c.id AND n.studentId=? AND n.kind<>'lecture') notebookCount,
        (SELECT COUNT(*) FROM enrollments e WHERE e.courseId=c.id) memberCount,
        (SELECT s.image FROM lectures l JOIN slides s ON s.lectureId=l.id
          WHERE l.courseId=c.id AND EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.courseId=c.id AND e2.studentId=?)
          ORDER BY l.number, s.page LIMIT 1) cover,
        (SELECT MAX(n.updatedAt) FROM notebooks n WHERE n.courseId=c.id AND n.studentId=?) lastActive
       FROM courses c ORDER BY c.code`,
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
  /** Joining a course is what gives the student its two starting folders, however they joined. */
  enroll(studentId: string, courseId: string) {
    this.run('INSERT OR IGNORE INTO enrollments VALUES(?,?,?)', studentId, courseId, now());
    this.seedCourseFolders(courseId, studentId);
  }
  unenroll(studentId: string, courseId: string) {
    this.run('DELETE FROM enrollments WHERE studentId=? AND courseId=?', studentId, courseId);
  }
  upsertStudent(s: Student) {
    this.run(`INSERT OR REPLACE INTO students VALUES(?,?,?,?)`, s.id, s.name, s.initials, s.color);
  }
  students(): Student[] {
    return this.all('SELECT * FROM students ORDER BY rowid') as Student[];
  }
  student(sid: string): Student {
    const s = this.get('SELECT * FROM students WHERE id=?', sid);
    if (!s) throw new AppError(400, 'Unknown student identity.');
    return s as Student;
  }

  // ---------- files
  addFile(path: string, mime: string, name: string, digest: string) {
    const fid = id();
    this.run('INSERT INTO files VALUES(?,?,?,?,?,?)', fid, path, mime, name, digest, now());
    return fid;
  }
  file(fid: string) {
    return this.get('SELECT * FROM files WHERE id=?', fid) as
      | { id: string; path: string; mime: string; name: string }
      | undefined;
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
           AND f.id NOT IN (SELECT fragmentId FROM dismissals WHERE studentId=?)) peerNotes
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
       FROM notebooks n JOIN courses c ON c.id=n.courseId JOIN enrollments e ON e.courseId=n.courseId AND e.studentId=n.studentId
       WHERE n.studentId=? AND (n.kind<>'lecture' OR EXISTS (SELECT 1 FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]')))
       ORDER BY n.updatedAt DESC LIMIT ?`,
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
       (SELECT p.id FROM pages p WHERE p.notebookId=n.id AND (p.strokes<>'[]' OR p.items<>'[]') ORDER BY p.updatedAt DESC LIMIT 1) lastPageId
       FROM notebooks n WHERE courseId=? AND studentId=? ORDER BY updatedAt DESC`,
      courseId,
      studentId,
    ).map((r) => ({ ...(r as any), folderId: r.folderId ?? null, cover: r.cover ? `/api/assets/${r.cover}` : null }));
  }
  notebook(nid: string): Notebook {
    const r = this.get(`SELECT n.*, (SELECT COUNT(*) FROM pages p WHERE p.notebookId=n.id) pageCount FROM notebooks n WHERE id=?`, nid);
    if (!r) throw new AppError(404, 'Notebook not found.');
    return { ...(r as any), folderId: r.folderId ?? null, cover: null };
  }
  createNotebook(n: { courseId: string; studentId: string; lectureId: string | null; title: string; kind: Notebook['kind']; folderId?: string | null }) {
    const nid = id();
    this.run(
      'INSERT INTO notebooks(id,courseId,studentId,lectureId,title,kind,createdAt,updatedAt,folderId) VALUES(?,?,?,?,?,?,?,?,?)',
      nid,
      n.courseId,
      n.studentId,
      n.lectureId,
      n.title,
      n.kind,
      now(),
      now(),
      n.folderId ?? null,
    );
    return nid;
  }
  /** Filing a notebook does not count as editing it, so the "newest first" order stays put. */
  setNotebookFolder(nid: string, folderId: string | null) {
    this.run('UPDATE notebooks SET folderId=? WHERE id=?', folderId, nid);
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
      this.run('INSERT INTO course_seeds(studentId,courseId,lecturesId,quizzesId,seededAt) VALUES(?,?,?,?,?)', studentId, courseId, lecturesId, quizzesId, now());
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
    this.run('DELETE FROM notebooks WHERE id=?', nid);
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
    return pid;
  }
  private pageRow = (r: Row): Page & { notebookStudentId: string; courseId: string; contentHash: string | null; indexedRevision: number; image: string | null } => ({
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
    notebookStudentId: r.studentId,
    courseId: r.courseId,
    contentHash: r.contentHash,
    indexedRevision: r.indexedRevision,
  });
  private PAGE_SQL = `SELECT p.*, s.image, n.studentId, n.courseId, (SELECT page FROM slides x WHERE x.id=p.linkSlideId) linkSlidePage,
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
      this.run('UPDATE notebooks SET updatedAt=? WHERE id=?', now(), cur.notebookId);
      return baseRevision + 1;
    });
  }
  deletePage(pid: string) {
    this.run('DELETE FROM pages WHERE id=?', pid);
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
    frags: Omit<Fragment, 'id' | 'pageId' | 'authorName' | 'authorColor' | 'createdAt'>[],
  ) {
    this.tx(() => {
      const cur = this.get('SELECT revision FROM pages WHERE id=?', pid);
      if (!cur || cur.revision !== revision) return; // a newer edit supersedes this result
      // Re-reads keep the id of a fragment whose text did not change, so classmates' dismissals survive.
      const previous = new Map<string, string[]>();
      for (const row of this.all('SELECT id,text FROM fragments WHERE pageId=?', pid))
        previous.set(row.text as string, [...(previous.get(row.text as string) ?? []), row.id as string]);
      this.run('DELETE FROM fragments WHERE pageId=?', pid);
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
    createdAt: r.createdAt,
    pageRevision: r.pageRevision,
  });
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
      `${this.FRAG_SQL} WHERE f.lectureId=? AND f.shared=1 AND f.studentId<>? ${opts.slideId ? 'AND f.slideId=?' : ''}
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
        `SELECT slideId, COUNT(*) n FROM fragments WHERE lectureId=? AND shared=1 AND studentId<>?
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

  // ---------- study records
  saveQuiz(qid: string, studentId: string, scope: unknown, questions: unknown) {
    this.run('INSERT INTO quizzes VALUES(?,?,?,?,?)', qid, studentId, JSON.stringify(scope), JSON.stringify(questions), now());
  }
  quiz(qid: string) {
    const r = this.get('SELECT * FROM quizzes WHERE id=?', qid);
    if (!r) throw new AppError(404, 'Quiz not found.');
    return { studentId: r.studentId as string, questions: JSON.parse(r.questions) as any[] };
  }
  saveAsk(aid: string, studentId: string, pageId: string, rev: number, cards: unknown) {
    this.run('INSERT INTO asks VALUES(?,?,?,?,?,?)', aid, studentId, pageId, rev, JSON.stringify(cards), now());
  }
}
