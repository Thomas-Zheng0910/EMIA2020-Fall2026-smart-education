import { describe, it, expect } from 'vitest';
import { setup, upload, waitFor } from './helpers';

const handler = (prompt: string) => {
  if (prompt.includes('study digest'))
    return { slides: [...prompt.matchAll(/--- Slide (\d+)/g)].map((m) => ({ page: Number(m[1]), title: `Title ${m[1]}`, summary: `Summary of slide ${m[1]}`, formulas: [], topics: ['bayes'] })) };
  if (prompt.includes('Extract the course knowledge'))
    return {
      link: { lectureNumber: 3, slide: 2, confidence: 0.9 },
      fragments: [
        { kind: 'explanation', text: 'Posterior is prior times likelihood, normalized by $P(B)$.', topic: 'Bayes rule', confidence: 0.92, bbox: [0.1, 0.1, 0.5, 0.2] },
        { kind: 'other', text: 'blurry scribble', topic: '?', confidence: 0.3, bbox: [0.1, 0.5, 0.2, 0.1] },
      ],
    };
  if (prompt.includes('TASK: The student is reviewing'))
    return {
      cards: [
        { title: 'Missing normalization', body: 'Divide by $P(B)$.', basis: 'peer', citations: ['F1', 'S99'], conflict: null },
        { title: 'Claimed official without source', body: 'x', basis: 'official', citations: ['X1'], conflict: null },
      ],
    };
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

    const thomas = await t.open('thomas');
    expect(thomas.pages[1].peerCount).toBe(1);
    expect(thomas.pages[0].peerCount).toBe(0);
    const mates = (await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/classmates`, headers: t.as('thomas') })).json();
    expect(mates.fragments).toHaveLength(1);
    expect(mates.fragments[0].authorName).toBe('Alex');
    const crop = await t.app.inject({ url: `/api/fragments/${mates.fragments[0].id}/crop.png`, headers: t.as('thomas') });
    expect(crop.headers['content-type']).toContain('image/png');
    // the private low-confidence fragment is not readable by classmates
    const priv = shared.find((f: any) => !f.shared);
    expect((await t.app.inject({ url: `/api/fragments/${priv.id}`, headers: t.as('thomas') })).statusCode).toBe(404);
    // Alex does not see their own note as a classmate note
    const own = (await t.app.inject({ url: `/api/pages/${page.id}/classmates`, headers: t.as('alex') })).json();
    expect(own.fragments).toHaveLength(0);
    // dismiss hides it for Thomas only
    await t.app.inject({ method: 'POST', url: `/api/fragments/${mates.fragments[0].id}/dismiss`, headers: t.as('thomas') });
    expect((await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/classmates`, headers: t.as('thomas') })).json().fragments).toHaveLength(0);
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
    const thomas = await t.open('thomas');
    const res = await t.app.inject({ method: 'POST', url: '/api/ask', headers: t.as('thomas'), payload: { pageId: thomas.pages[1].id, bbox: [0.1, 0.1, 0.3, 0.3], question: 'why divide?' } });
    expect(res.statusCode).toBe(200);
    const { cards } = res.json();
    expect(cards[0].basis).toBe('peer');
    expect(cards[0].citations).toEqual([expect.objectContaining({ kind: 'fragment', author: 'Alex' })]); // S99 dropped
    expect(cards[1].basis).toBe('ai'); // "official" without any valid slide citation is downgraded
    const call = t.calls.at(-1)!;
    expect(call.images).toBe(2); // page + selection crop
    expect(call.prompt).toContain('why divide?');
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

  it('lets authors stop sharing, remembers it across re-reads, and explains private items', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    let rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    let mine = (await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json();
    expect(mine.find((f: any) => !f.shared).reason).toBe('unclear');
    const shared = mine.find((f: any) => f.shared);
    // only the author can change sharing
    expect((await t.app.inject({ method: 'POST', url: `/api/fragments/${shared.id}/sharing`, headers: t.as('thomas'), payload: { shared: false } })).statusCode).toBe(404);
    await t.app.inject({ method: 'POST', url: `/api/fragments/${shared.id}/sharing`, headers: t.as('alex'), payload: { shared: false } });
    const thomas = await t.open('thomas');
    expect(thomas.pages[1].peerCount).toBe(0);
    // AI-kept-private items can't be force-shared
    const unclear = mine.find((f: any) => f.reason === 'unclear');
    expect((await t.app.inject({ method: 'POST', url: `/api/fragments/${unclear.id}/sharing`, headers: t.as('alex'), payload: { shared: true } })).statusCode).toBe(400);
    // a new edit re-reads the page; the withdrawn item stays withdrawn
    rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: rev, strokes: [...ink, { ...ink[0], id: 's2' }], items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    mine = (await t.app.inject({ url: `/api/pages/${page.id}/shared`, headers: t.as('alex') })).json();
    const again = mine.find((f: any) => f.text === shared.text);
    expect(again).toMatchObject({ shared: false, reason: 'withheld' });
    const review = (await t.app.inject({ url: '/api/courses/comp2211/sharing', headers: t.as('alex') })).json();
    expect(review).toMatchObject({ classmates: 2, shared: 0 });
    expect(review.items[0]).toMatchObject({ lectureNumber: 3, slidePage: 2, notebookId: alex.notebook.id });
    await t.app.inject({ method: 'POST', url: `/api/fragments/${again.id}/sharing`, headers: t.as('alex'), payload: { shared: true } });
    expect((await t.open('thomas')).pages[1].peerCount).toBe(1);
    // course page progress and the home "Continue" list
    const boot = (await t.app.inject({ url: '/api/bootstrap', headers: t.as('alex') })).json();
    expect(boot.lectures[0].progress).toMatchObject({ notebookId: alex.notebook.id, written: 1 });
    expect(boot.recent.map((r: any) => r.id)).toEqual([alex.notebook.id]);
    expect(boot.recent[0].lastPageId).toBe(page.id);
    const tb = (await t.app.inject({ url: '/api/bootstrap', headers: t.as('thomas') })).json();
    expect(tb.recent).toEqual([]); // opening a lecture without writing is not "recent work"
    expect(tb.lectures[0].progress).toMatchObject({ written: 0, peerNotes: 1 });
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

  it('keeps a dismissed classmate note dismissed when the author re-reads the page', async () => {
    const t = await seeded();
    const alex = await t.open('alex');
    const page = alex.pages[1];
    let rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: page.revision, strokes: ink, items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    const thomas = await t.open('thomas');
    const mates = (await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/classmates`, headers: t.as('thomas') })).json();
    expect(mates.fragments).toHaveLength(1);
    await t.app.inject({ method: 'POST', url: `/api/fragments/${mates.fragments[0].id}/dismiss`, headers: t.as('thomas') });
    expect((await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/classmates`, headers: t.as('thomas') })).json().fragments).toHaveLength(0);
    // the same transcription comes back after Alex edits; the dismissal must survive the new fragment id
    rev = (await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: t.as('alex'), payload: { revision: rev, strokes: [...ink, { ...ink[0], id: 's2' }], items: [] } })).json().revision;
    await t.jobs.indexPage(page.id);
    expect((await t.app.inject({ url: `/api/pages/${thomas.pages[1].id}/classmates`, headers: t.as('thomas') })).json().fragments).toHaveLength(0);
    // a classmate who did not dismiss it still sees it
    const priya = await t.open('priya');
    expect((await t.app.inject({ url: `/api/pages/${priya.pages[1].id}/classmates`, headers: t.as('priya') })).json().fragments).toHaveLength(1);
  });

  it('re-reads after a whole-lecture link is confirmed but not after annotations', async () => {
    const t = await seeded();
    const nb = (await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: t.as('priya'), payload: { title: 'Revision', paper: 'ruled' } })).json();
    const page = (await t.app.inject({ url: `/api/notebooks/${nb.id}`, headers: t.as('priya') })).json().pages[0];
    const base = t.jobs.originalHash(t.store.page(page.id));
    const annotation = { id: 'a1', type: 'annotation' as const, x: 10, y: 10, w: 200, title: 'AI', body: 'generated', basis: 'ai' as const, citations: [] };
    expect(t.jobs.originalHash({ ...t.store.page(page.id), items: [annotation] })).toBe(base);
    t.store.setLink(page.id, { lectureId: t.lecture.id, slideId: null, confidence: 1, confirmed: true });
    expect(t.jobs.originalHash(t.store.page(page.id))).not.toBe(base);
  });

  it('files notebooks into a student’s own folders without leaking across students or courses', async () => {
    const t = await seeded();
    const post = (url: string, s: string, payload: object, course = 'comp2211') => t.app.inject({ method: 'POST', url, headers: t.as(s, course), payload });
    const patch = (url: string, s: string, payload: object, course = 'comp2211') => t.app.inject({ method: 'PATCH', url, headers: t.as(s, course), payload });
    const notebooks = async (s: string, course = 'comp2211') => (await t.app.inject({ url: '/api/notebooks', headers: t.as(s, course) })).json();

    const exam = (await post('/api/folders', 'thomas', { name: '  Midterm  ' })).json();
    expect(exam).toMatchObject({ name: 'Midterm', parentId: null, courseId: 'comp2211' });
    expect(exam.studentId).toBeUndefined();
    const week = (await post('/api/folders', 'thomas', { name: 'Week 3', parentId: exam.id })).json();
    expect(week.parentId).toBe(exam.id);
    expect((await post('/api/folders', 'thomas', { name: ' ' })).statusCode).toBe(400);

    // a new notebook can start inside a folder; an existing one can be moved and moved back out
    const nb = (await post('/api/notebooks', 'thomas', { title: 'Revision', folderId: week.id })).json();
    expect((await notebooks('thomas')).find((n: any) => n.id === nb.id).folderId).toBe(week.id);
    const lecNb = (await t.open('thomas')).notebook;
    expect((await patch(`/api/notebooks/${lecNb.id}`, 'thomas', { folderId: exam.id })).statusCode).toBe(200);
    let mine = await notebooks('thomas');
    expect(mine.find((n: any) => n.id === lecNb.id)).toMatchObject({ folderId: exam.id, written: 0 });
    expect((await patch(`/api/folders/${week.id}`, 'thomas', { name: 'Week 3 · KNN' })).json().name).toBe('Week 3 · KNN');

    // other students can neither see nor use my folders (they have the two a course starts with)
    expect((await t.app.inject({ url: '/api/folders', headers: t.as('alex') })).json().map((f: any) => f.name).sort()).toEqual(['Lectures', 'Quizzes']);
    expect((await patch(`/api/folders/${exam.id}`, 'alex', { name: 'x' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/folders/${exam.id}`, headers: t.as('alex') })).statusCode).toBe(404);
    expect((await post('/api/folders', 'alex', { name: 'x', parentId: exam.id })).statusCode).toBe(404);
    const alexNb = (await post('/api/notebooks', 'alex', { title: 'A' })).json();
    expect((await patch(`/api/notebooks/${alexNb.id}`, 'alex', { folderId: exam.id })).statusCode).toBe(404);
    expect((await patch(`/api/notebooks/${nb.id}`, 'alex', { folderId: null })).statusCode).toBe(403);

    // notes stay in their own course
    await post('/api/courses', 'thomas', { code: 'COMP3311', name: 'Databases' });
    const dbFolder = (await post('/api/folders', 'thomas', { name: 'DB' }, 'comp3311')).json();
    expect(
      (await t.app.inject({ url: '/api/folders', headers: t.as('thomas', 'comp3311') })).json().map((f: any) => f.name).sort(),
    ).toEqual(['DB', 'Lectures', 'Quizzes']);
    expect((await t.app.inject({ url: '/api/folders', headers: t.as('thomas', 'comp3311') })).json().some((f: any) => f.id === dbFolder.id)).toBe(true);
    expect((await patch(`/api/notebooks/${nb.id}`, 'thomas', { folderId: dbFolder.id })).statusCode).toBe(400);
    expect((await post('/api/notebooks', 'thomas', { title: 'x', folderId: exam.id }, 'comp3311')).statusCode).toBe(400);
    expect((await post('/api/folders', 'thomas', { name: 'x', parentId: exam.id }, 'comp3311')).statusCode).toBe(400);

    // deleting a folder keeps everything: its notebooks and subfolders move up one level
    expect((await t.app.inject({ method: 'DELETE', url: `/api/folders/${exam.id}`, headers: t.as('thomas') })).statusCode).toBe(200);
    const folders = (await t.app.inject({ url: '/api/folders', headers: t.as('thomas') })).json();
    expect(folders.find((f: any) => f.id === week.id)).toEqual({ id: week.id, courseId: 'comp2211', parentId: null, name: 'Week 3 · KNN' });
    expect(folders.map((f: any) => f.name).sort()).toEqual(['Lectures', 'Quizzes', 'Week 3 · KNN']);
    mine = await notebooks('thomas');
    expect(mine.find((n: any) => n.id === lecNb.id).folderId).toBeNull();
    expect(mine.find((n: any) => n.id === nb.id).folderId).toBe(week.id);

    // leaving the course closes its folders too
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: t.as('thomas') });
    expect((await t.app.inject({ url: '/api/folders', headers: t.as('thomas') })).statusCode).toBe(403);
    expect((await patch(`/api/folders/${week.id}`, 'thomas', { name: 'x' })).statusCode).toBe(403);
  });

  it('starts every course with two ordinary folders and keeps decks shared files', async () => {
    const t = await seeded();
    const files = async (s: string) => (await t.app.inject({ url: '/api/courses/comp2211/files', headers: t.as(s) })).json();
    const patch = (url: string, s: string, payload: object) => t.app.inject({ method: 'PATCH', url, headers: t.as(s), payload });

    // a course starts with Lectures and Quizzes, seeded once per student per course
    const before = await files('thomas');
    expect(before.folders.map((f: any) => f.name).sort()).toEqual(['Lectures', 'Quizzes']);
    expect(before.folders.every((f: any) => f.parentId === null)).toBe(true);
    expect(before.lecturesFolderId).toBe(before.folders.find((f: any) => f.name === 'Lectures').id);
    // the seeded folder is ordinary: renaming it keeps lecture decks filed in it
    const lecturesFolder = before.lecturesFolderId;
    await patch(`/api/folders/${lecturesFolder}`, 'thomas', { name: 'Course slides' });
    const renamed = await files('thomas');
    expect(renamed.lecturesFolderId).toBe(lecturesFolder);
    expect(renamed.folders.find((f: any) => f.id === lecturesFolder).name).toBe('Course slides');
    // ...and deleting it does not bring it back
    await t.app.inject({ method: 'DELETE', url: `/api/folders/${lecturesFolder}`, headers: t.as('thomas') });
    const gone = await files('thomas');
    expect(gone.lecturesFolderId).toBeNull();
    expect(gone.folders.map((f: any) => f.name)).toEqual(['Quizzes']);

    // a deck is one shared lecture record: no per-student notebook until the student opens it
    expect(gone.decks).toHaveLength(1);
    expect(gone.decks[0]).toMatchObject({ lectureId: t.lecture.id, number: 3, notebookId: null, written: 0, folderId: null });
    expect(gone.notes).toEqual([]);

    // filing a deck makes the student's own copy without copying the slides
    const exam = (await t.app.inject({ method: 'POST', url: '/api/folders', headers: t.as('thomas'), payload: { name: 'Exam' } })).json();
    const filed = await patch(`/api/lectures/${t.lecture.id}`, 'thomas', { folderId: exam.id });
    expect(filed.statusCode).toBe(200);
    const filedFiles = await files('thomas');
    expect(filedFiles.decks[0]).toMatchObject({ notebookId: filed.json().id, folderId: exam.id, pageCount: 3 });
    // the copy holds no pages, and lecture notebooks are the decks, not extra files
    expect(t.store.pages(filed.json().id)).toHaveLength(0);
    expect(filedFiles.notes).toEqual([]);
    expect((await t.app.inject({ url: '/api/notebooks', headers: t.as('thomas') })).json().filter((n: any) => n.kind === 'lecture')).toHaveLength(1);

    // opening it builds the pages once, and does not add a second file
    await t.open('thomas');
    const opened = await files('thomas');
    expect(opened.decks).toHaveLength(1);
    expect(opened.decks[0]).toMatchObject({ notebookId: filed.json().id, folderId: exam.id });
    expect(t.store.pages(filed.json().id)).toHaveLength(3);
    // a rename through the deck route keeps the same copy
    await patch(`/api/lectures/${t.lecture.id}`, 'thomas', { title: 'L3 · Bayes' });
    expect(t.store.notebook(filed.json().id).title).toBe('L3 · Bayes');

    // another student's deck is still untouched and unfiled in their own tree
    const alex = await files('alex');
    expect(alex.decks[0]).toMatchObject({ notebookId: null, written: 0 });
    expect(t.store.pages(filed.json().id)).toHaveLength(3);
  });

  it('rejects cross-site writes', async () => {
    const t = await setup(null);
    const res = await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: { origin: 'https://evil.example' }, payload: { title: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});
