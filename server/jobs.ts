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
  // Gaps are only asked for on pages that are anchored to one slide.
  gaps: z
    .array(
      z.object({
        bbox: z.array(z.number().min(0).max(1)).length(4),
        missing: z.string().min(1).max(600),
        entryIds: z.array(z.string()).max(6).default([]),
      }),
    )
    .max(5)
    .optional(),
});

/** What the merge job returns for one slide: how the notes group into points of knowledge. */
const Merged = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().max(64).nullable().optional(),
        title: z.string().min(1).max(140),
        summary: z.string().min(1).max(4000),
        fragmentIds: z.array(z.string()).min(1).max(40),
        contradicts: z.string().max(64).nullable().optional(),
        disputeExplanation: z.string().max(600).nullable().optional(),
      }),
    )
    .max(40),
});

const Topics = z.object({
  topics: z.array(z.object({ name: z.string().min(1).max(80), slidePages: z.array(z.number().int()).min(1).max(200) })).min(1).max(15),
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
  private mergePool = new Pool(2);
  private timers = new Map<string, NodeJS.Timeout>();
  private pendingIndex = new Set<string>();
  private merging = new Set<string>();
  /** Pages whose gaps are stale: re-read them even though the ink has not changed. */
  private regap = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  constructor(
    private store: Store,
    private ai: ModelGateway,
    private dataDir: string,
    public opts: { indexDelayMs: number; background: boolean } = { indexDelayMs: 6000, background: true },
  ) {}

  resume() {
    if (!this.opts.background) return;
    for (const course of this.store.courses())
      for (const l of this.store.lectures(course.id)) {
        if (l.status === 'digesting' || (l.status === 'ready' && l.digested < l.pageCount)) this.digestLecture(l.id);
        // Lectures digested before topics existed get them once, on the next start.
        else if (l.status === 'ready' && l.digested >= l.pageCount) this.topicsForLecture(l.id);
      }
    for (const pid of this.store.queuedPages()) this.scheduleIndex(pid, 0);
    // Notes left dirty by a client that never closed cleanly must not be stranded.
    this.startSweep();
  }

  /** Every 10 minutes, merge slides whose notes changed. The close signal only makes it prompt. */
  private startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.runSweep(), 10 * 60 * 1000);
    this.sweepTimer.unref?.();
    setTimeout(() => this.runSweep(), 30_000).unref?.();
  }
  runSweep() {
    if (!this.opts.background || !this.ai.configured) return;
    for (const s of this.store.dirtySlides()) this.mergeSlide(s.slideId);
  }

  /**
   * The student left this notebook: merge the slides its pages are linked to. Closing is the moment
   * notes are uploaded, so a half-written page is not judged until then. Unchanged slides cost nothing.
   */
  markNotebookDirty(notebookId: string) {
    if (!this.ai.configured) return 0;
    const slides = new Set(
      this.store
        .pages(notebookId)
        .map((p) => p.slideId ?? p.link.slideId)
        .filter((s): s is string => Boolean(s)),
    );
    for (const slideId of slides) this.mergeSlide(slideId, { force: true });
    return slides.size;
  }

  get idle() {
    return this.digestPool.idle && this.indexPool.idle && this.mergePool.idle && this.timers.size === 0;
  }

  // ---------------- slide digests
  digestLecture(lectureId: string) {
    if (!this.ai.configured) {
      this.store.setLecture(lectureId, { status: 'ready', error: 'AI not configured: slide digests skipped; slide text is used instead.' });
      return;
    }
    const lecture = this.store.lecture(lectureId);
    const todo = this.store.slides(lectureId).filter((s) => !s.digest);
    if (!todo.length) {
      this.store.setLecture(lectureId, { status: 'ready', error: null });
      return this.topicsForLecture(lectureId);
    }
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
          if (--remaining === 0) {
            this.store.setLecture(lectureId, { status: failed ? 'failed' : 'ready', ...(failed ? {} : { error: null }) });
            if (!failed) this.topicsForLecture(lectureId);
          }
        }
      });
    }
  }

  // ---------------- merge and check: notes → knowledge entries, per slide
  /**
   * Turns one slide's notes into entries: groups that make the same point, an AI summary per group,
   * a verbatim summary for single sources, and disputed entries kept out of everyone's view.
   * Skipped when the slide's notes have not changed since the last run.
   */
  mergeSlide(slideId: string, opts: { force?: boolean } = {}) {
    // Explicit merges (a notebook closing, a report) run even when background work is off;
    // `background` only governs the sweeps that run without being asked.
    if ((!this.opts.background && !opts.force) || !this.ai.configured) return;
    if (this.merging.has(slideId)) return;
    const frags = this.store.slideFragments(slideId);
    const hashNow = hash(frags.map((f) => `${f.id}:${f.text}`).join('|'));
    if (this.store.slideMergeHash(slideId) === hashNow) return;
    this.merging.add(slideId);
    this.mergePool.push(async () => {
      try {
        await this.runMerge(slideId, hashNow);
      } finally {
        this.merging.delete(slideId);
      }
    });
  }

  private async runMerge(slideId: string, sourceHash: string) {
    const slide = this.store.slide(slideId);
    if (!slide) return;
    const lecture = this.store.lecture(slide.lectureId);
    const frags = this.store.slideFragments(slideId);
    const existing = this.store.entries(slideId).filter((e) => !e.excludedReason);
    if (!frags.length) {
      // Every note on the slide went away: its entries go with them.
      for (const e of this.store.entries(slideId)) this.store.deleteEntry(e.id);
      this.store.markSlideMerged(slideId, sourceHash);
      return;
    }
    const digest = slide.digest;
    const slideText = digest ? `${digest.title}\n${digest.summary}\n${digest.formulas.join('\n')}` : slide.text.slice(0, 3000);
    const existingBlock = existing.length
      ? existing
          .map((e) => {
            const src = this.store.entrySources(e.id).map((s) => `{fragmentId:${s.id}, text:${JSON.stringify(s.text)}}`);
            return `id:${e.id} title:${JSON.stringify(e.title)} summary:${JSON.stringify(e.summary)} sources:[${src.join(',')}]`;
          })
          .join('\n')
      : '(none yet)';
    const fresh = frags.map((f) => ({ id: f.id, kind: f.kind, text: f.text, topic: f.topic, confidence: f.confidence }));
    const out = await this.ai.json(
      `SLIDE: Lecture ${lecture.number} "${lecture.title}", slide ${slide.page}\n${slideText}

EXISTING ENTRIES:
${existingBlock}

NEW OR CHANGED FRAGMENTS:
${JSON.stringify(fresh)}

TASK:
1. Group fragments that make the same point, even if worded differently.
2. For each group write a title (5-8 words) and a summary (2-4 sentences, LaTeX for math) that keeps the original meaning completely. Never add details no source states.
3. Assign every fragment to an entry, reusing existing ids when the point is unchanged.
4. Mark whichever applies: complements <entryId>, contradicts <entryId>, contradicts "slide".
5. A group with one source uses that source's text verbatim as the summary.
6. When a fragment contradicts the official slide, give a one-sentence explanation of the mismatch in disputeExplanation.`,
      Merged,
    );
    const byId = new Map(frags.map((f) => [f.id, f]));
    const keep = new Set<string>();
    for (const e of out.entries) {
      const ids = e.fragmentIds.filter((fid) => byId.has(fid));
      if (!ids.length) continue;
      const disputed = e.contradicts === 'slide';
      const summary = ids.length === 1 ? byId.get(ids[0]!)!.text : e.summary;
      const entryId = this.store.upsertEntry({
        id: e.id ?? null,
        courseId: lecture.courseId,
        lectureId: lecture.id,
        slideId,
        title: e.title,
        summary,
        excludedReason: disputed ? 'disputed' : null,
        disputeExplanation: disputed ? (e.disputeExplanation ?? 'This note contradicts the official slide.') : null,
      });
      keep.add(entryId);
      this.store.setEntrySources(entryId, ids);
    }
    // Entries whose notes were all regrouped elsewhere must not linger.
    for (const e of this.store.entries(slideId)) if (!keep.has(e.id)) this.store.deleteEntry(e.id);
    this.store.markSlideMerged(slideId, sourceHash);
  }

  /** Rechecks one entry after a "Looks wrong" report, outside the merge schedule. */
  recheckEntry(entryId: string) {
    if (!this.ai.configured) return;
    this.mergePool.push(async () => {
      const entry = this.store.entry(entryId);
      if (!entry) return;
      const slide = this.store.slide(entry.slideId);
      const sources = this.store.entrySources(entryId);
      if (!slide) return;
      const digest = slide.digest;
      const out = await this.ai.json(
        `SLIDE: ${digest ? `${digest.title}\n${digest.summary}` : slide.text.slice(0, 2500)}

ENTRY: ${JSON.stringify(entry.title)}: ${JSON.stringify(entry.summary)}
SOURCES: [${sources.map((s) => JSON.stringify(s.text)).join(', ')}]

TASK: does this entry reflect the slide and its sources? If it rests on a misread note or contradicts the slide, return the mismatch in one sentence.`,
        z.object({ disputed: z.boolean(), explanation: z.string().max(600).nullable().default(null) }),
      );
      this.store.setEntryDispute(entryId, out.disputed, out.explanation);
    });
  }

  // ---------------- lecture topics, once per lecture after its slides are digested
  topicsForLecture(lectureId: string) {
    if (!this.opts.background || !this.ai.configured) return;
    if (this.store.hasTopics(lectureId)) return;
    const lecture = this.store.lecture(lectureId);
    const slides = this.store.slides(lectureId).filter((s) => s.digest);
    if (slides.length < 2) return;
    this.digestPool.push(async () => {
      const out = await this.ai.json(
        `LECTURE: ${lecture.number} "${lecture.title}"
SLIDES: ${JSON.stringify(slides.map((s) => ({ page: s.page, title: s.digest!.title, topics: s.digest!.topics })))}

TASK: Name 5-15 topics that cover this lecture, each spanning one or more slides.`,
        Topics,
      );
      const byPage = new Map(slides.map((s) => [s.page, s.id]));
      const topics = out.topics
        .map((t) => ({ name: t.name, slideIds: t.slidePages.map((p) => byPage.get(p)).filter((x): x is string => Boolean(x)) }))
        .filter((t) => t.slideIds.length);
      if (topics.length) this.store.setTopics(lectureId, lecture.courseId, topics);
    });
  }

  /**
   * Opening a page re-reads it once when a classmate's note changed the knowledge behind its gaps:
   * a gap that read "From slide 12" should become "From 2 classmates' notes" without waiting for
   * the student to write again. Cheap when unchanged — the entry hashes are compared, no model call.
   */
  refreshGapsOnOpen(pageId: string) {
    if (!this.opts.background || !this.ai.configured) return;
    if (!this.store.gapsOutdated(pageId)) return;
    this.store.markGapsChecked(pageId);
    this.regap.add(pageId);
    this.scheduleIndex(pageId, 0);
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
    // A page whose gaps went stale is re-read even though its ink is unchanged: the knowledge
    // behind the gaps moved, not the page.
    const regap = this.regap.delete(pageId);
    if (page.contentHash === contentHash && page.indexedRevision > 0 && !regap) {
      // Only AI annotations or nothing original changed: keep existing fragments.
      this.store.run(`UPDATE pages SET indexStatus='indexed', indexedRevision=? WHERE id=? AND revision=?`, rev, pageId, rev);
      return;
    }
    if (regap) this.store.setIndex(pageId, 'queued');
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
For each fragment: transcribe faithfully (math as LaTeX, mark unreadable symbols [?]), make it self-contained, give a topic, a confidence (lower if handwriting or math is uncertain), and a bbox [x,y,w,h] normalized to the page (0..1) around the handwriting it came from. Return an empty list when there is nothing new.${anchor ? '\n\nSEPARATE TASK — GAPS (always answer this, even when "fragments" is empty):\nFind 0-5 gaps in this student\'s notes for the current slide: a concept they missed, a step left unclear, a claim with no example. For each:\n- bbox: [x, y, w, h] normalized 0..1, around where the gap sits on the page\n- missing: one sentence naming what is missing\n- entryIds: ids of knowledge entries (E<n> below) that already fill this gap, if any' : ''}${anchor ? `\n\nKNOWLEDGE ENTRIES FOR THIS SLIDE:\n${this.store
          .entries(anchor.id)
          .filter((e) => !e.excludedReason)
          .map((e) => `[E${e.id}] ${e.title}: ${e.summary.replace(/\s+/g, ' ')}`)
          .join('\n') || '(none yet)'}` : ''}`,
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
      // A page's old fragments are replaced below; remember which note each one was so an edit can
      // point the superseded copy at its replacement (an old citation still opens, with a notice).
      const before = this.store.pageFragments(pageId);
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
      // Notes whose wording changed are superseded by the new note in the same position.
      const after = this.store.pageFragments(pageId);
      const kept = new Set(after.map((f) => f.text));
      before.forEach((old, i) => {
        if (kept.has(old.text)) return;
        const next = after[i];
        if (next && !before.some((b) => b.text === next.text)) this.store.supersedeFragment(old.id, next.id);
      });
      // Gaps belong to the version of the page that was read; a new read replaces them.
      if (anchor) {
        const entryIds = new Set(this.store.entries(anchor.id).map((e) => e.id));
        this.store.replaceGaps(
          pageId,
          rev,
          (out.gaps ?? []).map((g) => ({
            bbox: g.bbox as [number, number, number, number],
            missing: g.missing,
            entryIds: g.entryIds.filter((e) => entryIds.has(e.replace(/^E/, ''))).map((e) => e.replace(/^E/, '')),
          })),
        );
      } else {
        this.store.replaceGaps(pageId, rev, []);
      }
      if (anchor) this.mergeSlide(anchor.id);
    } catch (e) {
      this.store.setIndex(pageId, 'failed', e instanceof AppError ? e.message : 'Indexing failed. It will retry on the next edit.');
    }
  }
}

export type { SlideDigest };
