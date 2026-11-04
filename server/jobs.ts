import { z } from 'zod';
import { join } from 'node:path';
import { Store, hash, AppError } from './db';
import { ModelGateway } from './ai';
import { pngBuffer } from './pdf';
import { renderPage, hasOriginalContent } from './render';
import type { Page, PrivateReason, SlideDigest } from '../shared/types';

const Digests = z.object({
  slides: z.array(
    z.object({
      page: z.number().int(),
      title: z.string().max(200),
      summary: z.string().max(2500),
      formulas: z.array(z.string().max(500)).max(20).default([]),
      topics: z.array(z.string().max(80)).max(8).default([]),
    }),
  ),
});

const Indexed = z.object({
  link: z.object({
    lectureNumber: z.number().int().nullable(),
    slide: z.number().int().nullable(),
    confidence: z.number().min(0).max(1),
  }),
  fragments: z
    .array(
      z.object({
        kind: z.enum(['explanation', 'example', 'derivation', 'definition', 'question', 'other']),
        text: z.string().min(1).max(3000),
        topic: z.string().max(120),
        confidence: z.number().min(0).max(1),
        bbox: z.array(z.number().min(0).max(1)).length(4),
        lectureNumber: z.number().int().nullable().optional(),
        slide: z.number().int().nullable().optional(),
        linkConfidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(30),
});

export const SHARE_THRESHOLD = 0.6;

const STOP = new Set('the and for with this that are was were from into its it is of to in on a an as by be or at can when what how which than then also called known stands given its their there these those has have had not but only'.split(' '));
const words = (s: string) =>
  (s.toLowerCase().replace(/\\[a-z]+/g, ' ').match(/[a-z]{3,}|\d+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, ''));
/**
 * True when a fragment mostly repeats the official slide text. Classmates already have the slide,
 * so these add nothing and would bury notes with real value.
 */
export function restatesSlide(text: string, slideText: string) {
  const f = words(text);
  if (f.length < 3 || !slideText.trim()) return false;
  const slide = new Set(words(slideText));
  return f.filter((w) => slide.has(w)).length / f.length >= 0.75;
}

/** Small concurrency-limited FIFO. */
class Pool {
  private running = 0;
  private q: (() => Promise<void>)[] = [];
  constructor(private limit: number) {}
  push(task: () => Promise<void>) {
    this.q.push(task);
    this.pump();
  }
  private pump() {
    while (this.running < this.limit && this.q.length) {
      const t = this.q.shift()!;
      this.running++;
      t()
        .catch((e) => console.error('[job]', e?.message ?? e))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
  get idle() {
    return this.running === 0 && this.q.length === 0;
  }
}

export class Jobs {
  private digestPool = new Pool(3);
  private indexPool = new Pool(2);
  private timers = new Map<string, NodeJS.Timeout>();
  private pendingIndex = new Set<string>();
  constructor(
    private store: Store,
    private ai: ModelGateway,
    private dataDir: string,
    public opts: { indexDelayMs: number; background: boolean } = { indexDelayMs: 6000, background: true },
  ) {}

  resume() {
    if (!this.opts.background) return;
    for (const course of this.store.courses())
      for (const l of this.store.lectures(course.id)) if (l.status === 'digesting' || (l.status === 'ready' && l.digested < l.pageCount)) this.digestLecture(l.id);
    for (const pid of this.store.queuedPages()) this.scheduleIndex(pid, 0);
  }

  get idle() {
    return this.digestPool.idle && this.indexPool.idle && this.timers.size === 0;
  }

  // ---------------- slide digests
  digestLecture(lectureId: string) {
    if (!this.ai.configured) {
      this.store.setLecture(lectureId, { status: 'ready', error: 'AI not configured: slide digests skipped; slide text is used instead.' });
      return;
    }
    const lecture = this.store.lecture(lectureId);
    const todo = this.store.slides(lectureId).filter((s) => !s.digest);
    if (!todo.length) return this.store.setLecture(lectureId, { status: 'ready', error: null });
    this.store.setLecture(lectureId, { status: 'digesting', error: null });
    let remaining = Math.ceil(todo.length / 6);
    let failed = 0;
    for (let i = 0; i < todo.length; i += 6) {
      const batch = todo.slice(i, i + 6);
      this.digestPool.push(async () => {
        try {
          const images = await Promise.all(
            batch.map(async (s) => ({ label: `Slide ${s.page}:`, png: await pngBuffer(join(this.dataDir, 'assets', s.image), 1024) })),
          );
          const out = await this.ai.json(
            `Lecture ${lecture.number}: "${lecture.title}". For each slide image below write a study digest: a short title, a faithful summary of everything taught on the slide (including diagrams, code and examples; 1-5 sentences), formulas in LaTeX, and 1-4 topic tags. Only describe what is on the slide.\nExtracted PDF text (spelling hints):\n` +
              batch.map((s) => `--- Slide ${s.page}\n${s.text.slice(0, 1200)}`).join('\n'),
            Digests,
            images,
          );
          for (const d of out.slides) {
            const s = batch.find((b) => b.page === d.page);
            if (s) this.store.setDigest(s.id, { title: d.title, summary: d.summary, formulas: d.formulas, topics: d.topics });
          }
        } catch (e) {
          failed++;
          this.store.setLecture(lectureId, { error: `Some slides could not be digested: ${(e as Error).message}` });
        } finally {
          if (--remaining === 0) this.store.setLecture(lectureId, { status: failed ? 'failed' : 'ready', ...(failed ? {} : { error: null }) });
        }
      });
    }
  }

  // ---------------- automatic page indexing
  scheduleIndex(pageId: string, delay = this.opts.indexDelayMs) {
    if (!this.opts.background) return;
    this.store.setIndex(pageId, 'queued');
    clearTimeout(this.timers.get(pageId));
    this.timers.set(
      pageId,
      setTimeout(() => {
        this.timers.delete(pageId);
        if (this.pendingIndex.has(pageId)) return;
        this.pendingIndex.add(pageId);
        this.indexPool.push(async () => {
          try {
            await this.indexPage(pageId);
          } finally {
            this.pendingIndex.delete(pageId);
          }
        });
      }, delay),
    );
  }

  originalHash(p: Page & { image?: string | null }) {
    // A confirmed whole-lecture link has no slide id, so include the lecture too. Guessed links stay
    // out of the hash: annotation-only edits must not trigger another model call.
    return hash(JSON.stringify([p.image, p.strokes, p.items.filter((i) => i.type !== 'annotation'), p.link.confirmed ? [p.link.lectureId, p.link.slideId] : null]));
  }

  async indexPage(pageId: string) {
    let page;
    try {
      page = this.store.page(pageId);
    } catch {
      return;
    }
    const rev = page.revision;
    const contentHash = this.originalHash(page);
    const original = page.kind === 'pdf' || hasOriginalContent(page);
    if (!original) {
      this.store.replaceFragments(pageId, rev, contentHash, []);
      return;
    }
    if (page.contentHash === contentHash && page.indexedRevision > 0) {
      // Only AI annotations or nothing original changed: keep existing fragments.
      this.store.run(`UPDATE pages SET indexStatus='indexed', indexedRevision=? WHERE id=? AND revision=?`, rev, pageId, rev);
      return;
    }
    if (!this.ai.configured) return this.store.setIndex(pageId, 'failed', 'AI is not configured, so notes cannot be shared yet.');
    this.store.setIndex(pageId, 'indexing');
    try {
      const png = await renderPage(page, this.store, this.dataDir, { width: 1280 });
      const owner = page.notebookStudentId;
      const fixedSlide = page.kind === 'slide' && page.slideId ? this.store.slide(page.slideId) : null;
      const confirmedSlide = !fixedSlide && page.link.confirmed && page.link.slideId ? this.store.slide(page.link.slideId) : null;
      const anchor = fixedSlide ?? confirmedSlide;
      const lectures = this.store.lectures(page.courseId);
      let context: string;
      if (anchor) {
        const lec = lectures.find((l) => l.id === anchor.lectureId)!;
        context = `This page is anchored to Lecture ${lec.number} "${lec.title}", slide ${anchor.page}. Return link {lectureNumber:${lec.number}, slide:${anchor.page}, confidence:1}.
Official slide content (do NOT extract this as student knowledge):
${anchor.digest ? `${anchor.digest.title}\n${anchor.digest.summary}\n${anchor.digest.formulas.join('\n')}` : anchor.text.slice(0, 2500)}`;
      } else {
        const outline = this.store.outline(page.courseId);
        context = `Decide which lecture slide this page of notes is about. Course outline (lecture.slide: title):
${outline.map((o) => `L${o.lectureNumber}.${o.page}: ${o.title.slice(0, 80)}`).join('\n')}
Set "link" to the main lecture/slide of the page. Pages often cover several slides: for EACH fragment also set its own lectureNumber, slide and linkConfidence (how sure you are that this fragment is about that slide). Use nulls and low confidence when unsure.`;
      }
      const out = await this.ai.json(
        `The image is one page from a student's notebook in a university course. ${page.kind === 'slide' ? 'The page background is the official lecture slide; the student wrote/typed on top of it.' : page.kind === 'pdf' ? 'This page is from the student\'s own imported notebook; it may contain pasted slide screenshots and handwriting.' : 'This is a blank notebook page with student notes.'}
${context}

Extract the course knowledge THIS STUDENT recorded that could help a classmate who missed it: explanations, intermediate derivation steps, worked examples, intuitions, things the lecturer said aloud, and open questions. Skip anything that just repeats what the official slide already says (classmates have the slide), text inside pasted slide screenshots, decorations and doodles.
Write each fragment as the knowledge itself, the way a classmate would want to read it. Do NOT describe the student ("the student wrote", "student's own definition", "as recorded").
For each fragment: transcribe faithfully (math as LaTeX, mark unreadable symbols [?]), make it self-contained, give a topic, a confidence (lower if handwriting or math is uncertain), and a bbox [x,y,w,h] normalized to the page (0..1) around the handwriting it came from. Return an empty list when there is nothing new.`,
        Indexed,
        [{ png }],
      );
      const slideCache = new Map<string, ReturnType<Store['slides']>>();
      const resolve = (lectureNumber: number | null | undefined, slideNo: number | null | undefined) => {
        const lec = lectureNumber != null ? lectures.find((l) => l.number === lectureNumber) : undefined;
        if (!lec) return { lectureId: null as string | null, slideId: null as string | null };
        if (!slideCache.has(lec.id)) slideCache.set(lec.id, this.store.slides(lec.id));
        const sl = slideNo != null ? slideCache.get(lec.id)!.find((x) => x.page === slideNo) : undefined;
        return { lectureId: lec.id, slideId: sl?.id ?? null };
      };
      const pageLink = anchor ? { lectureId: anchor.lectureId, slideId: anchor.id } : resolve(out.link.lectureNumber, out.link.slide);
      const pageConf = anchor ? 1 : pageLink.lectureId ? out.link.confidence : 0;
      if (!anchor) this.store.setLink(pageId, { ...pageLink, confidence: pageConf, confirmed: false });
      this.store.replaceFragments(
        pageId,
        rev,
        contentHash,
        out.fragments.map((f) => {
          // Anchored pages (slides or user-confirmed links) pin every fragment; otherwise each fragment carries its own link.
          const own = anchor ? null : f.lectureNumber != null ? resolve(f.lectureNumber, f.slide) : null;
          const link = own?.lectureId ? own : pageLink;
          const linkConf = anchor ? 1 : own?.lectureId ? (f.linkConfidence ?? pageConf) : pageConf;
          const slide = link.slideId ? (link.slideId === anchor?.id ? anchor : this.store.slide(link.slideId)) : null;
          const reason: PrivateReason | null =
            f.confidence < SHARE_THRESHOLD
              ? 'unclear'
              : !link.lectureId || linkConf < SHARE_THRESHOLD
                ? 'unlinked'
                : slide && restatesSlide(f.text, slide.text)
                  ? 'on_slide'
                  : null;
          return {
            studentId: owner,
            courseId: page.courseId,
            lectureId: link.lectureId,
            slideId: link.slideId,
            kind: f.kind,
            text: f.text,
            topic: f.topic,
            confidence: f.confidence,
            bbox: f.bbox as [number, number, number, number],
            shared: !reason,
            reason,
          };
        }),
      );
    } catch (e) {
      this.store.setIndex(pageId, 'failed', e instanceof AppError ? e.message : 'Indexing failed. It will retry on the next edit.');
    }
  }
}

export type { SlideDigest };
