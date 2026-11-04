import { describe, it, expect } from 'vitest';
import { setup, upload, waitFor } from './helpers';

/** Counts page reads so a later read can report different wording for the same note. */
let indexCalls = 0;
const handler = (prompt: string) => {
  if (prompt.includes('study digest'))
    return { slides: [...prompt.matchAll(/--- Slide (\d+)/g)].map((m) => ({ page: Number(m[1]), title: `Title ${m[1]}`, summary: `Summary of slide ${m[1]}`, formulas: [], topics: ['bayes'] })) };
  if (prompt.includes('Extract the course knowledge')) {
    // A gap the notes leave. When the slide already has entries, the gap points at the first one,
    // which is what makes the card a classmate's note rather than a slide card.
    const known = /\[E([\w-]+)\]/.exec(prompt)?.[1];
    indexCalls++;
    return {
      link: { lectureNumber: 3, slide: 2, confidence: 0.9 },
      fragments: [
        // Rewording on a later read is what supersedes the earlier note.
        {
          kind: 'explanation',
          text: indexCalls === 1 ? 'Posterior is prior times likelihood, normalized by $P(B)$.' : 'Posterior: prior × likelihood ÷ evidence.',
          topic: 'Bayes rule',
          confidence: 0.92,
          bbox: [0.1, 0.1, 0.5, 0.2],
        },
        { kind: 'other', text: 'blurry scribble', topic: '?', confidence: 0.3, bbox: [0.1, 0.5, 0.2, 0.1] },
      ],
      gaps: [{ bbox: [0.2, 0.4, 0.4, 0.2], missing: 'Why divide by the evidence?', entryIds: known ? [known] : [] }],
    };
  }
  // The merge job: group notes into knowledge entries. One group of two notes, verbatim elsewhere.
  if (prompt.includes('Group fragments that make the same point')) {
    const frags = [...prompt.matchAll(/\{fragmentId:(f[^,]+), text:"([^"]*)"/g)].map((m) => ({ id: m[1], text: m[2] }));
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return {
      entries: [
        {
          id: null,
          title: 'Normalize by the evidence',
          summary: 'The posterior is the prior times the likelihood, divided by $P(B)$ so the probabilities sum to one.',
          fragmentIds: ids.length ? ids : frags.map((f) => f.id),
          contradicts: null,
          disputeExplanation: null,
        },
      ],
    };
  }
  if (prompt.includes('Name 5-15 topics'))
    return { topics: [{ name: 'Bayes rule', slidePages: [1, 2] }, { name: 'Naive assumption', slidePages: [3] }] };
  if (prompt.includes('fill this gap in 2-4 sentences'))
    return { title: 'Why divide by $P(B)$', body: 'To normalize the posterior so it sums to one.', citations: ['S2'] };
  if (prompt.includes('does this entry reflect the slide'))
    return { disputed: true, explanation: 'The note says the opposite of the slide.' };
  if (prompt.includes('TASK: The student is reviewing')) {
    const entry = /\[E([\w-]+)\]/.exec(prompt)?.[1];
    return {
      cards: [
        { title: 'Missing normalization', body: 'Divide by $P(B)$.', basis: 'peer', citations: [entry ? `E${entry}` : 'E-nope', 'S99'], conflict: null },
        { title: 'Claimed official without source', body: 'x', basis: 'official', citations: ['X1'], conflict: null },
      ],
    };
  }
  if (prompt.includes('multiple-choice'))
    return {
      questions: [
        { question: 'Q1', options: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: 'because', citations: ['S1'] },
        { question: 'Peer-only', options: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'x', citations: ['F1'] },
      ],
    };
  return '{}';
};

async function seeded() {
  indexCalls = 0; // each test starts from a first reading of the page
  const t = await setup(handler);
  const { readFileSync } = await import('node:fs');
  const res = await upload(t.app, '/api/lectures', readFileSync(t.pdf), '3-naive-bayes-full.pdf');
  expect(res.statusCode).toBe(200);
  const lecture = res.json();
  expect(lecture.number).toBe(3);
  await waitFor(() => t.jobs.idle);
  const as = (s: string, course = 'comp2211') => ({ 'x-student-id': s, 'x-course-id': course });
  const open = async (s: string) => {
    const { id } = (await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${lecture.id}`, headers: as(s) })).json();
    return (await t.app.inject({ url: `/api/notebooks/${id}`, headers: as(s) })).json();
  };
  return { ...t, lecture, as, open };
}
const ink = [{ id: 's1', tool: 'pen', color: '#000', size: 4, points: [100, 100, 0.5, 200, 150, 0.5, 300, 120, 0.5] }];
/** The one note on a page that got shared; the rest are private for a stated reason. */
const sharedFragmentId = (t: { store: { pageFragments: (id: string) => { id: string; shared: boolean }[] } }, pageId: string) =>
  t.store.pageFragments(pageId).find((f) => f.shared)!.id;
/**
 * Reads a page (indexing is what finds gaps) and returns the suggestions the student would see.
 * A gap with no entry behind it is what the reader's own note left open.
 */
async function readPage(t: any, as: Record<string, string>, page: any, strokes: unknown[], entryId?: string) {
  const rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: as, payload: { revision: page.revision, strokes, items: [] } })).json().revision;
  await t.jobs.indexPage(page.id);
  if (entryId) t.store.replaceGaps(page.id, rev, [{ bbox: [0.2, 0.4, 0.4, 0.2], missing: 'Why divide by the evidence?', entryIds: [entryId] }]);
  return (await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: as })).json();
}

describe('course notebook API', () => {
  it('imports a lecture, renders slides and digests them with images', async () => {
    const t = await seeded();
    const slides = (await t.app.inject(`/api/lectures/${t.lecture.id}/slides`)).json();
    expect(slides).toHaveLength(3);
    expect(slides[1].text).toContain('Conditional probability');
    expect(slides[0].digest.title).toBe('Title 1');
    expect(t.calls.find((c) => c.prompt.includes('study digest'))!.images).toBe(3);
  });

  it('saves with revision checks, indexes notes and shares only confident fragments with classmates', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    expect(page.kind).toBe('slide');
    const save = await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } });
    expect(save.json().revision).toBe(page.revision + 1);
    const stale = await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: [], items: [] } });
    expect(stale.statusCode).toBe(409);
    // another student cannot touch Alex's page
    expect((await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('thomas') })).statusCode).toBe(403);

    await t.jobs.indexPage(page.id);
    const shared = (await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json();
    expect(shared).toHaveLength(2);
    expect(shared.filter((f: any) => f.shared)).toHaveLength(1);
    const indexCall = t.calls.find((c) => c.prompt.includes('Extract the course knowledge'))!;
    expect(indexCall.images).toBe(1);
    expect(indexCall.prompt).toContain('Summary of slide 2');

    // Closing the notebook is what uploads the notes for classmates; it merges the page's slide.
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.notebook.id}/close`, headers: t.as('alex') });
    await waitFor(() => t.jobs.idle);
    const slideId = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('alex') })).json().link.slideId;
    const entry = t.store.entries(slideId)[0]!;

    const thomas = await t.open('thomas');
    expect(thomas.pages[1].peerCount).toBe(1);
    expect(thomas.pages[0].peerCount).toBe(0);
    // Thomas reads his own page on the same slide and sees Alex's point offered at his gap.
    const sugg = await readPage(t, t.as('thomas'), thomas.pages[1], ink, entry.id);
    expect(sugg.gaps).toHaveLength(1);
    expect(sugg.gaps[0]).toMatchObject({ source: 'peer', sourceLine: "From 1 classmate's note", title: 'Normalize by the evidence' });
    // A single-source entry shows the note verbatim (no AI rewrite) and can show the handwriting.
    expect(sugg.gaps[0].body).toContain('Posterior is prior times likelihood');
    expect(sugg.gaps[0].fragmentId).toBeTruthy();
    const crop = await t.app.inject({ url: `/api/fragments/${sugg.gaps[0].fragmentId}/crop.png`, headers: t.as('thomas') });
    expect(crop.headers['content-type']).toContain('image/png');
    // the private low-confidence fragment is not readable by classmates
    const priv = shared.find((f: any) => !f.shared);
    expect((await t.app.inject({ url: `/api/fragments/${priv.id}`, headers: t.as('thomas') })).statusCode).toBe(404);
    // the author sees their own notes listed, not as a classmate suggestion
    const ownView = (await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: t.as('alex') })).json();
    expect(ownView.own.find((o: any) => o.state === 'shared')).toBeTruthy();
    expect(ownView.own.find((o: any) => o.state === 'private')!.sourceLine).toContain('hard to read');
    // dismiss hides that gap for Thomas only
    await t.app.inject({ method: 'POST', url: `/api/pages/${thomas.pages[1].id}/suggestions/${sugg.gaps[0].id}/dismiss`, headers: t.as('thomas') });
    expect((await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/suggestions`, headers: t.as('thomas') })).json().gaps).toHaveLength(0);
    expect((await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: t.as('alex') })).json().own.length).toBeGreaterThan(0);
  });

  it('does not re-index or republish when only AI annotations change', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    let rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    const before = t.calls.length;
    const annotation = { id: 'a1', type: 'annotation', x: 600, y: 10, w: 300, title: 'AI', body: 'generated text', basis: 'ai', citations: [] };
    rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: rev, strokes: ink, items: [annotation] } })).json().revision;
    await t.jobs.indexPage(page.id);
    expect(t.calls.length).toBe(before);
    const status = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('alex') })).json();
    expect(status.indexStatus).toBe('indexed');
  });

  it('a stale indexing result never overwrites a newer revision', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    const rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    const p = t.jobs.indexPage(page.id);
    await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: rev, strokes: [], items: [] } });
    await p;
    expect((await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json()).toHaveLength(0);
  });

  it('explains with validated citations and honest source labels', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    await t.app.inject({ method: 'PUT', url: `/api/pages/${alex.pages[1].id}`, headers: t.as('alex'), payload: { revision: alex.pages[1].revision, strokes: ink, items: [] } });
    await t.jobs.indexPage(alex.pages[1].id);
    // Merging first is what puts Alex's note in the knowledge base the prompt is built from.
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.notebook.id}/close`, headers: t.as('alex') });
    await waitFor(() => t.jobs.idle);
    const thomas = await t.open('thomas');
    const res = await t.app.inject({ method: 'POST', url: '/api/ask', headers: t.as('thomas'), payload: { pageId: thomas.pages[1].id, bbox: [0.1, 0.1, 0.3, 0.3], question: 'why divide?' } });
    expect(res.statusCode).toBe(200);
    const { cards } = res.json();
    expect(cards[0].source).toBe('peer');
    expect(cards[0].citations).toEqual([expect.objectContaining({ kind: 'entry' })]); // S99 dropped
    expect(cards[1].source).toBe('ai'); // no valid citation at all, so it is the model's own words
    const call = t.calls.at(-1)!;
    expect(call.images).toBe(2); // page + selection crop
    expect(call.prompt).toContain('why divide?');
    expect(call.prompt).toContain('COURSE KNOWLEDGE BASE');
    expect(call.prompt).toContain('Posterior is prior times likelihood');
  });

  it('quizzes only on slide-grounded questions and grades without leaking answers', async () => {
    const t = await seeded();
    const res = await t.app.inject({ method: 'POST', url: '/api/quizzes', headers: t.as('thomas'), payload: { scope: { kind: 'lecture', lectureId: t.lecture.id } } });
    const quiz = res.json();
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].correctIndex).toBeUndefined();
    const graded = (await t.app.inject({ method: 'POST', url: `/api/quizzes/${quiz.id}/grade`, headers: t.as('thomas'), payload: { answers: { [quiz.questions[0].id]: 2 } } })).json();
    expect(graded.score).toBe(1);
    expect((await t.app.inject({ method: 'POST', url: `/api/quizzes/${quiz.id}/grade`, headers: t.as('alex'), payload: { answers: {} } })).statusCode).toBe(403);
  });

  it('links free notebook pages automatically and lets the student confirm', async () => {
    const t = await seeded();
    const nb = (await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: t.as('priya'), payload: { title: 'Revision', paper: 'ruled' } })).json();
    const data = (await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya') })).json();
    const page = data.pages[0];
    await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('priya'), payload: { revision: 1, strokes: ink, items: [] } });
    await t.jobs.indexPage(page.id);
    const st = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('priya') })).json();
    expect(st.link).toMatchObject({ lectureId: t.lecture.id, confirmed: false, slidePage: 2 });
    expect(t.calls.at(-1)!.prompt).toContain('L3.2: Title 2');
    const conf = (await t.app.inject({ method: 'POST', url: `/api/pages/${page.id}/link`, headers: t.as('priya'), payload: { lectureId: st.link.lectureId, slideId: null } })).json();
    expect(conf.link.confirmed).toBe(true);
  });

  it('fails clearly when AI is not configured', async () => {
    const t = await setup(null);
    const { readFileSync } = await import('node:fs');
    const lecture = (await upload(t.app, '/api/lectures', readFileSync(t.pdf), '3-bayes.pdf')).json();
    const res = await t.app.inject({ method: 'POST', url: '/api/quizzes', payload: { scope: { kind: 'lecture', lectureId: lecture.id } } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/LLM_API_KEY/);
  });

  it('keeps courses separate: enrollment, course switching and no cross-course leaks', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    await t.app.inject({ method: 'PUT', url: `/api/pages/${alex.pages[1].id}`, headers: t.as('alex'), payload: { revision: alex.pages[1].revision, strokes: ink, items: [] } });
    await t.jobs.indexPage(alex.pages[1].id);
    const frag = (await t.app.inject({ url: `/api/pages/${alex.pages[1].id}/shared`, headers: t.as('alex') })).json().find((f: any) => f.shared);

    // Thomas creates a second course: he is enrolled, it is empty, and Priya can see it to join.
    const created = await t.app.inject({ method: 'POST', url: '/api/courses', headers: t.as('thomas'), payload: { code: 'comp3311', name: 'Databases' } });
    expect(created.json()).toMatchObject({ id: 'comp3311', code: 'COMP3311' });
    expect((await t.app.inject({ method: 'POST', url: '/api/courses', headers: t.as('thomas'), payload: { code: 'COMP3311', name: 'Dup' } })).statusCode).toBe(409);
    const boot = (await t.app.inject({ url: '/api/bootstrap', headers: t.as('thomas', 'comp3311') })).json();
    expect(boot.enrolled).toEqual(['comp2211', 'comp3311']);
    expect(boot.course.id).toBe('comp3311');
    expect(boot.lectures).toEqual([]);
    expect((await t.app.inject({ url: '/api/notebooks', headers: t.as('thomas', 'comp3311') })).json()).toEqual([]);
    expect((await t.app.inject({ url: '/api/notebooks', headers: t.as('thomas') })).json()).toHaveLength(0);

    // Priya leaves COMP2211: its lectures, slides and classmates' notes are closed to her; bootstrap falls back.
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: t.as('priya') });
    const pb = (await t.app.inject({ url: '/api/bootstrap', headers: t.as('priya') })).json();
    expect(pb.enrolled).toEqual([]);
    expect(pb.course).toBeNull();
    expect(pb.courses.map((c: any) => c.id).sort()).toEqual(['comp2211', 'comp3311']);
    expect((await t.app.inject({ url: '/api/notebooks', headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${t.lecture.id}`, headers: t.as('priya', 'comp3311') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/lectures/${t.lecture.id}/slides`, headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/fragments/${frag.id}`, headers: t.as('priya') })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/quizzes', headers: t.as('priya'), payload: { scope: { kind: 'lecture', lectureId: t.lecture.id } } })).statusCode).toBe(403);
    // ...and rejoining restores access.
    await t.app.inject({ method: 'POST', url: '/api/courses/comp2211/enroll', headers: t.as('priya') });
    expect((await t.app.inject({ url: `/api/fragments/${frag.id}`, headers: t.as('priya') })).statusCode).toBe(200);

    // A page in COMP3311 cannot be linked to a COMP2211 lecture.
    await t.app.inject({ method: 'POST', url: '/api/courses/comp3311/enroll', headers: t.as('priya') });
    const nb = (await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: t.as('priya', 'comp3311'), payload: { title: 'DB notes' } })).json();
    const page = (await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya', 'comp3311') })).json().pages[0];
    const bad = await t.app.inject({ method: 'POST', url: `/api/pages/${page.id}/link`, headers: t.as('priya', 'comp3311'), payload: { lectureId: t.lecture.id, slideId: null } });
    expect(bad.statusCode).toBe(400);
    // Free-page auto-linking only offers this course's outline (empty here), never COMP2211 slides.
    await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('priya', 'comp3311'), payload: { revision: 1, strokes: ink, items: [] } });
    await t.jobs.indexPage(page.id);
    expect(t.calls.at(-1)!.prompt).not.toContain('L3.2');
    const st = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('priya', 'comp3311') })).json();
    expect(st.link.lectureId).toBeNull();
    expect((await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('priya') })).json().every((f: any) => !f.shared)).toBe(true);
  });

  it('has no sharing control at all, and keeps private notes private for their stated reason', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    const rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    const mine = (await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json();
    const shared = mine.find((f: any) => f.shared);
    const unclear = mine.find((f: any) => f.reason === 'unclear');
    // The demo deliberately has no stop-sharing: the routes are gone, not merely hidden.
    expect((await t.app.inject({ method: 'POST', url: `/api/fragments/${shared.id}/sharing`, headers: t.as('alex'), payload: { shared: false } })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/courses/comp2211/sharing', headers: t.as('alex') })).statusCode).toBe(404);
    // The AI's own reasons still keep an item private, and the author sees why.
    expect(unclear.reason).toBe('unclear');
    const ownView = (await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: t.as('alex') })).json();
    expect(ownView.own.find((o: any) => o.id === unclear.id)).toMatchObject({ state: 'private' });
    // Progress and the home "Continue" list are unaffected by the removal.
    const boot = (await t.app.inject({ url: '/api/bootstrap', headers: t.as('alex') })).json();
    expect(boot.lectures[0].progress).toMatchObject({ notebookId: alex.notebook.id, written: 1 });
    expect(boot.recent.map((r: any) => r.id)).toEqual([alex.notebook.id]);
    expect(boot.recent[0].lastPageId).toBe(page.id);
    expect(rev).toBe(page.revision + 1);
  });

  it('merges only changed slides, groups notes into one entry, and skips unchanged slides', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    const rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.notebook.id}/close`, headers: t.as('alex') });
    await waitFor(() => t.jobs.idle);
    const slideId = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('alex') })).json().link.slideId;
    const entries = t.store.entries(slideId);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Normalize by the evidence');
    // Only the shared, confidently-read note feeds the entry; the unreadable one does not.
    expect(t.store.entrySources(entries[0].id).map((f) => f.id)).toEqual([sharedFragmentId(t, page.id)]);

    // Closing again without writing costs no model call.
    const before = t.calls.length;
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.notebook.id}/close`, headers: t.as('alex') });
    await waitFor(() => t.jobs.idle);
    expect(t.calls.length).toBe(before);

    // A second classmate writing the same point joins the same entry, and it stops being verbatim.
    const thomas = await t.open('thomas');
    await t.app.inject({ method: 'PUT', url: `/api/pages/${thomas.pages[1].id}`, headers: t.as('thomas'), payload: { revision: thomas.pages[1].revision, strokes: [{ ...ink[0]!, id: 't1' }], items: [] } });
    await t.jobs.indexPage(thomas.pages[1].id);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${thomas.notebook.id}/close`, headers: t.as('thomas') });
    await waitFor(() => t.jobs.idle);
    expect(t.store.entrySourceCount(t.store.entries(slideId)[0].id)).toBe(2);
    const priya = await t.open('priya');
    const entryId = t.store.entries(slideId)[0].id;
    const sugg = await readPage(t, t.as('priya'), priya.pages[1], ink, entryId);
    expect(sugg.gaps[0].sourceLine).toBe("From 2 classmates' notes");
    expect(rev).toBe(page.revision + 1);
  });

  it('drops a disputed entry from suggestions and tells its author why', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } });
    await t.jobs.indexPage(page.id);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.notebook.id}/close`, headers: t.as('alex') });
    await waitFor(() => t.jobs.idle);
    const slideId = (await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('alex') })).json().link.slideId;
    const entryId = t.store.entries(slideId)[0]!.id;
    const thomas = await t.open('thomas');
    const before = await readPage(t, t.as('thomas'), thomas.pages[1], ink, entryId);
    expect(before.gaps[0].entryId).toBeTruthy();
    // "Looks wrong" rechecks immediately; the mock judges it a mismatch with the slide.
    expect((await t.app.inject({ method: 'POST', url: `/api/entries/${before.gaps[0].entryId}/report`, headers: t.as('thomas'), payload: { reason: 'misread' } })).statusCode).toBe(200);
    await waitFor(() => t.store.entry(before.gaps[0].entryId)!.excludedReason === 'disputed');
    // Gone for everyone else, and never cited in a prompt again.
    const after = (await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/suggestions`, headers: t.as('thomas') })).json();
    expect(after.gaps.some((g: any) => g.entryId === before.gaps[0].entryId)).toBe(false);
    await t.app.inject({ method: 'POST', url: '/api/ask', headers: t.as('thomas'), payload: { pageId: thomas.pages[1].id } });
    expect(t.calls.at(-1)!.prompt).not.toContain('Normalize by the evidence');
    // The author sees the explanation on their own page.
    const mine = (await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: t.as('alex') })).json();
    const disputed = mine.own.find((o: any) => o.state === 'disputed');
    expect(disputed.disputeExplanation).toContain('opposite of the slide');
    // Another student cannot report into a course they are not in.
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: t.as('priya') });
    expect((await t.app.inject({ method: 'POST', url: `/api/entries/${before.gaps[0].entryId}/report`, headers: t.as('priya'), payload: {} })).statusCode).toBe(404);
  });

  it('fills a gap with the slide when no classmate note covers it', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } });
    await t.jobs.indexPage(page.id);
    // The author's own note leaves a gap, and nobody else has written on this slide yet.
    const mine = (await t.app.inject({ url: `/api/pages/${page.id}/suggestions`, headers: t.as('alex') })).json();
    expect(mine.gaps).toHaveLength(1);
    expect(mine.gaps[0]).toMatchObject({ source: 'slide', sourceLine: 'From slide 2' });
    expect(mine.gaps[0].body).toContain('Summary of slide 2');
    expect(mine.gaps[0].citations[0]).toMatchObject({ kind: 'slide', page: 2 });
    // Filling on demand is only for a gap with nothing stored behind it.
    const filled = await t.app.inject({ method: 'POST', url: `/api/pages/${page.id}/suggestions/${mine.gaps[0].id}/fill`, headers: t.as('alex') });
    expect(filled.statusCode).toBe(200);
    expect(filled.json().body).toContain('sums to one');
  });

  it('closes notebooks and slide assets when a student leaves a course', async () => {
    const t = await seeded();
    const slides = (await t.app.inject({ url: `/api/lectures/${t.lecture.id}/slides`, headers: t.as('priya') })).json();
    const asset = slides[0].image;
    expect((await t.app.inject({ url: asset, headers: t.as('priya') })).statusCode).toBe(200);
    const nb = (await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: t.as('priya'), payload: { title: 'My notes' } })).json();
    const page = (await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya') })).json().pages[0];
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: t.as('priya') });
    expect((await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/pages/${page.id}/status`, headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/pages/${page.id}/render.png`, headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: asset, headers: t.as('priya') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: asset, headers: t.as('thomas') })).statusCode).toBe(200);
    // a lecture notebook counts as progress, not as one of "my notebooks" on the home card
    await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${t.lecture.id}`, headers: t.as('thomas') });
    expect((await t.app.inject({ url: '/api/bootstrap', headers: t.as('thomas') })).json().courses[0].notebookCount).toBe(0);
    // covers of courses the student has not joined are not exposed
    expect((await t.app.inject({ url: '/api/bootstrap', headers: t.as('priya') })).json().courses.find((c: any) => c.id === 'comp2211').cover).toBeNull();
    // rejoining restores both the notebook and the course material
    await t.app.inject({ method: 'POST', url: '/api/courses/comp2211/enroll', headers: t.as('priya') });
    expect((await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya') })).statusCode).toBe(200);
    expect((await t.app.inject({ url: asset, headers: t.as('priya') })).statusCode).toBe(200);
  });

  it('keeps an old citation resolvable when the author edits the note it came from', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    let rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    const original = (await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json().find((f: any) => f.shared);
    // Alex rewrites the note: a new fragment replaces it and the old one is superseded.
    rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: rev, strokes: [...ink, { ...ink[0], id: 's2' }], items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    const rows = t.store.pageFragments(page.id).filter((f) => f.text === original.text);
    expect(rows).toHaveLength(1);
    expect(rows[0].shared).toBe(false);
    expect(t.store.supersededBy(rows[0].id)).toBeTruthy();
    expect(rev).toBeGreaterThan(page.revision);
  });

  it('rejects cross-site writes', async () => {
    const t = await setup(null);
    const res = await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: { origin: 'https://evil.example' }, payload: { title: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});
