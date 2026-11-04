import { AppError, Store } from './db';
import { ModelGateway } from './ai';
import { cropPng, renderPage } from './render';
import { fillGap } from './study';
import type { Citation, OwnNote, PageSuggestions, Suggestion } from '../shared/types';

/**
 * Turns a page's stored gaps into the cards a student sees.
 *
 * Precedence is the spec's: a classmate's note (through a knowledge entry) first, then the official
 * slide, then the model's own explanation. Nothing is generated here — the card shows what is
 * already stored; a gap with neither a peer entry nor a slide is filled on demand by `expand`.
 */
export function pageSuggestions(store: Store, pageId: string, viewer: string): PageSuggestions {
  const page = store.page(pageId);
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
    if (entry) {
      const count = store.entrySourceCount(entry.id);
      const source = store.entrySources(entry.id).find((f) => f.studentId !== viewer) ?? null;
      cards.push({
        id: g.id,
        pageId,
        bbox: g.bbox,
        missing: g.missing,
        source: 'peer',
        sourceLine: count === 1 ? "From 1 classmate's note" : `From ${count} classmates' notes`,
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

  return { pageId, gaps: cards, own: ownNotes(store, pageId, slideId), unlinked: !slideId };
}

/** The author's view of their own page: shared, private (with the AI's reason), or disputed. */
function ownNotes(store: Store, pageId: string, slideId: string | null): OwnNote[] {
  const own = store.pageFragments(pageId);
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
