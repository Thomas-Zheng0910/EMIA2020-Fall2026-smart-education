import { z } from 'zod';
import { Store, AppError, id } from './db';
import { ModelGateway, type Img } from './ai';
import { renderPage, cropPng } from './render';
import type { AskCard, Basis, Citation, Quiz, QuizResult, QuizScope } from '../shared/types';

type Ctx = { text: string; refs: Map<string, Citation> };

/** Puts the whole lecture (slide digests + visible classmate notes) into one prompt: no retrieval index needed. */
export function lectureContext(store: Store, lectureId: string, viewer: string, focusSlideId?: string | null): Ctx {
  const lec = store.lecture(lectureId);
  const refs = new Map<string, Citation>();
  const lines = [`LECTURE ${lec.number}: ${lec.title}`, '', 'OFFICIAL SLIDES (cite as S<page>):'];
  for (const s of store.slides(lectureId)) {
    const ref = `S${s.page}`;
    const title = s.digest?.title ?? s.text.split('\n')[0]?.slice(0, 80) ?? '';
    refs.set(ref, { kind: 'slide', slideId: s.id, lectureNumber: lec.number, page: s.page, label: `L${lec.number} · slide ${s.page}${title ? ` · ${title}` : ''}` });
    const body = s.digest ? `${s.digest.summary}${s.digest.formulas.length ? ' Formulas: ' + s.digest.formulas.join('; ') : ''}` : s.text.replace(/\s+/g, ' ').slice(0, 900);
    lines.push(`[${ref}]${s.id === focusSlideId ? ' (CURRENT SLIDE)' : ''} ${title}: ${body}`);
  }
  lines.push('', 'CLASSMATE NOTES (student-derived, unverified; cite as F<n>):');
  const frags = store.peerFragments(lectureId, viewer, { includeDismissed: true });
  frags.slice(0, 300).forEach((f, i) => {
    const ref = `F${i + 1}`;
    const slide = f.slideId ? store.slide(f.slideId) : null;
    refs.set(ref, { kind: 'fragment', fragmentId: f.id, author: f.authorName, label: `${f.authorName}'s note${slide ? ` · slide ${slide.page}` : ''}` });
    lines.push(`[${ref}] (${f.kind}, ${slide ? `slide ${slide.page}` : 'lecture'}, by ${f.authorName}) ${f.text.replace(/\s+/g, ' ')}`);
  });
  if (!frags.length) lines.push('(none yet)');
  return { text: lines.join('\n'), refs };
}

function cite(refs: Map<string, Citation>, raw: string[]) {
  const out: Citation[] = [];
  for (const r of raw) {
    const c = refs.get(r.trim().replace(/^\[|\]$/g, '').toUpperCase());
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function settleBasis(claimed: Basis, citations: Citation[]): Basis {
  const hasSlide = citations.some((c) => c.kind === 'slide');
  const hasPeer = citations.some((c) => c.kind === 'fragment');
  if (claimed === 'official' && hasSlide) return 'official';
  if (claimed === 'peer' && hasPeer) return 'peer';
  if (claimed === 'ai') return 'ai';
  return hasSlide ? 'official' : hasPeer ? 'peer' : 'ai';
}

async function pageImages(store: Store, dataDir: string, pageId: string, bbox?: [number, number, number, number] | null): Promise<Img[]> {
  const page = store.page(pageId);
  const png = await renderPage(page, store, dataDir, { width: 1280 });
  const imgs: Img[] = [{ label: "The student's current page:", png }];
  if (bbox) imgs.push({ label: 'The part the student selected (focus here):', png: await cropPng(png, bbox) });
  return imgs;
}

function resolveLecture(store: Store, pageId: string) {
  const page = store.page(pageId);
  const lectureId = page.link.lectureId ?? (page.slideId ? store.slide(page.slideId)?.lectureId : null);
  if (!lectureId) throw new AppError(409, 'This page is not linked to a lecture yet. Write a little, wait for it to be organized, or choose a lecture in the page chip.');
  return { page, lectureId, slideId: page.slideId ?? page.link.slideId };
}

const Ask = z.object({
  cards: z
    .array(
      z.object({
        title: z.string().max(140),
        body: z.string().max(5000),
        basis: z.enum(['official', 'peer', 'ai']),
        citations: z.array(z.string()).max(8),
        conflict: z.string().max(600).nullable().default(null),
      }),
    )
    .min(1)
    .max(4),
});

export async function ask(
  store: Store,
  ai: ModelGateway,
  dataDir: string,
  input: { studentId: string; pageId: string; bbox?: [number, number, number, number] | null; question?: string },
) {
  const { page, lectureId, slideId } = resolveLecture(store, input.pageId);
  const ctx = lectureContext(store, lectureId, input.studentId, slideId);
  const images = await pageImages(store, dataDir, input.pageId, input.bbox);
  const out = await ai.json(
    `${ctx.text}

TASK: The student is reviewing their notes (images below)${input.bbox ? ' and selected a specific part' : ''}.
${input.question ? `Their question: "${input.question.slice(0, 600)}"` : 'Find what is missing, unclear or incomplete in their notes for this part and fill the gap.'}
Return 1-3 cards that each fill one concrete gap (a missing step, the reason behind a claim, an example). Prefer content supported by the official slides and classmate notes above. Use separate cards for:
- basis "official": restates/explains what the cited slides teach.
- basis "peer": an explanation that comes from cited classmate notes (say so, it is unverified).
- basis "ai": your own interpretation not directly stated in any source (still cite the closest slide if any).
If a classmate note contradicts a slide or another note, describe it in "conflict". Keep each body short (under 120 words), in Markdown with LaTeX. Citations are the bracket refs like "S12" or "F3".`,
    Ask,
    images,
  );
  const cards: AskCard[] = out.cards.map((c) => {
    const citations = cite(ctx.refs, c.citations);
    return { id: id(), title: c.title, body: c.body, basis: settleBasis(c.basis, citations), citations, conflict: c.conflict || null };
  });
  const aid = id();
  store.saveAsk(aid, input.studentId, input.pageId, page.revision, cards);
  return { id: aid, pageId: input.pageId, pageRevision: page.revision, cards };
}

const QuizOut = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().max(800),
        options: z.array(z.string().max(400)).length(4),
        correctIndex: z.number().int().min(0).max(3),
        explanation: z.string().max(1500),
        citations: z.array(z.string()).min(1).max(6),
      }),
    )
    .min(1)
    .max(8),
});

export async function makeQuiz(
  store: Store,
  ai: ModelGateway,
  dataDir: string,
  input: { studentId: string; scope: QuizScope; bbox?: [number, number, number, number] | null },
): Promise<Quiz> {
  let lectureId = input.scope.lectureId;
  let slideId: string | null = null;
  let images: Img[] = [];
  if (input.scope.kind !== 'lecture') {
    if (!input.scope.pageId) throw new AppError(400, 'Choose a page for this quiz.');
    const r = resolveLecture(store, input.scope.pageId);
    lectureId = r.lectureId;
    slideId = r.slideId;
    images = await pageImages(store, dataDir, input.scope.pageId, input.scope.kind === 'selection' ? input.bbox : null);
  }
  const ctx = lectureContext(store, lectureId, input.studentId, slideId);
  const focus =
    input.scope.kind === 'lecture'
      ? 'Cover the most important ideas of the whole lecture.'
      : input.scope.kind === 'page'
        ? 'Focus on the CURRENT SLIDE and what is on the student page image.'
        : 'Focus on the selected part of the student page.';
  const out = await ai.json(
    `${ctx.text}

TASK: Write 4 multiple-choice questions to check understanding (not recall of wording). ${focus}
Rules: the correct answer MUST be supported by at least one OFFICIAL slide; cite it ("S<n>"). Classmate notes may inspire questions but never decide the answer. Distractors should reflect plausible misconceptions. Explanation: 1-3 sentences explaining why the answer is right and the common mistake. Use LaTeX for math.`,
    QuizOut,
    images,
  );
  const stored = out.questions
    .map((q) => ({ id: id(), question: q.question, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation, citations: cite(ctx.refs, q.citations) }))
    .filter((q) => q.citations.some((c) => c.kind === 'slide'));
  if (!stored.length) throw new AppError(502, 'The AI could not ground any question in the official slides. Please retry.');
  const qid = id();
  store.saveQuiz(qid, input.studentId, input.scope, stored);
  return { id: qid, scope: input.scope, questions: stored.map(({ correctIndex: _c, explanation: _e, ...q }) => q) };
}

export function gradeQuiz(store: Store, qid: string, studentId: string, answers: Record<string, number>): QuizResult {
  const quiz = store.quiz(qid);
  if (quiz.studentId !== studentId) throw new AppError(403, 'This quiz belongs to another student.');
  const results = quiz.questions.map((q) => ({
    questionId: q.id,
    correct: answers[q.id] === q.correctIndex,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
  }));
  return { score: results.filter((r) => r.correct).length, total: results.length, results };
}
