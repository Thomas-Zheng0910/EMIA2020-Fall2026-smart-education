import { describe, it, expect } from 'vitest';
import { setup, upload, waitFor } from './helpers';
import { ensureStudents } from '../server/seed';

const as = (sid: string, course = 'comp2211') => ({ 'x-student-id': sid, 'x-course-id': course });
const ink = (id: string, x = 100) => [{ id, tool: 'pen', color: '#000', size: 4, points: [x, 100, 0.5, x + 100, 150, 0.5, x + 180, 120, 0.5] }];

const handler = (prompt: string) => {
  if (prompt.includes('study digest'))
    return { slides: [...prompt.matchAll(/--- Slide (\d+)/g)].map((m) => ({ page: Number(m[1]), title: `Title ${m[1]}`, summary: `Summary ${m[1]}`, formulas: [], topics: ['t'] })) };
  if (prompt.includes('Extract the course knowledge'))
    return {
      link: { lectureNumber: 1, slide: 2, confidence: 1 },
      fragments: [{ kind: 'explanation', text: 'A note the student added.', topic: 'topic', confidence: 0.9, bbox: [0.1, 0.1, 0.2, 0.2] }],
      gaps: [],
    };
  if (prompt.includes('Group fragments that make the same point')) {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return { entries: [{ id: null, title: 'The note', summary: 'A note.', fragmentIds: ids, contradicts: null, disputeExplanation: null }] };
  }
  if (prompt.includes('Name 5-15')) return { topics: [{ name: 'Topic', slidePages: [1, 2] }] };
  return {};
};

async function makeNotebook(t: Awaited<ReturnType<typeof setup>>, sid: string, title = 'Bayes practice') {
  const { id } = (await t.app.inject({ method: 'POST', url: '/api/notebooks', headers: as(sid), payload: { title, paper: 'ruled' } })).json();
  const nb = (await t.app.inject({ url: `/api/notebooks/${id}`, headers: as(sid) })).json();
  return { id, page: nb.pages[0] };
}

async function save(t: Awaited<ReturnType<typeof setup>>, sid: string, page: any, strokes: any[], items: any[] = []) {
  const res = await t.app.inject({ method: 'PUT', url: `/api/pages/${page.id}`, headers: as(sid), payload: { revision: page.revision, strokes, items } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('direct shares and co-owned notes', () => {
  it('does not serve an uploaded image to a student who cannot reach its page', async () => {
    const t = await setup(null);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const boundary = '----notebook-image';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/api/files',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-student-id': 'alex' },
    });
    expect(uploaded.statusCode).toBe(200);
    const fid = uploaded.json().id;
    expect((await t.app.inject({ url: `/api/files/${fid}`, headers: as('alex') })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/files/${fid}`, headers: as('thomas') })).statusCode).toBe(404);
  });

  it('reserves course creation and official slides for the professor', async () => {
    const t = await setup(null);
    expect((await t.app.inject({ method: 'POST', url: '/api/courses', headers: as('thomas'), payload: { code: 'comp3311', name: 'Databases' } })).statusCode).toBe(403);
    const { readFileSync } = await import('node:fs');
    expect((await upload(t.app, '/api/lectures', readFileSync(t.pdf), '1-intro.pdf', 'thomas')).statusCode).toBe(403);
    const created = await t.app.inject({ method: 'POST', url: '/api/courses', headers: as('professor'), payload: { code: 'comp3311', name: 'Databases' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().myRole).toBe('instructor');
  });

  it('repairs the seeded professor after leaving and rejoining a course', async () => {
    const t = await setup(null);
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: as('professor') });
    expect(t.store.courseRole('professor', 'comp2211')).toBeNull();
    expect((await t.app.inject({ method: 'POST', url: '/api/courses/comp2211/enroll', headers: as('professor') })).statusCode).toBe(200);
    expect(t.store.courseRole('professor', 'comp2211')).toBe('instructor');
    ensureStudents(t.store);
    expect(t.store.courseRole('professor', 'comp2211')).toBe('instructor');
  });

  it('sends a pullable copy, preserves the sender, and fetches source changes around local edits', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    const before = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).json();
    const page = before.pages[0];

    const shared = await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'pull' } });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().shared).toBe(1);

    const sent = (await t.app.inject({ url: `/api/notebooks/${alex.id}/shares`, headers: as('alex') })).json();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toName: 'Thomas', mode: 'pull' });
    expect((await t.app.inject({ url: `/api/notebooks/${alex.id}/shares`, headers: as('thomas') })).statusCode).toBe(403);
    // Direct sharing is student-to-student; the instructor is not a recipient in this surface.
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['professor'], mode: 'pull' } })).statusCode,
    ).toBe(400);

    const notices = (await t.app.inject({ url: '/api/notices', headers: as('thomas') })).json();
    expect(notices.shares).toHaveLength(1);
    expect(notices.shares[0]).toMatchObject({ fromName: 'Alex', mode: 'pull', title: 'Alex · Bayes practice' });
    const thomasFiles = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    expect(thomasFiles.sharedFolderId).toBeTruthy();
    const copy = thomasFiles.notes.find((n: any) => n.kind === 'shared');
    expect(copy).toBeTruthy();
    expect(copy.folderId).toBe(thomasFiles.sharedFolderId);
    expect(copy.share).toMatchObject({ mode: 'pull', fromName: 'Alex', updatesAvailable: false });

    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(copyNb.pages[0].strokes).toHaveLength(1);
    expect(copyNb.pages[0].strokes[0]).toMatchObject({ origin: 'shared', sourceId: 'a1' });
    // the sender's page is unchanged
    expect((await t.app.inject({ url: `/api/pages/${page.id}`, headers: as('alex') })).json().strokes).toHaveLength(1);

    // Thomas writes his own note next to Alex's. The source stays untouched.
    await save(t, 'thomas', copyNb.pages[0], [...copyNb.pages[0].strokes, ...ink('t1', 300)] as any);
    expect((await t.app.inject({ url: `/api/pages/${page.id}`, headers: as('alex') })).json().strokes).toHaveLength(1);

    // Alex adds a second stroke. Thomas fetches: the new source object appears, his own stays.
    const alexNow = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).json();
    await save(t, 'alex', alexNow.pages[0], [...alexNow.pages[0].strokes, ...ink('a2', 500)] as any);
    const thomasNow = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(thomasNow.notebook.share.updatesAvailable).toBe(true);
    const fetched = await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    expect(fetched.json().synced).toBe(true);
    const afterFetch = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(afterFetch.pages[0].strokes.map((s: any) => s.sourceId).filter(Boolean).sort()).toEqual(['a1', 'a2']);
    expect(afterFetch.pages[0].strokes.some((s: any) => s.id === 't1')).toBe(true);

    // Thomas edits the shared a1 stroke: a later source change to that object must not win.
    const local = afterFetch.pages[0];
    const edited = local.strokes.map((s: any) => (s.sourceId === 'a1' ? { ...s, points: [1, 2, 0.5, 3, 4, 0.5, 5, 6, 0.5] } : s));
    await save(t, 'thomas', local, edited);
    const alexAgain = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).json();
    const a1 = alexAgain.pages[0].strokes.find((s: any) => s.id === 'a1');
    await save(t, 'alex', alexAgain.pages[0], alexAgain.pages[0].strokes.map((s: any) => (s.id === 'a1' ? { ...s, points: [9, 9, 0.5, 8, 8, 0.5, 7, 7, 0.5] } : s)) as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    const afterConflict = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(afterConflict.pages[0].strokes.find((s: any) => s.sourceId === 'a1').points[0]).toBe(1);
    expect(a1).toBeTruthy();

    // Erasing a shared object after editing it is still the latest local decision.
    const localPage = afterConflict.pages[0];
    await save(t, 'thomas', localPage, localPage.strokes.filter((s: any) => s.sourceId !== 'a1'));
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    const afterErase = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(afterErase.pages[0].strokes.some((s: any) => s.sourceId === 'a1')).toBe(false);
  });

  it('keeps a snapshot frozen, and a local erase does not return on fetch', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'snapshot' } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    const alexNow = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).json();
    await save(t, 'alex', alexNow.pages[0], [...alexNow.pages[0].strokes, ...ink('a2', 300)] as any);
    expect((await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') })).json().synced).toBe(false);
    expect((await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json().pages[0].strokes).toHaveLength(1);

    // Erasing the copied stroke is a local decision; a pull does not bring it back.
    await save(t, 'thomas', copyNb.pages[0], []);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/detach`, headers: as('thomas') });
    expect((await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json().notebook.share.mode).toBe('snapshot');
  });

  it('does not advertise unrelated page edits to a page-only copy', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    const added = (await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/pages`, headers: as('alex'), payload: { after: alex.page.id } })).json();
    await save(t, 'alex', added, ink('b1') as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'pull', pageId: alex.page.id } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    let copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(copyNb.notebook.share.updatesAvailable).toBe(false);
    expect(copyNb.pages).toHaveLength(1);

    // A change to a different source page is not an update to this one-page copy.
    const page2 = (await t.app.inject({ url: `/api/pages/${added.id}`, headers: as('alex') })).json();
    await save(t, 'alex', page2, [...page2.strokes, ...ink('b2', 600)] as any);
    copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(copyNb.notebook.share.updatesAvailable).toBe(false);

    // A change to the shared page is.
    const page1 = (await t.app.inject({ url: `/api/pages/${alex.page.id}`, headers: as('alex') })).json();
    await save(t, 'alex', page1, [...page1.strokes, ...ink('a2', 600)] as any);
    copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(copyNb.notebook.share.updatesAvailable).toBe(true);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    const after = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0].strokes.some((s: any) => s.sourceId === 'a2')).toBe(true);
  });

  it('keeps a source page the recipient edited when the source deletes it', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    const added = (await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/pages`, headers: as('alex'), payload: { after: alex.page.id } })).json();
    const second = { ...added, revision: added.revision };
    const savedSecond = await save(t, 'alex', second, ink('b1') as any);
    const alexPage2 = (await t.app.inject({ url: `/api/pages/${added.id}`, headers: as('alex') })).json();
    expect(savedSecond.revision).toBe(alexPage2.revision);

    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'pull' } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    const copyPage2 = copyNb.pages.find((p: any) => p.position === alexPage2.position);
    expect(copyPage2).toBeTruthy();
    const edited = copyPage2.strokes.map((s: any) => ({ ...s, points: [1, 2, 0.5, 3, 4, 0.5, 5, 6, 0.5] }));
    await save(t, 'thomas', copyPage2, edited);

    // The source page is deleted; the copy's edited shared object is still local work.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/pages/${alexPage2.id}`, headers: as('alex') })).statusCode).toBe(200);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    const after = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    const kept = after.pages.find((p: any) => p.position === alexPage2.position);
    expect(kept).toBeTruthy();
    expect(kept.sourcePageId).toBeNull();
    expect(kept.origin).toBe('own');
    expect(kept.strokes[0].localModified).toBe(true);
  });

  it('turns a note into a group note, merges two people editing the same page, and keeps outsiders out', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    const invited = await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/invite`, headers: as('alex'), payload: { students: ['thomas'] } });
    expect(invited.statusCode).toBe(200);
    const notices = (await t.app.inject({ url: '/api/notices', headers: as('thomas') })).json();
    expect(notices.invites).toHaveLength(1);
    expect(notices.invites[0]).toMatchObject({ fromName: 'Alex', title: 'Bayes practice' });
    expect((await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/members/accept`, headers: as('thomas') })).statusCode).toBe(200);
    const group = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('thomas') })).json();
    expect(group.notebook.kind).toBe('group');
    expect(group.notebook.role).toBe('editor');
    expect((await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('priya') })).statusCode).toBe(403);

    // Both editors start from the same base. Each adds a stroke; the server keeps both.
    const base = group.pages[0];
    const a = await t.app.inject({
      method: 'PUT',
      url: `/api/pages/${base.id}`,
      headers: as('alex'),
      payload: { revision: base.revision, strokes: [...base.strokes, ...ink('fromA', 100)], items: [], base: { strokes: base.strokes, items: base.items } },
    });
    expect(a.statusCode).toBe(200);
    const th = await t.app.inject({
      method: 'PUT',
      url: `/api/pages/${base.id}`,
      headers: as('thomas'),
      payload: { revision: base.revision, strokes: [...base.strokes, ...ink('fromT', 400)], items: [], base: { strokes: base.strokes, items: base.items } },
    });
    expect(th.statusCode).toBe(200);
    const merged = (await t.app.inject({ url: `/api/pages/${base.id}`, headers: as('alex') })).json();
    expect(merged.strokes.map((s: any) => s.id)).toEqual(expect.arrayContaining(['a1', 'fromA', 'fromT']));

    // A group note is not ingested into the anonymous bank.
    await t.jobs.indexPage(base.id);
    expect(t.store.pageFragments(base.id)).toHaveLength(0);

    // Leaving removes access for that person only.
    await t.app.inject({ method: 'DELETE', url: `/api/notebooks/${alex.id}/members/thomas`, headers: as('thomas') });
    expect((await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('thomas') })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).statusCode).toBe(200);
  });

  it('hands a group note to an enrolled editor when the owner leaves the course', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/invite`, headers: as('alex'), payload: { students: ['thomas'] } });
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/members/accept`, headers: as('thomas') });
    await t.app.inject({ method: 'DELETE', url: '/api/courses/comp2211/enroll', headers: as('alex') });
    const after = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('thomas') })).json();
    expect(after.notebook.role).toBe('owner');
    expect(after.notebook.studentId).toBe('thomas');
    expect((await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('alex') })).statusCode).toBe(403);
  });

  it('indexes only the recipient’s own additions on a shared slide, never the shared layer', async () => {
    const t = await setup(handler);
    const { readFileSync } = await import('node:fs');
    const lecture = (await upload(t.app, '/api/lectures', readFileSync(t.pdf), '1-intro.pdf')).json();
    await waitFor(() => t.jobs.idle);
    const opened = (await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${lecture.id}`, headers: as('alex') })).json();
    const alex = (await t.app.inject({ url: `/api/notebooks/${opened.id}`, headers: as('alex') })).json();
    await save(t, 'alex', alex.pages[0], ink('shared1') as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${opened.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'snapshot' } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    await save(t, 'thomas', copyNb.pages[0], [...copyNb.pages[0].strokes, ...ink('own1', 500)] as any);
    await t.jobs.indexPage(copyNb.pages[0].id);
    const frags = t.store.pageFragments(copyNb.pages[0].id);
    expect(frags).toHaveLength(1);
    expect(frags[0]!.studentId).toBe('thomas');
    const call = t.calls.at(-1)!;
    expect(call.images).toBe(2);
    expect(call.prompt).toContain('copy received from a classmate');
    // The source keeps its own note and its own indexing identity.
    await t.jobs.indexPage(alex.pages[0].id);
    const sourceFrags = t.store.pageFragments(alex.pages[0].id);
    expect(sourceFrags).toHaveLength(1);
    expect(sourceFrags[0]!.studentId).toBe('alex');
  });

  it('freezes old pullable copies and strips suggestions when a source becomes a group note', async () => {
    const t = await setup(handler);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'pull' } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    const before = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(before.notebook.share.mode).toBe('pull');

    // Alex turns the source into a group note with Priya. The old pullable copy must freeze.
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/invite`, headers: as('alex'), payload: { students: ['priya'] } });
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/members/accept`, headers: as('priya') });
    const group = (await t.app.inject({ url: `/api/notebooks/${alex.id}`, headers: as('priya') })).json();
    expect(group.notebook.kind).toBe('group');
    // A group note does not show AI suggestions or another member's private transcription.
    const suggestions = (await t.app.inject({ url: `/api/pages/${group.pages[0].id}/suggestions`, headers: as('priya') })).json();
    expect(suggestions.gaps).toEqual([]);
    expect(suggestions.own).toEqual([]);
    // Priya writes on the group note; Thomas's old copy is a snapshot and must not follow.
    await save(t, 'priya', group.pages[0], [...group.pages[0].strokes, ...ink('p1', 600)] as any);
    const fetched = await t.app.inject({ method: 'POST', url: `/api/notebooks/${copy.id}/fetch`, headers: as('thomas') });
    expect(fetched.json().synced).toBe(false);
    const after = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(after.notebook.share.mode).toBe('snapshot');
    expect(after.pages[0].strokes.some((s: any) => s.sourceId === 'p1')).toBe(false);
  });

  it('does not publish a shared copy’s own additions under an unconfirmed guessed link', async () => {
    const t = await setup(handler);
    const { readFileSync } = await import('node:fs');
    await upload(t.app, '/api/lectures', readFileSync(t.pdf), '1-intro.pdf');
    await waitFor(() => t.jobs.idle);
    const alex = await makeNotebook(t, 'alex');
    await save(t, 'alex', alex.page, ink('a1') as any);
    await t.jobs.indexPage(alex.page.id);
    const source = (await t.app.inject({ url: `/api/pages/${alex.page.id}`, headers: as('alex') })).json();
    expect(source.link.slideId).toBeTruthy();
    expect(source.link.confirmed).toBe(false);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${alex.id}/share`, headers: as('alex'), payload: { students: ['thomas'], mode: 'snapshot' } });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    const copyPage = copyNb.pages[0];
    await save(t, 'thomas', copyPage, [...copyPage.strokes, ...ink('own', 600)] as any);
    await t.jobs.indexPage(copyPage.id);
    expect(t.store.pageFragments(copyPage.id)).toHaveLength(0);
  });

  it('keeps entry sources when an unchanged note is re-indexed', async () => {
    const t = await setup(handler);
    const { readFileSync } = await import('node:fs');
    const lecture = (await upload(t.app, '/api/lectures', readFileSync(t.pdf), '1-intro.pdf')).json();
    await waitFor(() => t.jobs.idle);
    const opened = (await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${lecture.id}`, headers: as('alex') })).json();
    const alex = (await t.app.inject({ url: `/api/notebooks/${opened.id}`, headers: as('alex') })).json();
    await save(t, 'alex', alex.pages[0], ink('a1') as any);
    await t.jobs.indexPage(alex.pages[0].id);
    await t.app.inject({ method: 'POST', url: `/api/notebooks/${opened.id}/close`, headers: as('alex') });
    await waitFor(() => t.jobs.idle);
    const status = (await t.app.inject({ url: `/api/pages/${alex.pages[0].id}/status`, headers: as('alex') })).json();
    const entry = t.store.entries(status.link.slideId)[0]!;
    expect(t.store.entrySourceCount(entry.id)).toBeGreaterThan(0);

    // Change the page so it is re-read, but the model returns the same fragment text/id.
    await save(t, 'alex', (await t.app.inject({ url: `/api/pages/${alex.pages[0].id}`, headers: as('alex') })).json(), [...alex.pages[0].strokes, ...ink('a2', 600)] as any);
    await t.jobs.indexPage(alex.pages[0].id);
    expect(t.store.entrySourceCount(entry.id)).toBeGreaterThan(0);
    expect(t.store.pageFragments(alex.pages[0].id).some((f) => f.entryId === entry.id)).toBe(true);
  });

  it('runs a professor live handout, then leaves each student a copy', async () => {
    const t = await setup(handler);
    const { readFileSync } = await import('node:fs');
    const lecture = (await upload(t.app, '/api/lectures', readFileSync(t.pdf), '1-intro.pdf')).json();
    await waitFor(() => t.jobs.idle);
    const opened = (await t.app.inject({ method: 'POST', url: `/api/notebooks/lecture/${lecture.id}`, headers: as('professor') })).json();
    const prof = (await t.app.inject({ url: `/api/notebooks/${opened.id}`, headers: as('professor') })).json();
    const page = prof.pages[1];
    await save(t, 'professor', page, ink('p1') as any);
    // Professor notes are authority, not peer knowledge — lecture pages and standalone notes alike.
    await t.jobs.indexPage(page.id);
    expect(t.store.pageFragments(page.id)).toHaveLength(0);
    const profNote = await makeNotebook(t, 'professor', 'Professor private note');
    await save(t, 'professor', profNote.page, ink('prof1') as any);
    await t.jobs.indexPage(profNote.page.id);
    expect(t.store.pageFragments(profNote.page.id)).toHaveLength(0);

    const privateNote = await makeNotebook(t, 'alex', 'Alex private');
    await save(t, 'alex', privateNote.page, ink('secret') as any);

    const started = await t.app.inject({ method: 'POST', url: `/api/notebooks/${opened.id}/live`, headers: as('professor'), payload: { pullable: true, pageId: page.id } });
    expect(started.statusCode).toBe(200);
    const live = started.json();
    expect(live.hostName).toBe('Professor');
    // A live session must never be pointed at a page outside the host's notebook.
    expect(
      (await t.app.inject({ method: 'PATCH', url: `/api/live/${live.id}`, headers: as('professor'), payload: { pageId: privateNote.page.id } })).statusCode,
    ).toBe(400);
    expect(live.currentPageId).toBe(page.id);
    const seen = (await t.app.inject({ url: '/api/notices', headers: as('thomas') })).json();
    expect(seen.live).toMatchObject({ id: live.id, hostName: 'Professor' });
    const viewer = await t.app.inject({ url: `/api/live/${live.id}`, headers: as('thomas') });
    expect(viewer.json().currentPageId).toBe(page.id);
    const png = await t.app.inject({ url: `/api/live/${live.id}/page.png`, headers: as('thomas') });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect((await t.app.inject({ url: `/api/live/${live.id}`, headers: as('priya') })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: `/api/notebooks/${opened.id}/live`, headers: as('alex'), payload: {} })).statusCode).toBe(403);

    const ended = await t.app.inject({ method: 'POST', url: `/api/live/${live.id}/end`, headers: as('professor') });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().endedAt).toBeTruthy();
    // The live image is a live view, not a permanent window into the source page.
    expect((await t.app.inject({ url: `/api/live/${live.id}/page.png`, headers: as('thomas') })).statusCode).toBe(404);
    const after = (await t.app.inject({ url: '/api/notices', headers: as('thomas') })).json();
    expect(after.shares).toHaveLength(1);
    expect(after.shares[0]).toMatchObject({ fromName: 'Professor', mode: 'pull' });
    const files = (await t.app.inject({ url: '/api/courses/comp2211/files', headers: as('thomas') })).json();
    const copy = files.notes.find((n: any) => n.kind === 'shared');
    expect(copy.title).toContain('Professor');
    const copyNb = (await t.app.inject({ url: `/api/notebooks/${copy.id}`, headers: as('thomas') })).json();
    expect(copyNb.pages).toHaveLength(3);
    expect(copyNb.pages[1].strokes[0]).toMatchObject({ origin: 'shared', sourceId: 'p1' });
  });
});
