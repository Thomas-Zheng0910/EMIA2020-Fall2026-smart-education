import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { Store, AppError, hash } from './db';
import { ModelGateway } from './ai';
import { Jobs } from './jobs';
import { shareNotebook, syncCopy } from './shares';
import { importLecture, importNotebookPdf, openLectureNotebook, fileLectureNotebook, addBlankPage, storeFile, paperSize, PAPER_HEIGHT } from './importer';
import { renderPage, cropPng } from './render';
import { ask, makeQuiz, gradeQuiz } from './study';
import { pageSuggestions, notebookSuggestions, expandGap } from './suggestions';
import type { Bootstrap, InviteNotice, Item, LiveSession, ShareMode, ShareNotice, Stroke } from '../shared/types';

const num = z.number().finite();
const ObjectMetaZ = {
  authorId: z.string().max(64).optional(),
  origin: z.enum(['own', 'shared']).optional(),
  sourceId: z.string().max(64).optional(),
  localModified: z.boolean().optional(),
  lastEditedBy: z.string().max(64).optional(),
};
const StrokeZ = z.object({
  id: z.string().max(64),
  tool: z.enum(['pen', 'highlighter']),
  color: z.string().max(32),
  size: num.min(0.5).max(80),
  points: z.array(num).max(30000),
  ...ObjectMetaZ,
});
const CitationZ = z.union([
  z.object({ kind: z.literal('slide'), slideId: z.string(), lectureNumber: num, page: num, label: z.string().max(300) }),
  z.object({ kind: z.literal('entry'), entryId: z.string(), slideId: z.string(), lectureNumber: num, page: num, label: z.string().max(300) }),
  z.object({ kind: z.literal('fragment'), fragmentId: z.string(), author: z.string().max(100), label: z.string().max(300) }),
]);
const PaperZ = z.enum(['ruled', 'grid', 'blank']);
const ItemZ = z.discriminatedUnion('type', [
  z.object({
    id: z.string().max(64),
    type: z.literal('text'),
    x: num,
    y: num,
    w: num,
    text: z.string().max(20000),
    color: z.string().max(32),
    size: num.min(6).max(96),
    lineHeight: num.min(6).max(200).optional(),
    ...ObjectMetaZ,
  }),
  z.object({ id: z.string().max(64), type: z.literal('image'), x: num, y: num, w: num, h: num, fileId: z.string().max(64), ...ObjectMetaZ }),
  z.object({
    id: z.string().max(64),
    type: z.literal('memo'),
    x: num,
    y: num,
    w: num,
    text: z.string().max(4000),
    color: z.string().max(32),
    size: num.min(6).max(48),
    tint: z.enum(['yellow', 'pink', 'blue', 'green']),
    collapsed: z.boolean().optional(),
    ...ObjectMetaZ,
  }),
  z.object({
    id: z.string().max(64),
    type: z.literal('annotation'),
    x: num,
    y: num,
    w: num,
    title: z.string().max(300),
    body: z.string().max(8000),
    // The client's word for a suggestion's grounding, stored as-is; it is what the page renders from.
    source: z.enum(['peer', 'slide', 'ai']),
    citations: z.array(CitationZ).max(12),
    collapsed: z.boolean().optional(),
    gapId: z.string().max(64).nullable().optional(),
    forGap: z.string().max(400).nullable().optional(),
    ...ObjectMetaZ,
  }),
]);
const BBox = z.tuple([num.min(0).max(1), num.min(0).max(1), num.min(0).max(1), num.min(0).max(1)]);

export async function buildApp({
  store,
  ai,
  dataDir,
  background = true,
  indexDelayMs = 6000,
  allowedOrigins = [],
}: {
  store: Store;
  ai: ModelGateway;
  dataDir: string;
  background?: boolean;
  indexDelayMs?: number;
  allowedOrigins?: string[];
}) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const jobs = new Jobs(store, ai, dataDir, { indexDelayMs, background });
  await mkdir(join(dataDir, 'assets'), { recursive: true });
  await app.register(multipart, { limits: { fileSize: 120 * 1024 * 1024, files: 1, fields: 8 } });

  app.setErrorHandler((e, _req, res) => {
    if (e instanceof z.ZodError)
      return res.code(400).send({ error: 'Invalid request: ' + e.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (e instanceof AppError) return res.code(e.status).send({ error: e.message });
    const err = e as Error & { statusCode?: number };
    if (!err.statusCode || err.statusCode >= 500) console.error(err);
    return res.code(err.statusCode ?? 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : 'Something went wrong. Please retry.' });
  });
  app.addHook('onRequest', async (req, res) => {
    res.header('x-content-type-options', 'nosniff');
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || allowedOrigins.includes(u.origin);
      } catch {
        ok = false;
      }
      if (!ok)
        return res.code(403).send({
          error: `This server only accepts changes from localhost or a configured app origin. Add ${origin} to ALLOWED_ORIGINS and restart the server.`,
        });
    }
  });

  const cookieStudent = (req: FastifyRequest) =>
    /(?:^|;\s*)notebook_student=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ??
    /(?:^|;\s*)margin_student=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
  const who = (req: FastifyRequest) =>
    store.student(String(req.headers['x-student-id'] ?? (cookieStudent(req) ? decodeURIComponent(cookieStudent(req)!) : 'thomas'))).id;
  /** The course chosen in the client (x-course-id); the student must be enrolled. */
  const course = (req: FastifyRequest) => {
    const cid = req.headers['x-course-id'];
    if (!cid) throw new AppError(400, 'Choose a course first.');
    return enrolledIn(req, String(cid));
  };
  const enrolledIn = (req: FastifyRequest, courseId: string) => {
    const c = store.course(courseId);
    if (!store.isEnrolled(who(req), c.id)) throw new AppError(403, `Join ${c.code} to see its lectures and notes.`);
    return c;
  };
  const lectureFor = (req: FastifyRequest, lectureId: string) => {
    const lec = store.lecture(lectureId);
    enrolledIn(req, lec.courseId);
    return lec;
  };
  const ownPage = (req: FastifyRequest, pid: string) => {
    const p = store.page(pid);
    if (!store.canAccessNotebook(p.notebookId, who(req))) throw new AppError(403, 'This page belongs to another student.');
    if (!store.isEnrolled(who(req), p.courseId)) throw new AppError(403, `Join ${store.course(p.courseId).code} to open its notebooks.`);
    return p;
  };
  const ownNotebook = (req: FastifyRequest, nid: string) => {
    const n = store.notebookFor(nid, who(req));
    if (!store.isEnrolled(who(req), n.courseId)) throw new AppError(403, `Join ${store.course(n.courseId).code} to open its notebooks.`);
    return n;
  };
  /** A student's own folder, in a course they are still enrolled in. Other students' folders are invisible. */
  const ownFolder = (req: FastifyRequest, fid: string) => {
    const f = store.folder(fid);
    if (f.studentId !== who(req)) throw new AppError(404, 'Folder not found.');
    enrolledIn(req, f.courseId);
    return f;
  };
  /** Validates a target folder for a notebook of `courseId` (null = top of "My notes"). */
  const folderIn = (req: FastifyRequest, courseId: string, fid: string | null | undefined) => {
    if (!fid) return null;
    if (ownFolder(req, fid).courseId !== courseId) throw new AppError(400, 'Notes stay in their own course.');
    return fid;
  };
  // Course material is served as files (slides, imported page backgrounds), so check the same
  // enrollment/ownership rules before the static handler hands anything out.
  app.addHook('onRequest', async (req, res) => {
    if (!req.url.startsWith('/api/assets/')) return;
    const parts = decodeURIComponent(req.url.split('?')[0]!.slice('/api/assets/'.length)).split('/');
    if (parts[0] === 'lectures' && parts[1]) {
      const lec = store.lecture(parts[1]);
      if (!store.isEnrolled(who(req), lec.courseId)) return res.code(403).send({ error: `Join ${store.course(lec.courseId).code} to see its slides.` });
      return;
    }
    if (parts[0] === 'notebooks' && parts[1]) {
      const nb = store.notebook(parts[1]);
      if (!store.canAccessNotebook(nb.id, who(req))) return res.code(403).send({ error: 'This notebook belongs to another student.' });
      if (!store.isEnrolled(who(req), nb.courseId)) return res.code(403).send({ error: `Join ${store.course(nb.courseId).code} to open its notebooks.` });
      return;
    }
    return res.code(404).send({ error: 'Asset not found.' });
  });
  /**
   * `suggestVersion` changes whenever this page's gaps or the knowledge behind them do, so the
   * editor knows to refetch suggestions. Without it a gap keeps saying "From slide 12" after a
   * classmate's note already covers it, until the student happens to write again.
   */
  const suggestVersion = (pid: string) =>
    hash(store.gaps(pid).map((g) => `${g.id}:${g.entryIds.join(',')}:${g.missing}`).join('|'));
  const pageStatus = (pid: string) => {
    const p = store.page(pid);
    return {
      id: p.id,
      revision: p.revision,
      indexStatus: p.indexStatus,
      indexError: p.indexError,
      link: p.link,
      sharedCount: p.sharedCount,
      linkedSlides: p.linkedSlides,
      suggestVersion: suggestVersion(p.id),
    };
  };

  /**
   * Finish a live session only after every student's copy has been written. If a copy fails the
   * session stays active so the host can retry; `shareNotebook` is idempotent for existing copies.
   */
  const finishLive = async (s: ReturnType<Store['liveSession']>) => {
    if (s.endedAt) return;
    const students = store.courseMembers(s.courseId).filter((m) => m.courseRole === 'student');
    const failed: string[] = [];
    for (const m of students) {
      try {
        await shareNotebook({ store, dataDir, sourceNotebookId: s.notebookId, sourcePageId: null, fromStudentId: s.hostId, toStudentId: m.id, mode: s.pullable ? 'pull' : 'snapshot', refreshSnapshot: true });
      } catch (e) {
        console.error('[live] copy failed', m.id, (e as Error).message);
        failed.push(m.name);
      }
    }
    if (failed.length) throw new AppError(502, `The handout could not be created for ${failed.join(', ')}. End live again to retry.`);
    store.endLive(s.id);
  };

  const liveView = (s: ReturnType<Store['liveSession']>, viewer: string): LiveSession => {
    const pages = store.pages(s.notebookId);
    const page = s.currentPageId ? pages.find((p) => p.id === s.currentPageId) ?? null : null;
    const index = page ? pages.findIndex((p) => p.id === page.id) + 1 : 0;
    return {
      id: s.id,
      courseId: s.courseId,
      hostId: s.hostId,
      hostName: store.student(s.hostId).name,
      notebookId: s.notebookId,
      title: s.title,
      currentPageId: page?.id ?? null,
      currentPageLabel: page ? (page.kind === 'slide' ? `Slide ${page.position}` : `Page ${index}`) : null,
      renderVersion: page ? `${page.id}:${page.revision}` : 'empty',
      pullable: Boolean(s.pullable),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      audience: store.audience(s.courseId, s.hostId),
      copyNotebookId: s.endedAt ? (store.getShareFor(s.notebookId, viewer, null)?.copyNotebookId ?? null) : null,
    };
  };

  app.get('/api/health', async () => ({ ok: true }));
  const withProgress = (courseId: string, sid: string) => {
    const prog = new Map(store.lectureProgress(courseId, sid).map((p) => [p.lectureId, p]));
    return store.lectures(courseId).map((l) => {
      const p = prog.get(l.id);
      return {
        ...l,
        topics: store.topics(l.id),
        progress: { notebookId: p?.notebookId ?? null, written: p?.written ?? 0, peerNotes: p?.peerNotes ?? 0, updatedAt: p?.updatedAt ?? null },
      };
    });
  };
  app.get('/api/bootstrap', async (req): Promise<Bootstrap> => {
    const sid = who(req);
    const enrolled = store.enrolledCourseIds(sid);
    // A student who joined before the tree existed gets the two starting folders on first open.
    for (const cid of enrolled) store.seedCourseFolders(cid, sid);
    const wanted = String(req.headers['x-course-id'] ?? '');
    // The client's route decides the course; no silent fallback to another course.
    const current = enrolled.includes(wanted) ? wanted : null;
    const course = current ? store.course(current) : null;
    return {
      courses: store.courseSummaries(sid),
      enrolled,
      course: course ? { ...course, myRole: store.courseRole(sid, course.id) } : null,
      lectures: current ? withProgress(current, sid) : [],
      recent: store.recentNotebooks(sid),
      students: store.students(),
      me: store.student(sid),
      ai: { configured: ai.configured, model: ai.config.model ?? null },
    };
  });

  // ---------------- courses & enrollment
  const CourseBody = z.object({
    code: z.string().trim().min(2).max(24),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).default(''),
  });
  app.post('/api/courses', async (req) => {
    const body = CourseBody.parse(req.body);
    const sid = who(req);
    if (store.student(sid).role !== 'professor') throw new AppError(403, 'Only a professor account can create a course.');
    const cid = body.code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';
    if (store.courses().some((c) => c.id === cid || c.code.toLowerCase() === body.code.toLowerCase()))
      throw new AppError(409, `${body.code} already exists. Join it instead.`);
    store.upsertCourse({ id: cid, code: body.code.toUpperCase(), name: body.name, description: body.description });
    store.enroll(sid, cid, 'instructor');
    return { ...store.course(cid), myRole: 'instructor' as const };
  });
  app.patch('/api/courses/:id', async (req) => {
    const c = enrolledIn(req, (req.params as { id: string }).id);
    if (!store.isInstructor(who(req), c.id)) throw new AppError(403, 'Only the professor can change a course.');
    const body = CourseBody.partial().parse(req.body);
    store.upsertCourse({ ...c, ...body, code: (body.code ?? c.code).toUpperCase() });
    return store.course(c.id);
  });
  app.post('/api/courses/:id/enroll', async (req) => {
    const c = store.course((req.params as { id: string }).id);
    const sid = who(req);
    store.enroll(sid, c.id);
    // Rejoining must not demote the seeded professor when the course has no other instructor.
    if (store.student(sid).role === 'professor') store.ensureInstructorForCourse(sid, c.id);
    return { ok: true };
  });
  app.delete('/api/courses/:id/enroll', async (req) => {
    const c = store.course((req.params as { id: string }).id);
    const sid = who(req);
    const live = store.activeLive(c.id);
    if (live && live.hostId === sid) await finishLive(live);
    store.unenroll(sid, c.id); // notebooks are kept and reappear on rejoining
    return { ok: true };
  });
  /** The roster used by the share sheet: names, avatars and each person's role in this course. */
  app.get('/api/courses/:id/members', async (req) => {
    const c = enrolledIn(req, (req.params as { id: string }).id);
    return store.courseMembers(c.id);
  });
  /** The course tree: the student's folders, their files (where each is filed) and the official decks. */
  app.get('/api/courses/:id/files', async (req) => {
    const c = enrolledIn(req, (req.params as { id: string }).id);
    const sid = who(req);
    store.seedCourseFolders(c.id, sid);
    return store.courseFiles(c.id, sid);
  });
  app.get('/api/lectures', async (req) => store.lectures(course(req).id));
  app.get('/api/lectures/:id/slides', async (req) => {
    const { id } = req.params as { id: string };
    lectureFor(req, id);
    return store.slides(id).map(({ image, ...s }) => ({ ...s, image: `/api/assets/${image}` }));
  });
  app.get('/api/slides/:id', async (req) => {
    const s = store.slide((req.params as { id: string }).id);
    if (!s) throw new AppError(404, 'Slide not found.');
    const lec = lectureFor(req, s.lectureId);
    return { ...s, image: `/api/assets/${s.image}`, lectureNumber: lec.number, lectureTitle: lec.title };
  });
  app.post('/api/lectures', async (req) => {
    const c = course(req);
    if (!store.isInstructor(who(req), c.id)) throw new AppError(403, 'Only the professor can add official slides.');
    const file = await req.file();
    if (!file || !/\.pdf$/i.test(file.filename)) throw new AppError(400, 'Choose a lecture PDF.');
    const buf = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: string }>;
    const number = fields.number?.value ? Number(fields.number.value) : null;
    const lid = await importLecture(store, jobs, dataDir, c.id, buf, file.filename, { number, title: fields.title?.value });
    return store.lecture(lid);
  });
  app.post('/api/lectures/:id/redigest', async (req) => {
    const lec = lectureFor(req, (req.params as { id: string }).id);
    if (!store.isInstructor(who(req), lec.courseId)) throw new AppError(403, 'Only the professor can re-read the official slides.');
    jobs.digestLecture(lec.id);
    return { ok: true };
  });

  // ---------------- notebooks
  app.get('/api/notebooks', async (req) => store.notebooks(course(req).id, who(req)));
  app.post('/api/notebooks/lecture/:lectureId', async (req) => {
    const lec = lectureFor(req, (req.params as { lectureId: string }).lectureId);
    if (lec.status === 'rendering' || lec.status === 'failed' && !lec.pageCount) throw new AppError(409, 'The lecture is still being prepared.');
    const sid = who(req);
    // A deck the student has not opened yet belongs where the course seeded its decks.
    const folderId = store.lectureNotebook(sid, lec.id) ? undefined : (store.lecturesFolder(lec.courseId, sid) ?? null);
    return { id: openLectureNotebook(store, sid, lec.id, folderId) };
  });
  /** Filing or renaming a deck the student has not opened yet creates their copy without its pages. */
  app.patch('/api/lectures/:id', async (req) => {
    const lec = lectureFor(req, (req.params as { id: string }).id);
    const body = z
      .object({ folderId: z.string().max(64).nullable().optional(), title: z.string().trim().min(1).max(120).optional() })
      .parse(req.body);
    const folderId = body.folderId === undefined ? undefined : folderIn(req, lec.courseId, body.folderId);
    return { id: fileLectureNotebook(store, who(req), lec.id, { folderId, title: body.title }) };
  });
  app.post('/api/notebooks', async (req) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(120), paper: PaperZ.default('ruled'), folderId: z.string().max(64).nullable().optional() })
      .parse(req.body);
    const c = course(req);
    const folderId = folderIn(req, c.id, body.folderId);
    const nid = store.createNotebook({ courseId: c.id, studentId: who(req), lectureId: null, title: body.title, kind: 'blank', folderId, paper: body.paper });
    const size = paperSize(body.paper);
    store.addPage({ notebookId: nid, position: 1, kind: body.paper, width: size.width, height: size.height });
    return { id: nid };
  });
  /** Changing the paper of a whole notebook: new pages inherit it, existing pages keep theirs. */
  app.patch('/api/notebooks/:id/paper', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const body = z.object({ paper: PaperZ }).parse(req.body);
    store.setNotebookPaper(nb.id, body.paper);
    return { paper: body.paper };
  });
  app.post('/api/notebooks/import', async (req) => {
    const file = await req.file();
    if (!file || !/\.pdf$/i.test(file.filename)) throw new AppError(400, 'Choose a PDF of your notes.');
    const c = course(req);
    const folderId = folderIn(req, c.id, (file.fields as Record<string, { value?: string }>).folderId?.value || null);
    const nid = await importNotebookPdf(store, jobs, dataDir, c.id, who(req), await file.toBuffer(), file.filename);
    if (folderId) store.setNotebookFolder(nid, folderId);
    return { id: nid };
  });
  const notebookPages = (nid: string, studentId: string) => {
    const pages = store.pages(nid).map(({ notebookStudentId: _a, courseId: _b, contentHash: _c, indexedRevision: _d, image: _e, ...p }) => ({ ...p, suggestVersion: suggestVersion(p.id) }));
    const counts: Record<string, number> = {};
    const lectureIds = new Set(pages.map((p) => p.link.lectureId).filter(Boolean) as string[]);
    for (const lid of lectureIds) Object.assign(counts, store.peerCounts(lid, studentId));
    return pages.map((p) => ({ ...p, peerCount: (p.slideId ?? p.link.slideId) ? counts[(p.slideId ?? p.link.slideId)!] ?? 0 : 0 }));
  };
  app.get('/api/notebooks/:id', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    store.markCopySeen(nb.id, who(req));
    return {
      notebook: nb,
      pages: notebookPages(nb.id, who(req)),
      presence: nb.kind === 'group' ? store.presence(nb.id).filter((p) => Date.now() - new Date(p.updatedAt).getTime() < 30_000) : [],
    };
  });
  /** Lightweight per-page status (indexing, links, classmate counts) without ink. */
  app.get('/api/notebooks/:id/status', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return notebookPages(nb.id, who(req)).map((p) => ({
      id: p.id,
      revision: p.revision,
      indexStatus: p.indexStatus,
      indexError: p.indexError,
      link: p.link,
      sharedCount: p.sharedCount,
      linkedSlides: p.linkedSlides,
      peerCount: p.peerCount,
      suggestVersion: p.suggestVersion,
    }));
  });
  /** One page's current ink, used by co-owned notes to pull in a classmate's completed strokes. */
  app.get('/api/pages/:id', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    const counts: Record<string, number> = {};
    if (p.link.lectureId) Object.assign(counts, store.peerCounts(p.link.lectureId, who(req)));
    const { notebookStudentId: _a, notebookKind: _b, courseId: _c, contentHash: _d, indexedRevision: _e, image: _f, ...page } = p;
    return { ...page, peerCount: (p.slideId ?? p.link.slideId) ? counts[(p.slideId ?? p.link.slideId)!] ?? 0 : 0, suggestVersion: suggestVersion(p.id) };
  });
  app.patch('/api/notebooks/:id', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), folderId: z.string().max(64).nullable().optional() }).parse(req.body);
    if (body.folderId !== undefined) {
      const fid = folderIn(req, nb.courseId, body.folderId);
      if (nb.kind === 'group' && nb.studentId !== who(req)) store.setMemberFolder(nb.id, who(req), fid);
      else {
        store.setNotebookFolder(nb.id, fid);
        if (nb.kind === 'group') store.setMemberFolder(nb.id, who(req), fid);
      }
    }
    if (body.title !== undefined) store.renameNotebook(nb.id, body.title);
    return { ok: true };
  });

  // ---------------- direct shares, co-ownership and live handouts
  const ShareModeZ = z.enum(['pull', 'snapshot']);
  app.get('/api/notebooks/:id/members', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return { members: store.notebookMembers(nb.id), role: nb.role ?? 'owner' };
  });
  /** The sender's own record of who received a copy; it is not a read receipt. */
  app.get('/api/notebooks/:id/shares', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return store.sharesFrom(nb.id, who(req));
  });
  /** Send a copy of this note (or one page) to classmates. The sender's original is never touched. */
  app.post('/api/notebooks/:id/share', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const body = z
      .object({
        students: z.array(z.string()).max(100).default([]),
        wholeClass: z.boolean().default(false),
        mode: ShareModeZ,
        pageId: z.string().max(64).nullable().optional(),
      })
      .parse(req.body);
    if (body.pageId && !store.pages(nb.id).some((p) => p.id === body.pageId)) throw new AppError(400, 'That page is not in this notebook.');
    let to = body.students.filter((s) => s !== who(req));
    if (body.wholeClass) {
      if (!store.isInstructor(who(req), nb.courseId)) throw new AppError(403, 'Only the professor can share with the whole class.');
      to = store.courseMembers(nb.courseId).filter((m) => m.courseRole === 'student' && m.id !== who(req)).map((m) => m.id);
    }
    if (!to.length) throw new AppError(400, 'Choose at least one classmate.');
    for (const sid of to) {
      if (!store.isEnrolled(sid, nb.courseId) || store.courseRole(sid, nb.courseId) !== 'student')
        throw new AppError(400, 'Choose a student in this course.');
    }
    let keptSnapshots = 0;
    for (const sid of to) {
      const result = await shareNotebook({ store, dataDir, sourceNotebookId: nb.id, sourcePageId: body.pageId ?? null, fromStudentId: who(req), toStudentId: sid, mode: body.mode });
      if (result.keptSnapshot) keptSnapshots++;
    }
    return { shared: to.length, keptSnapshots };
  });
  /** Turn this notebook into a co-owned group note and invite classmates. */
  app.post('/api/notebooks/:id/invite', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (nb.role !== 'owner') throw new AppError(403, 'Only the owner can invite collaborators.');
    if (nb.kind === 'lecture') throw new AppError(400, 'Lecture notebooks can be sent as a copy. Create a notebook to co-edit.');
    const body = z.object({ students: z.array(z.string()).max(100) }).parse(req.body);
    const to = body.students.filter((s) => s !== who(req));
    if (!to.length) throw new AppError(400, 'Choose at least one classmate.');
    for (const sid of to) {
      if (!store.isEnrolled(sid, nb.courseId) || store.courseRole(sid, nb.courseId) !== 'student')
        throw new AppError(400, 'Choose a student in this course.');
    }
    store.setNotebookKind(nb.id, 'group');
    // Once a copy is co-owned, the original sender must not keep changing or deleting content
    // underneath the group. Freeze the incoming link and any old pullable copies of this source.
    if (nb.shareId) {
      const incoming = store.shareByCopy(nb.id);
      if (incoming) {
        store.setShareMode(incoming.id, 'snapshot');
        store.setNotebookShare(nb.id, {
          shareId: incoming.id,
          sourceNotebookId: incoming.sourceNotebookId,
          sourceRevision: incoming.sourceRevision,
          shareMode: 'snapshot',
        });
      }
    }
    store.detachSharesFrom(nb.id);
    // A note that becomes a group note leaves the anonymous bank immediately; its old fragment
    // rows stay for citations, but the next merge rebuilds the slide without them.
    for (const page of store.pages(nb.id)) {
      store.retirePageFragments(page.id);
      store.setIndex(page.id, 'indexed');
    }
    // Rebuild the slides this note used to feed, so an already-merged entry does not survive as
    // peer knowledge after the note becomes a group note.
    jobs.markNotebookDirty(nb.id);
    store.ensureNotebookOwner(nb.id, nb.studentId);
    for (const sid of to) store.inviteNotebookMember(nb.id, sid, who(req));
    return { ok: true, members: store.notebookMembers(nb.id) };
  });
  const invitedNotebook = (req: FastifyRequest, nid: string) => {
    const nb = store.notebook(nid);
    if (!store.isEnrolled(who(req), nb.courseId)) throw new AppError(403, `Join ${store.course(nb.courseId).code} to open its notebooks.`);
    const m = store.notebookMember(nid, who(req));
    if (!m || m.status !== 'invited') throw new AppError(404, 'That invitation is no longer waiting.');
    return nb;
  };
  app.post('/api/notebooks/:id/members/accept', async (req) => {
    const nb = invitedNotebook(req, (req.params as { id: string }).id);
    store.acceptNotebookInvite(nb.id, who(req));
    return { ok: true, notebookId: nb.id };
  });
  app.post('/api/notebooks/:id/members/decline', async (req) => {
    const nb = invitedNotebook(req, (req.params as { id: string }).id);
    store.declineNotebookInvite(nb.id, who(req));
    return { ok: true };
  });
  app.delete('/api/notebooks/:id/members/:studentId', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const sid = (req.params as { studentId: string }).studentId;
    if (sid !== who(req) && nb.role !== 'owner') throw new AppError(403, 'Only the owner can remove collaborators.');
    if (sid === who(req) && nb.role === 'owner') {
      const others = store.notebookMembers(nb.id).filter((m) => m.status === 'active' && m.id !== sid);
      if (!others.length) throw new AppError(400, 'Invite someone before leaving this group note.');
      store.handOverNotebook(nb.id, sid);
    }
    store.removeNotebookMember(nb.id, sid);
    return { ok: true };
  });
  app.post('/api/notebooks/:id/presence', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (nb.kind !== 'group') return { ok: true };
    const body = z.object({ pageId: z.string().max(64).nullable().optional() }).parse(req.body ?? {});
    if (body.pageId && !store.pages(nb.id).some((p) => p.id === body.pageId)) return { ok: true };
    store.touchPresence(nb.id, who(req), body.pageId ?? null);
    return { ok: true };
  });
  app.get('/api/notebooks/:id/presence', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const nowMs = Date.now();
    return store.presence(nb.id).filter((p) => nowMs - new Date(p.updatedAt).getTime() < 30_000);
  });
  /** Pull the latest source changes into a pullable copy. */
  app.post('/api/notebooks/:id/fetch', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (nb.kind === 'group' && nb.role !== 'owner') throw new AppError(403, 'Only the owner controls the source link.');
    return syncCopy({ store, dataDir, copyNotebookId: nb.id });
  });
  /** Stop following the source; the copy becomes a snapshot. */
  app.post('/api/notebooks/:id/detach', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (nb.kind === 'group' && nb.role !== 'owner') throw new AppError(403, 'Only the owner controls the source link.');
    const share = store.shareByCopy(nb.id);
    if (!share) throw new AppError(400, 'This notebook is not a received copy.');
    store.setShareMode(share.id, 'snapshot');
    store.setNotebookShare(nb.id, { shareId: share.id, sourceNotebookId: share.sourceNotebookId, sourceRevision: share.sourceRevision, shareMode: 'snapshot' });
    return { ok: true };
  });
  app.post('/api/shares/:id/seen', async (req) => {
    const sh = store.shareById((req.params as { id: string }).id);
    if (!sh || sh.toStudentId !== who(req)) throw new AppError(404, 'Share not found.');
    store.markShareNotified(sh.id);
    store.markShareViewed(sh.id);
    return { ok: true };
  });
  /** The small inbox: received copies, co-edit invitations and a live class handout. */
  app.get('/api/notices', async (req) => {
    const sid = who(req);
    const shares: ShareNotice[] = store.pendingShares(sid).map((s) => ({
      shareId: s.shareId,
      notebookId: s.notebookId,
      courseId: s.courseId,
      fromName: s.fromName,
      title: s.title,
      mode: s.mode === 'pull' ? 'pull' : 'snapshot',
      kind: 'copy',
      createdAt: s.createdAt,
    }));
    const invites: InviteNotice[] = store.pendingInvites(sid).map((i) => ({
      notebookId: i.notebookId,
      courseId: i.courseId,
      fromName: i.fromName,
      title: i.title,
      createdAt: i.createdAt,
    }));
    let live: LiveSession | null = null;
    for (const cid of store.enrolledCourseIds(sid)) {
      const s = store.activeLive(cid);
      if (s) {
        live = liveView(s, sid);
        break;
      }
    }
    return { shares, invites, live };
  });

  // ---------------- live handouts (professor broadcasts the current page)
  app.post('/api/notebooks/:id/live', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (!store.isInstructor(who(req), nb.courseId) || nb.studentId !== who(req)) throw new AppError(403, 'Only the professor can go live with their own notes.');
    if (nb.kind === 'shared' || nb.kind === 'group') throw new AppError(400, 'Go live from your own notebook, not from a received or group note.');
    const body = z.object({ pullable: z.boolean().default(true), pageId: z.string().max(64).nullable().optional() }).parse(req.body ?? {});
    if (store.activeLive(nb.courseId)) throw new AppError(409, 'A live handout is already running in this course.');
    const pages = store.pages(nb.id);
    const current = body.pageId && pages.some((p) => p.id === body.pageId) ? body.pageId : (pages[0]?.id ?? null);
    const lid = store.createLiveSession({ courseId: nb.courseId, hostId: who(req), notebookId: nb.id, title: nb.title, currentPageId: current, pullable: body.pullable });
    return liveView(store.liveSession(lid), who(req));
  });
  app.patch('/api/live/:id', async (req) => {
    const s = store.liveSession((req.params as { id: string }).id);
    if (s.hostId !== who(req)) throw new AppError(403, 'Only the professor can move the live page.');
    if (s.endedAt) throw new AppError(400, 'That live session has ended.');
    const body = z.object({ pageId: z.string().max(64).nullable() }).parse(req.body);
    if (body.pageId && !store.pages(s.notebookId).some((p) => p.id === body.pageId))
      throw new AppError(400, 'That page is not in the live notebook.');
    store.updateLivePage(s.id, body.pageId);
    return liveView(store.liveSession(s.id), who(req));
  });
  app.post('/api/live/:id/end', async (req) => {
    const s = store.liveSession((req.params as { id: string }).id);
    if (s.hostId !== who(req)) throw new AppError(403, 'Only the professor can end the live handout.');
    await finishLive(s);
    return liveView(store.liveSession(s.id), who(req));
  });
  app.get('/api/live/active', async (req) => {
    const c = course(req);
    const s = store.activeLive(c.id);
    return s ? liveView(s, who(req)) : null;
  });
  app.get('/api/live/:id', async (req) => {
    const s = store.liveSession((req.params as { id: string }).id);
    enrolledIn(req, s.courseId);
    return liveView(s, who(req));
  });
  app.get('/api/live/:id/page.png', async (req, res) => {
    const s = store.liveSession((req.params as { id: string }).id);
    enrolledIn(req, s.courseId);
    // A live image is only the host's current page while the session is active. It must be a page
    // of the host's own live notebook, never an arbitrary page id.
    if (s.endedAt) throw new AppError(404, 'That live session has ended.');
    if (!s.currentPageId) throw new AppError(404, 'No page is being shown.');
    const page = store.page(s.currentPageId);
    if (page.notebookId !== s.notebookId) throw new AppError(404, 'No page is being shown.');
    const png = await renderPage(page, store, dataDir, { width: 1400 });
    res.type('image/png').header('cache-control', 'no-store');
    return res.send(png);
  });

  // ---------------- folders (inside "My notes"; lectures are the course's and are not filed)
  const FolderName = z.string().trim().min(1).max(80);
  app.get('/api/folders', async (req) => store.folders(course(req).id, who(req)));
  app.post('/api/folders', async (req) => {
    const body = z.object({ name: FolderName, parentId: z.string().max(64).nullable().default(null) }).parse(req.body);
    const c = course(req);
    const parentId = folderIn(req, c.id, body.parentId);
    const { studentId: _s, ...f } = store.folder(store.createFolder({ courseId: c.id, studentId: who(req), parentId, name: body.name }));
    return f;
  });
  app.patch('/api/folders/:id', async (req) => {
    const f = ownFolder(req, (req.params as { id: string }).id);
    store.renameFolder(f.id, z.object({ name: FolderName }).parse(req.body).name);
    const { studentId: _s, ...out } = store.folder(f.id);
    return out;
  });
  app.delete('/api/folders/:id', async (req) => {
    store.deleteFolder(ownFolder(req, (req.params as { id: string }).id).id);
    return { ok: true };
  });
  app.delete('/api/notebooks/:id', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    if (nb.kind === 'group' && nb.role !== 'owner') throw new AppError(403, 'Only the owner can delete a group note.');
    const live = store.activeLive(nb.courseId);
    if (live && live.notebookId === nb.id && live.hostId === who(req)) await finishLive(live);
    const slides = new Set(
      store
        .pages(nb.id)
        .map((p) => p.slideId ?? p.link.slideId)
        .filter((s): s is string => Boolean(s)),
    );
    store.deleteNotebook(nb.id);
    for (const slideId of slides) jobs.mergeSlide(slideId, { force: true });
    return { ok: true };
  });
  app.post('/api/notebooks/:id/pages', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    // No kind given: the new sheet is the notebook's own paper, so a memo notebook keeps making memos.
    const body = z.object({ after: z.string().nullable().default(null), kind: PaperZ.optional() }).parse(req.body);
    const pid = addBlankPage(store, nb.id, body.kind ?? nb.paper, body.after);
    const { notebookStudentId: _a, courseId: _b, contentHash: _c, indexedRevision: _d, image: _e, ...p } = store.page(pid);
    return { ...p, peerCount: 0 };
  });

  // ---------------- pages
  app.put('/api/pages/:id', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    const Base = z.object({ strokes: z.array(StrokeZ).max(5000), items: z.array(ItemZ).max(300) });
    const body = z
      .object({
        revision: z.number().int(),
        strokes: z.array(StrokeZ).max(5000),
        items: z.array(ItemZ).max(300),
        base: Base.optional(),
      })
      .parse(req.body);
    const nb = store.notebook(p.notebookId);
    let revision: number;
    if (nb.kind === 'group' && body.base) {
      revision = store.savePageMerged(p.id, body.base.strokes as Stroke[], body.base.items as Item[], body.strokes as Stroke[], body.items as Item[], who(req));
      jobs.scheduleIndex(p.id);
      return { revision, page: store.page(p.id) };
    }
    if (nb.kind === 'shared') {
      revision = store.savePageCopy(p.id, body.revision, body.strokes as Stroke[], body.items as Item[], who(req));
      jobs.scheduleIndex(p.id);
      return { revision, page: store.page(p.id) };
    }
    revision = store.savePage(p.id, body.revision, body.strokes as Stroke[], body.items as Item[]);
    jobs.scheduleIndex(p.id);
    return { revision };
  });
  app.delete('/api/pages/:id', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    const nb = store.notebook(p.notebookId);
    if (p.kind === 'slide' && nb.kind !== 'shared' && nb.kind !== 'group') throw new AppError(400, 'Slide pages are part of the lecture and cannot be deleted.');
    if (store.pages(p.notebookId).length <= 1) throw new AppError(400, 'A notebook needs at least one page.');
    if ((nb.kind === 'shared' || nb.kind === 'group') && p.sourcePageId) store.addDeletedSourcePage(nb.id, p.sourcePageId);
    const slideId = p.slideId ?? p.link.slideId;
    store.deletePage(p.id);
    // If this page was the last note on its slide, the entry must not linger in the bank.
    if (slideId) jobs.mergeSlide(slideId, { force: true });
    return { ok: true };
  });
  app.get('/api/pages/:id/status', async (req) => pageStatus(ownPage(req, (req.params as { id: string }).id).id));
  /** Re-papering one sheet keeps its strokes and items; only the ruling and the sheet's proportions change. */
  app.patch('/api/pages/:id/paper', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    if (p.kind === 'slide' || p.kind === 'pdf') throw new AppError(400, 'Slide and PDF pages keep their own background.');
    const body = z.object({ kind: PaperZ }).parse(req.body);
    const size = paperSize(body.kind);
    store.setPagePaper(p.id, body.kind, size.width, size.height);
    jobs.scheduleIndex(p.id);
    return { kind: body.kind, ...size };
  });
  app.post('/api/pages/:id/link', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    if (p.kind === 'slide') throw new AppError(400, 'Slide pages are already linked to their slide.');
    const body = z.object({ lectureId: z.string().nullable(), slideId: z.string().nullable() }).parse(req.body);
    if (body.lectureId && store.lecture(body.lectureId).courseId !== p.courseId) throw new AppError(400, 'Pages can only be linked to lectures of their own course.');
    if (body.slideId && store.slide(body.slideId)?.lectureId !== body.lectureId) throw new AppError(400, 'That slide is not in the chosen lecture.');
    store.setLink(p.id, { lectureId: body.lectureId, slideId: body.slideId, confidence: body.lectureId ? 1 : 0, confirmed: Boolean(body.lectureId) });
    jobs.scheduleIndex(p.id, 500);
    return pageStatus(p.id);
  });
  app.get('/api/pages/:id/shared', async (req) => {
    const page = ownPage(req, (req.params as { id: string }).id);
    // Only the viewer's own transcription is theirs; another group member's private fragments
    // must not become visible just because the page is co-owned.
    return store.pageFragments(page.id).filter((f) => f.studentId === who(req));
  });
  /**
   * Inline suggestions: this page's gaps with whatever fills them, plus the author's own notes.
   * Opening a page refreshes gaps once if this slide's knowledge changed since it was last read,
   * so a classmate's new note replaces "From slide 12" without waiting for the student to write.
   */
  app.get('/api/pages/:id/suggestions', async (req) => {
    const page = ownPage(req, (req.params as { id: string }).id);
    jobs.refreshGapsOnOpen(page.id);
    return pageSuggestions(store, page.id, who(req));
  });
  /** Everything waiting in this notebook, grouped by page: the browser behind the panel. */
  app.get('/api/notebooks/:id/suggestions', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return notebookSuggestions(store, nb.id, who(req));
  });
  /** A gap with neither a classmate entry nor a slide behind it is explained on demand. */
  app.post('/api/pages/:id/suggestions/:gapId/fill', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    return expandGap(store, ai, dataDir, { studentId: who(req), pageId: p.id, gapId: (req.params as { gapId: string }).gapId });
  });
  app.post('/api/pages/:id/suggestions/:gapId/dismiss', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    store.dismissGap(who(req), (req.params as { gapId: string }).gapId);
    return { ok: true };
  });
  app.get('/api/pages/:id/render.png', async (req, res) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    const width = Math.min(1600, Math.max(200, Number((req.query as { w?: string }).w) || 1200));
    res.type('image/png').header('cache-control', 'private, max-age=30');
    return renderPage(p, store, dataDir, { width, annotations: true });
  });

  // ---------------- classmate fragments
  const crops = new Map<string, Buffer>();
  app.get('/api/fragments/:id/crop.png', async (req, res) => {
    const f = store.fragment((req.params as { id: string }).id);
    const superseded = f ? store.supersededBy(f.id) : null;
    if (!f || (f.studentId !== who(req) && (!store.isEnrolled(who(req), f.courseId) || (!f.shared && !superseded))))
      throw new AppError(404, 'Note not found.');
    const key = `${f.id}:${f.pageRevision}`;
    let png = crops.get(key);
    if (!png) {
      const page = store.page(f.pageId);
      // Crop from the page as it was indexed, without anyone's AI annotations. A received copy's
      // crop must not reveal the shared layer behind the recipient's own note.
      png = await cropPng(await renderPage(page, store, dataDir, { width: 1400, ownOnly: page.notebookKind === 'shared' }), f.bbox);
      if (crops.size > 300) crops.delete(crops.keys().next().value!);
      crops.set(key, png);
    }
    res.type('image/png').header('cache-control', 'private, max-age=60');
    return png;
  });
  app.get('/api/fragments/:id', async (req) => {
    const f = store.fragment((req.params as { id: string }).id);
    const superseded = f ? store.supersededBy(f.id) : null;
    // A citation already in someone's notes still resolves after the author edits the note, but a
    // retired group/instructor fragment does not become readable to non-authors.
    if (!f || (f.studentId !== who(req) && (!store.isEnrolled(who(req), f.courseId) || (!f.shared && !superseded))))
      throw new AppError(404, 'Note not found.');
    const slide = f.slideId ? store.slide(f.slideId) : null;
    const out = { ...f, slide: slide ? { id: slide.id, page: slide.page, title: slide.digest?.title ?? '' } : null };
    if (f.studentId === who(req)) return out;
    // The anonymous bank never names a classmate, even on the detail route.
    const { studentId: _studentId, authorName: _authorName, authorColor: _authorColor, ...safe } = out;
    return safe;
  });
  app.post('/api/fragments/:id/dismiss', async (req) => {
    store.dismiss(who(req), (req.params as { id: string }).id);
    return { ok: true };
  });

  // ---------------- knowledge entries: reports and rechecks
  /** "Looks wrong": hides the entry from everyone's suggestions until it is rechecked. */
  app.post('/api/entries/:id/report', async (req) => {
    const entryId = (req.params as { id: string }).id;
    const entry = store.entry(entryId);
    if (!entry || !store.isEnrolled(who(req), entry.courseId)) throw new AppError(404, 'That suggestion no longer exists.');
    const reason = z.object({ reason: z.string().max(400).default('') }).parse(req.body ?? {}).reason;
    store.reportEntry(entryId, who(req), reason);
    jobs.recheckEntry(entryId);
    return { ok: true };
  });
  /** Rechecks one entry on demand: the author after fixing a note, or a stuck dispute. */
  app.post('/api/entries/:id/recheck', async (req) => {
    const entryId = (req.params as { id: string }).id;
    const entry = store.entry(entryId);
    if (!entry) throw new AppError(404, 'That suggestion no longer exists.');
    if (!store.isEnrolled(who(req), entry.courseId)) throw new AppError(403, 'Join the course to check its notes.');
    const f = store.entrySources(entryId).find((x) => x.studentId === who(req));
    // Only the author can ask for their own note to be checked again.
    if (!f) throw new AppError(403, 'This note belongs to another student.');
    jobs.recheckEntry(entryId);
    return { ok: true };
  });
  /** Marks a notebook as left: its slides' notes are merged and checked for classmates. */
  app.post('/api/notebooks/:id/close', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return { slides: jobs.markNotebookDirty(nb.id) };
  });

  // ---------------- AI study tools
  // Ask conversations: a notebook has many sessions, each with a thread of messages.
  app.get('/api/notebooks/:id/ask/sessions', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return { sessions: store.askSessions(nb.id, who(req)) };
  });
  app.get('/api/ask/sessions/:id', async (req) => {
    const session = store.askSession((req.params as { id: string }).id, who(req));
    const nb = store.notebook(session.notebookId);
    if (!store.isEnrolled(who(req), nb.courseId)) throw new AppError(403, `Join ${store.course(nb.courseId).code} to open its conversations.`);
    return session;
  });
  app.post('/api/ask', async (req) => {
    const body = z
      .object({ pageId: z.string(), bbox: BBox.nullable().optional(), question: z.string().max(600).optional(), sessionId: z.string().max(64).optional() })
      .parse(req.body);
    const page = ownPage(req, body.pageId);
    const notebook = store.notebook(page.notebookId);
    const question = (body.question?.trim() || 'What am I missing on this page?').slice(0, 600);
    // A lasso ask is a one-off about a selection; the panel's Ask is a conversation and is remembered.
    if (body.bbox && !body.sessionId) return ask(store, ai, dataDir, { studentId: who(req), ...body });
    let session;
    if (body.sessionId) {
      session = store.askSession(body.sessionId, who(req));
      if (session.notebookId !== notebook.id) throw new AppError(400, 'That conversation belongs to another notebook.');
    } else {
      session = store.createAskSession(notebook.id, who(req), question.slice(0, 60));
    }
    const pageLabel = `${page.kind === 'slide' ? 'Slide' : 'Page'} ${page.position}`;
    const questionMessage = store.addAskMessage(session.id, { role: 'user', text: question, cards: [], pageId: page.id, pageLabel });
    // The model call is the slow part. The question is already in the thread, so a failure can be retried.
    const result = await ask(store, ai, dataDir, { studentId: who(req), pageId: body.pageId, bbox: body.bbox, question: body.question });
    const message = store.addAskMessage(session.id, { role: 'assistant', text: '', cards: result.cards, pageId: page.id, pageLabel });
    return { ...result, sessionId: session.id, sessionTitle: session.title, questionMessage, message };
  });
  app.post('/api/quizzes', async (req) => {
    const body = z
      .object({ scope: z.object({ kind: z.enum(['lecture', 'page', 'selection']), lectureId: z.string(), pageId: z.string().optional() }), bbox: BBox.nullable().optional() })
      .parse(req.body);
    if (body.scope.pageId) ownPage(req, body.scope.pageId);
    if (body.scope.kind === 'lecture') lectureFor(req, body.scope.lectureId);
    return makeQuiz(store, ai, dataDir, { studentId: who(req), ...body });
  });
  app.post('/api/quizzes/:id/grade', async (req) => {
    const body = z.object({ answers: z.record(z.string(), z.number().int()) }).parse(req.body);
    return gradeQuiz(store, (req.params as { id: string }).id, who(req), body.answers);
  });

  // ---------------- uploads & assets
  app.post('/api/files', async (req) => {
    const file = await req.file();
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) throw new AppError(400, 'Insert a PNG, JPEG, WebP or GIF image.');
    let buf = await file.toBuffer();
    if (buf.length > 15 * 1024 * 1024) throw new AppError(400, 'Images are limited to 15 MB.');
    buf = await sharp(buf, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(buf).metadata();
    const fid = await storeFile(store, dataDir, buf, file.filename.replace(/\.\w+$/, '') + '.png', 'image/png', who(req));
    return { id: fid, width: meta.width, height: meta.height };
  });
  app.get('/api/files/:id', async (req, res) => {
    const f = store.file((req.params as { id: string }).id);
    if (!f || !f.mime.startsWith('image/')) throw new AppError(404, 'File not found.');
    if (!store.canAccessFile(f.id, who(req))) throw new AppError(404, 'File not found.');
    res.type(f.mime).header('cache-control', 'private, max-age=86400');
    return readFile(f.path);
  });
  // Design prototypes for review (static HTML, no data): /proto/<name>/
  if (existsSync(resolve('proto'))) await app.register(fastifyStatic, { root: resolve('proto'), prefix: '/proto/', decorateReply: false });
  await app.register(fastifyStatic, { root: resolve(dataDir, 'assets'), prefix: '/api/assets/', decorateReply: false, maxAge: '7d' });
  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: false });
    app.setNotFoundHandler(async (req, res) => (req.url.startsWith('/api/') ? res.code(404).send({ error: 'Not found.' }) : res.type('text/html').send(await readFile(join(dist, 'index.html')))));
  }
  app.addHook('onReady', async () => jobs.resume());
  return { app, jobs };
}
