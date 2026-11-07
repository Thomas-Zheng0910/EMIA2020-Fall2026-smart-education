import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { Store, hash, id } from './db';
import { renderPdf } from './pdf';
import type { Jobs } from './jobs';
import type { PageKind } from '../shared/types';

export async function storeFile(store: Store, dataDir: string, src: string | Buffer, name: string, mime: string, uploadedBy: string | null = null) {
  await mkdir(join(dataDir, 'files'), { recursive: true });
  const buf = typeof src === 'string' ? await readFile(src) : src;
  const path = join(dataDir, 'files', id() + (extname(name).toLowerCase() || ''));
  if (typeof src === 'string') await copyFile(src, path);
  else await writeFile(path, buf);
  return store.addFile(path, mime, name, hash(buf), uploadedBy);
}

export function guessLecture(filename: string) {
  const base = filename.replace(/\.pdf$/i, '').replace(/\s*\(\d+\)$/, '');
  const m = /^(\d+)[-_ ](.*)$/.exec(base);
  const words = (m ? m[2]! : base).replace(/-full$/i, '').replace(/[-_]+/g, ' ').trim();
  const title = words.replace(/\b(ai|ann|cnn|knn)\b/gi, (w) => w.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
  return { number: m ? Number(m[1]) : null, title };
}

export async function importLecture(
  store: Store,
  jobs: Jobs,
  dataDir: string,
  courseId: string,
  pdf: string | Buffer,
  filename: string,
  meta: { number?: number | null; title?: string } = {},
) {
  const guess = guessLecture(filename);
  const existing = store.lectures(courseId);
  const number = meta.number ?? guess.number ?? Math.max(0, ...existing.map((l) => l.number)) + 1;
  const fileId = await storeFile(store, dataDir, pdf, filename, 'application/pdf');
  const lectureId = store.addLecture(courseId, number, meta.title || guess.title, fileId);
  try {
    const pages = await renderPdf(store.file(fileId)!.path, join(dataDir, 'assets'), `lectures/${lectureId}`);
    store.tx(() => {
      for (const p of pages) store.addSlide(lectureId, p.page, p.width, p.height, p.image, p.text);
    });
    store.setLecture(lectureId, { pageCount: pages.length, status: 'digesting' });
    jobs.digestLecture(lectureId);
  } catch (e) {
    store.setLecture(lectureId, { status: 'failed', error: (e as Error).message });
    throw e;
  }
  return lectureId;
}

/**
 * The student's own copy of a deck, which holds only their edits. It is created the first time they
 * file or rename the deck — with no pages yet, so an unopened deck costs one row, not a duplicate of
 * the slides. The slides themselves stay the course's single shared record.
 */
export function fileLectureNotebook(store: Store, studentId: string, lectureId: string, filing: { folderId?: string | null; title?: string } = {}) {
  const existing = store.lectureNotebook(studentId, lectureId);
  if (existing) {
    if (filing.folderId !== undefined) store.setNotebookFolder(existing, filing.folderId);
    if (filing.title !== undefined) store.renameNotebook(existing, filing.title);
    return existing;
  }
  const lec = store.lecture(lectureId);
  const nid = store.createNotebook({
    courseId: lec.courseId,
    studentId,
    lectureId,
    title: filing.title ?? `L${lec.number} · ${lec.title}`,
    kind: 'lecture',
    folderId: filing.folderId ?? null,
  });
  return nid;
}

/** Opening a deck makes its pages the first time; afterwards it is the same notebook with the student's ink. */
export function openLectureNotebook(store: Store, studentId: string, lectureId: string, folderId?: string | null) {
  const existing = store.lectureNotebook(studentId, lectureId);
  const nid = fileLectureNotebook(store, studentId, lectureId, folderId === undefined ? {} : { folderId });
  if (existing && store.pages(existing).length) return existing;
  const lec = store.lecture(lectureId);
  store.tx(() => {
    for (const s of store.slides(lectureId))
      store.addPage({ notebookId: nid, position: s.page, kind: 'slide', slideId: s.id, width: s.width, height: s.height, link: { lectureId, slideId: s.id, confidence: 1, confirmed: true } });
  });
  return nid;
}

export async function importNotebookPdf(store: Store, jobs: Jobs, dataDir: string, courseId: string, studentId: string, pdf: string | Buffer, filename: string, title?: string) {
  const fileId = await storeFile(store, dataDir, pdf, filename, 'application/pdf');
  const nid = store.createNotebook({ courseId, studentId, lectureId: null, title: title || filename.replace(/\.pdf$/i, ''), kind: 'pdf' });
  try {
    const pages = await renderPdf(store.file(fileId)!.path, join(dataDir, 'assets'), `notebooks/${nid}`);
    const ids = store.tx(() => pages.map((p) => store.addPage({ notebookId: nid, position: p.page, kind: 'pdf', background: p.image, width: p.width, height: p.height })));
    for (const pid of ids) jobs.scheduleIndex(pid, 0);
  } catch (e) {
    store.deleteNotebook(nid);
    throw e;
  }
  return nid;
}

export const PAPER_HEIGHT = 1414;
export function paperSize(_kind: PageKind) {
  return { width: 1000, height: PAPER_HEIGHT };
}
export function addBlankPage(store: Store, notebookId: string, kind: PageKind, after: string | null) {
  const pages = store.pages(notebookId);
  const idx = after ? pages.findIndex((p) => p.id === after) : pages.length - 1;
  const prev = pages[idx];
  const next = pages[idx + 1];
  const position = prev ? (next ? (prev.position + next.position) / 2 : prev.position + 1) : 1;
  // A page inserted after a slide inherits that slide as its suggested topic.
  const link = prev?.link.lectureId ? { lectureId: prev.link.lectureId, slideId: prev.link.slideId, confidence: prev.link.confidence, confirmed: prev.link.confirmed } : undefined;
  const size = paperSize(kind);
  return store.addPage({ notebookId, position, kind, width: size.width, height: size.height, link });
}
