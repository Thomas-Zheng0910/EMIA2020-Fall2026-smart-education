import { AppError, Store } from './db';
import { ModelGateway } from './ai';
import { cropPng, renderPage } from './render';
import { fillGap } from './study';
import type { Citation, NotebookSuggestion, NotebookSuggestions, OwnNote, PageSuggestions, Suggestion } from '../shared/types';

/**
 * Turns a page's stored gaps into the cards a student sees.
 *
 * Precedence is the spec's: a classmate's note (through a knowledge entry) first, then the official
 * slide, then the model's own explanation. Nothing is generated here — the card shows what is
 * already stored; a gap with neither a peer entry nor a slide is filled on demand by `expand`.
 */
export function pageSuggestions(store: Store, pageId: string, viewer: string): PageSuggestions {
  const page = store.page(pageId);
  // A group note is a private shared workspace; AI suggestions stay in individual notes.
  if (page.notebookKind === 'group') return { pageId, gaps: [], own: [], unlinked: false };
  const slideId = page.slideId ?? page.link.slideId;
  const dismissed = store.dismissedGaps(viewer);
  const gaps = slideId ? store.gaps(pageId).filter((g) => !dismissed.has(g.id)) : [];
  const slide = slideId ? store.slide(slideId) : null;
  const lecture = slide ? store.lecture(slide.lectureId) : null;
  const entries = slideId ? store.entries(slideId).filter((e) => !e.excludedReason) : [];
  const slideRef: Citation | null =
    slide && lecture
      ? {
          kind: 'slide',
          slideId: slide.id,
          lectureNumber: lecture.number,
          page: slide.page,
          label: `L${lecture.number} · slide ${slide.page}${slide.digest?.title ? ` · ${slide.digest.title}` : ''}`,
        }
      : null;

  const cards: Suggestion[] = [];
  for (const g of gaps) {
    const entry = entries.find((e) => g.entryIds.includes(e.id)) ?? null;
    const sourceFragments = entry ? store.entrySources(entry.id).filter((f) => f.studentId !== viewer) : [];
    // Count distinct classmates, not notes: one classmate's two notes are still one source.
    const count = new Set(sourceFragments.map((f) => f.studentId)).size;
    if (entry && count > 0) {
      const source = sourceFragments[0] ?? null;
      cards.push({
        id: g.id,
        pageId,
        bbox: g.bbox,
        missing: g.missing,
        source: 'peer',
        sourceLine: count <= 0 ? 'From a classmate’s note' : count === 1 ? "From 1 classmate's note" : `From ${count} classmates' notes`,
        title: entry.title,
        body: entry.summary,
        citations: [
          { kind: 'entry', entryId: entry.id, slideId: entry.slideId, lectureNumber: lecture?.number ?? 0, page: slide?.page ?? 0, label: `slide ${slide?.page ?? ''} · classmates' notes` },
          ...(slideRef ? [slideRef] : []),
        ],
        entryId: entry.id,
        fragmentId: count === 1 && source ? source.id : null,
      });
      continue;
    }
    // No classmate entry covers it: the slide itself may, and the body comes from its digest.
    if (slide && slideRef) {
      const body = slide.digest
        ? `${slide.digest.summary}${slide.digest.formulas.length ? `\n\n${slide.digest.formulas.map((f) => `$$${f}$$`).join('\n\n')}` : ''}`
        : slide.text.replace(/\s+/g, ' ').slice(0, 600);
      cards.push({
        id: g.id,
        pageId,
        bbox: g.bbox,
        missing: g.missing,
        source: 'slide',
        sourceLine: `From slide ${slide.page}`,
        title: slide.digest?.title ?? `Slide ${slide.page}`,
        body,
        citations: [slideRef],
        entryId: null,
        fragmentId: null,
      });
      continue;
    }
    // Neither: the card is a promise to explain, filled by `expandGap` when tapped.
    cards.push({
      id: g.id,
      pageId,
      bbox: g.bbox,
      missing: g.missing,
      source: 'ai',
      sourceLine: 'AI explanation',
      title: 'Not covered by your notes or the slides',
      body: '',
      citations: [],
      entryId: null,
      fragmentId: null,
    });
  }

  return { pageId, gaps: cards, own: ownNotes(store, pageId, slideId, viewer), unlinked: !slideId };
}

/**
 * Every suggestion in a notebook, grouped by page in the notebook's own order.
 *
 * A student should not have to scroll a 99-slide deck to find out what is waiting for them. This
 * reads each page the same way the inline ghost does — same precedence, same dismissals — so the
 * browser and the page can never disagree. No model calls: it only formats what is already stored.
 */
export function notebookSuggestions(store: Store, notebookId: string, viewer: string): NotebookSuggestions {
  const pages = store.pages(notebookId);
  const dismissed = store.dismissedGaps(viewer);
  const groups: NotebookSuggestions['groups'] = [];
  let total = 0;
  pages.forEach((page, i) => {
    // Cheap check first: a page with no gaps at all costs nothing here.
    if (!store.gaps(page.id).some((g) => !dismissed.has(g.id))) return;
    // The author's own answered gaps are settled: a note on the page is the record, as inline.
    const answered = new Set(page.items.filter((it) => it.type === 'annotation' && it.gapId).map((it) => (it as { gapId?: string }).gapId));
    const { gaps } = pageSuggestions(store, page.id, viewer);
    const label = page.kind === 'slide' ? `Slide ${page.position}` : `Page ${i + 1}`;
    const items: NotebookSuggestion[] = gaps
      .filter((g) => !answered.has(g.id))
      .map((g) => ({ ...g, pageNumber: i + 1, pageLabel: label, thumb: `/api/pages/${page.id}/render.png?w=240` }));
    if (!items.length) return;
    total += items.length;
    groups.push({ pageId: page.id, pageNumber: i + 1, pageLabel: label, thumb: `/api/pages/${page.id}/render.png?w=240`, items });
  });
  return { notebookId, groups, total };
}

/** The author's view of their own page: shared, private (with the AI's reason), or disputed. */
function ownNotes(store: Store, pageId: string, slideId: string | null, viewer: string): OwnNote[] {
  // The author's private transcription and AI feedback stay with the author, even when the page
  // is now a group note.
  const own = store.pageFragments(pageId).filter((f) => f.studentId === viewer);
  const entries = new Map((slideId ? store.entries(slideId) : []).map((e) => [e.id, e]));
  return own.map((f) => {
    const entry = f.entryId ? entries.get(f.entryId) : null;
    if (entry?.excludedReason === 'disputed') {
      return {
        id: f.id,
        text: f.text,
        state: 'disputed' as const,
        sourceLine: 'Checked against the slide',
        disputeExplanation: entry.disputeExplanation,
      };
    }
    if (!f.shared) return { id: f.id, text: f.text, state: 'private' as const, sourceLine: reasonLine(f.reason), disputeExplanation: null };
    return { id: f.id, text: f.text, state: 'shared' as const, sourceLine: 'Shared with your classmates', disputeExplanation: null };
  });
}

function reasonLine(reason: string | null) {
  switch (reason) {
    case 'unclear':
      return 'Not shared · handwriting was hard to read';
    case 'unlinked':
      return 'Not shared · could not tell which lecture it belongs to';
    case 'on_slide':
      return 'Not shared · already on the slide';
    default:
      return 'Not shared';
  }
}

/** A crop of the classmate handwriting behind a single-source entry, for "see the original". */
export async function gapCrop(store: Store, dataDir: string, fragmentId: string) {
  const f = store.fragment(fragmentId);
  if (!f) throw new AppError(404, 'Note not found.');
  const page = store.page(f.pageId);
  return cropPng(await renderPage(page, store, dataDir, { width: 1400 }), f.bbox);
}

/** Fills one gap on demand, for a card that has no peer entry and no slide text. */
export async function expandGap(
  store: Store,
  ai: ModelGateway,
  dataDir: string,
  input: { studentId: string; pageId: string; gapId: string },
) {
  const gap = store.gaps(input.pageId).find((g) => g.id === input.gapId);
  if (!gap) throw new AppError(404, 'That suggestion no longer applies to this page.');
  const filled = await fillGap(store, ai, dataDir, { studentId: input.studentId, pageId: input.pageId, missing: gap.missing, bbox: gap.bbox });
  return { id: gap.id, ...filled };
}
