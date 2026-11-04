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
import { importLecture, importNotebookPdf, openLectureNotebook, fileLectureNotebook, addBlankPage, storeFile, PAPER_HEIGHT } from './importer';
import { renderPage, cropPng } from './render';
import { ask, makeQuiz, gradeQuiz } from './study';
import { pageSuggestions, expandGap } from './suggestions';
import type { Bootstrap, Item, Stroke } from '../shared/types';

const num = z.number().finite();
const StrokeZ = z.object({
  id: z.string().max(64),
  tool: z.enum(['pen', 'highlighter']),
  color: z.string().max(32),
  size: num.min(0.5).max(80),
  points: z.array(num).max(30000),
});
const CitationZ = z.union([
  z.object({ kind: z.literal('slide'), slideId: z.string(), lectureNumber: num, page: num, label: z.string().max(300) }),
  z.object({ kind: z.literal('fragment'), fragmentId: z.string(), author: z.string().max(100), label: z.string().max(300) }),
]);
const ItemZ = z.discriminatedUnion('type', [
  z.object({ id: z.string().max(64), type: z.literal('text'), x: num, y: num, w: num, text: z.string().max(20000), color: z.string().max(32), size: num.min(6).max(96) }),
  z.object({ id: z.string().max(64), type: z.literal('image'), x: num, y: num, w: num, h: num, fileId: z.string().max(64) }),
  z.object({
    id: z.string().max(64),
    type: z.literal('annotation'),
    x: num,
    y: num,
    w: num,
    title: z.string().max(300),
    body: z.string().max(8000),
    basis: z.enum(['official', 'peer', 'ai']),
    citations: z.array(CitationZ).max(12),
    collapsed: z.boolean().optional(),
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
    if (p.notebookStudentId !== who(req)) throw new AppError(403, 'This page belongs to another student.');
    if (!store.isEnrolled(who(req), p.courseId)) throw new AppError(403, `Join ${store.course(p.courseId).code} to open its notebooks.`);
    return p;
  };
  const ownNotebook = (req: FastifyRequest, nid: string) => {
    const n = store.notebook(nid);
    if (n.studentId !== who(req)) throw new AppError(403, 'This notebook belongs to another student.');
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
      if (nb.studentId !== who(req)) return res.code(403).send({ error: 'This notebook belongs to another student.' });
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
    return {
      courses: store.courseSummaries(sid),
      enrolled,
      course: current ? store.course(current) : null,
      lectures: current ? withProgress(current, sid) : [],
      recent: store.recentNotebooks(sid),
      students: store.students(),
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
    const cid = body.code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';
    if (store.courses().some((c) => c.id === cid || c.code.toLowerCase() === body.code.toLowerCase()))
      throw new AppError(409, `${body.code} already exists. Join it instead.`);
    store.upsertCourse({ id: cid, code: body.code.toUpperCase(), name: body.name, description: body.description });
    store.enroll(who(req), cid);
    return store.course(cid);
  });
  app.patch('/api/courses/:id', async (req) => {
    const c = enrolledIn(req, (req.params as { id: string }).id);
    const body = CourseBody.partial().parse(req.body);
    store.upsertCourse({ ...c, ...body, code: (body.code ?? c.code).toUpperCase() });
    return store.course(c.id);
  });
  app.post('/api/courses/:id/enroll', async (req) => {
    const c = store.course((req.params as { id: string }).id);
    store.enroll(who(req), c.id);
    return { ok: true };
  });
  app.delete('/api/courses/:id/enroll', async (req) => {
    const c = store.course((req.params as { id: string }).id);
    store.unenroll(who(req), c.id); // notebooks are kept and reappear on rejoining
    return { ok: true };
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
    const file = await req.file();
    if (!file || !/\.pdf$/i.test(file.filename)) throw new AppError(400, 'Choose a lecture PDF.');
    const buf = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: string }>;
    const number = fields.number?.value ? Number(fields.number.value) : null;
    const lid = await importLecture(store, jobs, dataDir, course(req).id, buf, file.filename, { number, title: fields.title?.value });
    return store.lecture(lid);
  });
  app.post('/api/lectures/:id/redigest', async (req) => {
    jobs.digestLecture(lectureFor(req, (req.params as { id: string }).id).id);
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
      .object({ title: z.string().trim().min(1).max(120), paper: z.enum(['blank', 'ruled', 'grid']).default('ruled'), folderId: z.string().max(64).nullable().optional() })
      .parse(req.body);
    const c = course(req);
    const folderId = folderIn(req, c.id, body.folderId);
    const nid = store.createNotebook({ courseId: c.id, studentId: who(req), lectureId: null, title: body.title, kind: 'blank', folderId });
    store.addPage({ notebookId: nid, position: 1, kind: body.paper, width: 1000, height: PAPER_HEIGHT });
    return { id: nid };
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
    return { notebook: nb, pages: notebookPages(nb.id, nb.studentId) };
  });
  /** Lightweight per-page status (indexing, links, classmate counts) without ink. */
  app.get('/api/notebooks/:id/status', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    return notebookPages(nb.id, nb.studentId).map((p) => ({
      id: p.id,
      indexStatus: p.indexStatus,
      indexError: p.indexError,
      link: p.link,
      sharedCount: p.sharedCount,
      linkedSlides: p.linkedSlides,
      peerCount: p.peerCount,
      suggestVersion: p.suggestVersion,
    }));
  });
  app.patch('/api/notebooks/:id', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), folderId: z.string().max(64).nullable().optional() }).parse(req.body);
    if (body.folderId !== undefined) store.setNotebookFolder(nb.id, folderIn(req, nb.courseId, body.folderId));
    if (body.title !== undefined) store.renameNotebook(nb.id, body.title);
    return { ok: true };
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
    store.deleteNotebook(nb.id);
    return { ok: true };
  });
  app.post('/api/notebooks/:id/pages', async (req) => {
    const nb = ownNotebook(req, (req.params as { id: string }).id);
    const body = z.object({ after: z.string().nullable().default(null), kind: z.enum(['blank', 'ruled', 'grid']).default('ruled') }).parse(req.body);
    const pid = addBlankPage(store, nb.id, body.kind, body.after);
    const { notebookStudentId: _a, courseId: _b, contentHash: _c, indexedRevision: _d, image: _e, ...p } = store.page(pid);
    return { ...p, peerCount: 0 };
  });

  // ---------------- pages
  app.put('/api/pages/:id', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    const body = z.object({ revision: z.number().int(), strokes: z.array(StrokeZ).max(5000), items: z.array(ItemZ).max(300) }).parse(req.body);
    const revision = store.savePage(p.id, body.revision, body.strokes as Stroke[], body.items as Item[]);
    jobs.scheduleIndex(p.id);
    return { revision };
  });
  app.delete('/api/pages/:id', async (req) => {
    const p = ownPage(req, (req.params as { id: string }).id);
    if (p.kind === 'slide') throw new AppError(400, 'Slide pages are part of the lecture and cannot be deleted.');
    if (store.pages(p.notebookId).length <= 1) throw new AppError(400, 'A notebook needs at least one page.');
    store.deletePage(p.id);
    return { ok: true };
  });
  app.get('/api/pages/:id/status', async (req) => pageStatus(ownPage(req, (req.params as { id: string }).id).id));
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
  app.get('/api/pages/:id/shared', async (req) => store.pageFragments(ownPage(req, (req.params as { id: string }).id).id));
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
    if (!f || (f.studentId !== who(req) && (!f.shared || !store.isEnrolled(who(req), f.courseId)))) throw new AppError(404, 'Note not found.');
    const key = `${f.id}:${f.pageRevision}`;
    let png = crops.get(key);
    if (!png) {
      const page = store.page(f.pageId);
      // Crop from the page as it was indexed, without anyone's AI annotations.
      png = await cropPng(await renderPage(page, store, dataDir, { width: 1400 }), f.bbox);
      if (crops.size > 300) crops.delete(crops.keys().next().value!);
      crops.set(key, png);
    }
    res.type('image/png').header('cache-control', 'private, max-age=60');
    return png;
  });
  app.get('/api/fragments/:id', async (req) => {
    const f = store.fragment((req.params as { id: string }).id);
    if (!f || (f.studentId !== who(req) && (!f.shared || !store.isEnrolled(who(req), f.courseId)))) throw new AppError(404, 'Note not found.');
    const slide = f.slideId ? store.slide(f.slideId) : null;
    return { ...f, slide: slide ? { id: slide.id, page: slide.page, title: slide.digest?.title ?? '' } : null };
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
  app.post('/api/ask', async (req) => {
    const body = z.object({ pageId: z.string(), bbox: BBox.nullable().optional(), question: z.string().max(600).optional() }).parse(req.body);
    ownPage(req, body.pageId);
    return ask(store, ai, dataDir, { studentId: who(req), ...body });
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
    const fid = await storeFile(store, dataDir, buf, file.filename.replace(/\.\w+$/, '') + '.png', 'image/png');
    return { id: fid, width: meta.width, height: meta.height };
  });
  app.get('/api/files/:id', async (req, res) => {
    const f = store.file((req.params as { id: string }).id);
    if (!f || !f.mime.startsWith('image/')) throw new AppError(404, 'File not found.');
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
