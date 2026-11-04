import { test, expect, type Page } from '@playwright/test';
import { makePdf } from '../tests/pdf';

const pdf = makePdf(['Gradient descent', 'Update rule', 'Learning rate']);

/** Signs in as a demo student on the home page (all courses), then opens a course. */
async function home(page: Page, student: string) {
  await page.goto('/');
  await page.evaluate((s) => localStorage.setItem('notebook.student', s), student);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My courses' })).toBeVisible();
}
async function as(page: Page, student: string, code = 'ML1000') {
  await home(page, student);
  await page.locator('.course-card', { hasText: code }).click();
  await expect(page.locator('.lib-kicker')).toContainText(code);
}
/** A row of the course tree in the sidebar (a smart view, or a folder once the tree has loaded). */
const side = (page: Page, name: 'My notes' | 'All files' | string) => page.locator('.side-row', { hasText: name }).first();
const folderTile = (page: Page, name: string) => page.locator('.folder-tile', { hasText: name });
/** The course's own Lectures folder, where the official decks live. */
async function openedFolder(page: Page, name: string) {
  await folderTile(page, name).first().click();
  await expect(page.locator('.lib-title')).toHaveText(name);
}
/** Opens a folder from the tree, which works from any view (a smart view shows no folder tiles). */
async function openFolder(page: Page, name: string) {
  await side(page, name).click();
  await expect(page.locator('.lib-title')).toHaveText(name);
}
/** Decks are shared records: opening one builds the student's own pages the first time. */
async function openLecture(page: Page) {
  await side(page, 'All files').click();
  await page.locator('.doc-card', { hasText: 'Gradient' }).click();
  await expect(page.locator('.page-stage').first()).toBeVisible();
}
/** PDFs are added by dragging them in (no import buttons). */
async function dropPdf(page: Page, target: ReturnType<Page['locator']>, name: string, buf: Buffer) {
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const d = new DataTransfer();
      d.items.add(new File([bytes], name, { type: 'application/pdf' }));
      return d;
    },
    { b64: buf.toString('base64'), name },
  );
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}
/** Long-press on a tablet, right-click with a mouse: same menu. */
async function menu(page: Page, target: ReturnType<Page['locator']>, item: string) {
  await target.click({ button: 'right' });
  await page.locator('.lib-menu').getByRole('menuitem', { name: item }).click();
}
async function draw(page: Page, slot: number, from = [60, 60], to = [300, 140]) {
  const stage = page.locator('.page-slot').nth(slot).locator('.page-stage');
  await stage.scrollIntoViewIfNeeded();
  const b = (await stage.boundingBox())!;
  await page.mouse.move(b.x + from[0]!, b.y + from[1]!);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + from[0]! + ((to[0]! - from[0]!) * i) / 12, b.y + from[1]! + ((to[1]! - from[1]!) * i) / 12);
  await page.mouse.up();
}
const inkPaths = (page: Page, slot: number) => page.locator('.page-slot').nth(slot).locator('svg.ink path.stroke');

async function join(page: Page, student: string, code: string) {
  await home(page, student);
  await page.locator('.course-card', { hasText: code }).getByRole('button', { name: 'Join' }).click();
  // joining explains automatic sharing before the student commits
  await expect(page.getByRole('dialog')).toContainText('shares the useful parts with classmates');
  await page.getByRole('button', { name: 'Join course' }).click();
  await expect(page.locator('.lib-kicker')).toContainText(code);
}

test.describe.serial('notebook workflow', () => {
  test('create a course, others join, import a lecture PDF', async ({ page }) => {
    await home(page, 'alex');
    await expect(page.locator('.empty-lectures')).toContainText('haven’t joined');
    await page.getByRole('button', { name: '+ New course' }).click();
    await page.getByPlaceholder(/Code/).fill('ML1000');
    await page.getByPlaceholder(/Name/).fill('Machine Learning Basics');
    await page.getByRole('button', { name: 'Create course' }).click();
    await expect(page.locator('.lib-title')).toHaveText('Machine Learning Basics');
    // A course starts with two ordinary folders, not fixed places: they can be renamed or deleted.
    await expect(folderTile(page, 'Lectures')).toBeVisible();
    await expect(folderTile(page, 'Quizzes')).toBeVisible();
    await openedFolder(page, 'Lectures');
    await expect(page.locator('.lib-empty')).toContainText('This folder is empty');
    for (const s of ['thomas', 'priya']) await join(page, s, 'ML1000');
    await as(page, 'alex');
    // dropping a PDF onto the Lectures folder adds a lecture for the whole course
    await openedFolder(page, 'Lectures');
    await dropPdf(page, page.locator('.lib-content'), '1-gradient-descent.pdf', pdf);
    await expect(page.locator('.toast')).toContainText('Added “1-gradient-descent” to Lectures');
    const deck = page.locator('.doc-card', { hasText: 'Gradient descent' });
    await expect(deck).toBeVisible({ timeout: 20000 });
    await expect(deck.locator('.pdf-badge')).toHaveText('PDF');
    await expect(deck.locator('.doc-badge')).toHaveText('L1');
  });

  test('ink persists, undo works, and a deck keeps its badge wherever it is filed', async ({ page }) => {
    await as(page, 'alex');
    await openLecture(page);
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await expect(inkPaths(page, 1)).toHaveCount(1);
    await draw(page, 1, [80, 200], [320, 220]);
    await expect(inkPaths(page, 1)).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect(inkPaths(page, 1)).toHaveCount(1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(inkPaths(page, 1)).toHaveCount(1);
    await expect(page.locator('.page-slot').nth(1).locator('.index-chip.ok')).toHaveText(/Shared 1 note/, { timeout: 20000 });
    // back returns where the deck was opened; writing on it shows the ✎ count on the deck itself
    await page.getByRole('button', { name: 'Back to course' }).click();
    const deck = () => page.locator('.doc-card', { hasText: 'Gradient descent' });
    await expect(deck()).toContainText('you wrote on 1');
    await expect(deck().locator('.ink-badge')).toHaveText('✎ 1');
    // the same file in "My notes": writing on a deck adds it there
    await side(page, 'My notes').click();
    await expect(deck()).toContainText('you wrote on 1');
    // filing the deck in another folder keeps its number, its PDF badge and the count
    await side(page, 'All files').click();
    await menu(page, deck(), 'Move to…');
    await page.locator('.lib-menu').getByRole('menuitem', { name: 'Quizzes' }).click();
    await expect(page.locator('.toast')).toHaveText('Moved to Quizzes');
    // "All files" is the whole tree flattened, so the file stays listed wherever it is filed...
    await expect(deck()).toHaveCount(1);
    // ...while the Lectures folder no longer holds it
    await expect(side(page, 'Lectures')).not.toContainText('1');
    await expect(side(page, 'Quizzes')).toContainText('1');
    await openFolder(page, 'Quizzes');
    await expect(deck().locator('.doc-badge')).toHaveText('L1');
    await expect(deck().locator('.pdf-badge')).toHaveText('PDF');
    await expect(deck().locator('.ink-badge')).toHaveText('✎ 1');
  });

  test('a classmate finds the gap quietly, inline, and can add or undo it', async ({ page }) => {
    await as(page, 'thomas');
    await openLecture(page);
    // Quiet by default: no panel, no badge on the page — just ink.
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(page.locator('.gap-marker')).toHaveCount(0);
    // Gaps are found when the page is read, which happens after the student writes.
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    // Re-reading on open is what lets Alex's note replace the slide as the source of this gap.
    await expect
      .poll(async () => page.locator('.page-slot').nth(1).locator('.gap-marker.peer').count(), { timeout: 60000 })
      .toBe(1);
    const marker = page.locator('.page-slot').nth(1).locator('.gap-marker');
    await expect(page.locator('.page-slot').nth(0).locator('.gap-marker')).toHaveCount(0);
    // Tapping it opens the card in place: a classmate's note, with the handwriting available.
    await marker.click();
    const card = page.locator('.suggest-card').first();
    await expect(card.locator('.suggest-src')).toHaveText("From 1 classmate's note");
    await expect(card).toContainText('The update rule');
    await card.getByRole('button', { name: 'Add to my notes' }).click();
    const note = page.locator('.page-slot').nth(1).locator('.annotation');
    await expect(note).toContainText('From a classmate’s note');
    await page.keyboard.press('Control+z');
    await expect(note).toHaveCount(0);
    // Dismissing is remembered: the marker does not come back for this student.
    await marker.click();
    await page.locator('.suggest-card').first().getByRole('button', { name: 'Dismiss' }).click();
    await page.reload();
    await expect(page.locator('.page-slot').nth(1).locator('.gap-marker')).toHaveCount(0, { timeout: 20000 });
  });

  test('lasso → a popover beside the selection answers in place', async ({ page }) => {
    await as(page, 'thomas');
    await openLecture(page);
    await page.getByRole('button', { name: 'Lasso' }).click();
    const stage = page.locator('.page-slot').nth(1).locator('.page-stage');
    await stage.scrollIntoViewIfNeeded();
    const b = (await stage.boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + 20);
    await page.mouse.down();
    for (const [x, y] of [[400, 20], [400, 250], [20, 250], [20, 25]]) await page.mouse.move(b.x + x!, b.y + y!, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: '✦ Explain' }).click();
    // The answer appears in the popover, not in a panel that replaces the page.
    const pop = page.locator('.lasso-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('The update rule');
    await expect(pop.locator('.suggest-src')).toHaveText('From a classmate’s note');
    await pop.locator('.cite-slide').first().click();
    await expect(page.locator('.modal.source')).toContainText('Official course slide');
    await page.keyboard.press('Escape');
    // "Explain / Example / Why?" are chips beside the selection.
    for (const chip of ['Explain', 'Example', 'Why?']) await expect(page.locator('.lasso-pop .chip', { hasText: chip })).toBeVisible();
  });

  test('blank notebook with typed text and inserted pages', async ({ page }) => {
    await as(page, 'priya');
    // a new notebook is made from the tree's background menu, not from a button
    await menu(page, page.locator('.lib-content'), 'New notebook');
    await page.getByPlaceholder(/Revision/).fill('My revision');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.page-stage')).toHaveCount(1);
    await page.getByRole('button', { name: 'Text' }).click();
    await page.locator('.page-stage').click({ position: { x: 100, y: 150 } });
    await page.keyboard.type('Gradient descent minimizes loss');
    await page.locator('.nb-title').click();
    await expect(page.locator('.text-item')).toHaveText('Gradient descent minimizes loss');
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.getByRole('button', { name: '+ Add page' }).click();
    await expect(page.locator('.page-slot')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('.text-item')).toHaveText('Gradient descent minimizes loss');
    await expect(page.locator('.link-chip').first()).toContainText('L1', { timeout: 20000 });
  });

  test('the file tree: create, file by menu or drag, rename, delete', async ({ page }) => {
    await as(page, 'priya');
    await side(page, 'All files').click();
    await expect(page.locator('.doc-card', { hasText: 'My revision' })).toBeVisible();
    // a folder is created in place and opened
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.locator('.side-input').fill('Midterm');
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-title')).toHaveText('Midterm');
    await expect(page.locator('#lib-crumb-slot')).toContainText('ML1000/Midterm');
    await expect(page.locator('.lib-empty')).toContainText('This folder is empty');
    // a subfolder via the folder's menu
    await menu(page, side(page, 'Midterm'), 'New folder inside');
    await page.locator('.side-input').fill('Week 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-title')).toHaveText('Week 1');
    // Move to… files a note without dragging
    await side(page, 'All files').click();
    await menu(page, page.locator('.doc-card', { hasText: 'My revision' }), 'Move to…');
    await page.locator('.lib-menu').getByRole('menuitem', { name: 'Week 1' }).click();
    await expect(page.locator('.toast')).toHaveText('Moved to Week 1');
    // "All files" flattens the tree, so the note is still listed; only its folder changed
    await expect(page.locator('.doc-card', { hasText: 'My revision' })).toHaveCount(1);
    // opening the folder it moved into shows it there
    await openFolder(page, 'Week 1');
    await expect(page.locator('.doc-card', { hasText: 'My revision' })).toHaveCount(1);
    // drag it back out to the top of the tree
    const card = page.locator('.doc-card', { hasText: 'My revision' });
    const from = (await card.boundingBox())!;
    const to = (await page.locator('.side-course', { hasText: 'ML1000' }).boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + 60);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + 40 + ((to.x + 40 - from.x - 40) * i) / 10, from.y + 60 + ((to.y + 12 - from.y - 60) * i) / 10);
    await expect(page.locator('.side-course', { hasText: 'ML1000' })).toHaveClass(/drop-ok/);
    await page.mouse.up();
    await expect(page.locator('.toast')).toHaveText('Moved to the top level');
    await expect(page.locator('.lib-title')).toHaveText('Week 1'); // dropping does not open the note
    // rename, then delete: files and subfolders move up, nothing is lost
    await menu(page, side(page, 'Midterm'), 'Rename');
    await page.locator('.side-input').fill('Exam prep');
    await page.keyboard.press('Enter');
    await expect(side(page, 'Exam prep')).toBeVisible();
    await menu(page, side(page, 'Exam prep'), 'Delete folder');
    await expect(page.locator('.toast')).toContainText('Deleted “Exam prep”');
    // Week 1 moved up to the top level, which is where the course page shows folder tiles
    await openFolder(page, 'Week 1');
    await expect(page.locator('.lib-title')).toHaveText('Week 1');
    await side(page, 'All files').click();
    await expect(page.locator('.doc-card', { hasText: 'My revision' })).toBeVisible();
    await page.locator('.side-course', { hasText: 'ML1000' }).click();
    await expect(folderTile(page, 'Week 1')).toBeVisible();
    // a notes PDF dropped onto an ordinary folder becomes a notebook in it
    await dropPdf(page, folderTile(page, 'Week 1'), 'scan.pdf', pdf);
    await expect(page.locator('.toast')).toContainText('Added “scan” to Week 1');
    await folderTile(page, 'Week 1').click();
    await expect(page.locator('.doc-card', { hasText: 'scan' })).toBeVisible();
    // folders are private: another student does not see them
    await as(page, 'thomas');
    await expect(side(page, 'Week 1')).toHaveCount(0);
    await expect(folderTile(page, 'Week 1')).toHaveCount(0);
  });

  test('opening a deck later does not duplicate it in the tree', async ({ page }) => {
    await as(page, 'priya');
    // Alex's ink is hers alone: Priya's deck is unopened, filed by the course, with no ✎ count
    await openedFolder(page, 'Lectures');
    const deck = page.locator('.doc-card', { hasText: 'Gradient descent' });
    await expect(deck.locator('.ink-badge')).toHaveCount(0);
    await deck.click();
    await expect(page.locator('.page-stage').first()).toBeVisible();
    await page.getByRole('button', { name: 'Back to course' }).click();
    // back on the folder it was opened from: one file, still in the Lectures folder
    await expect(page.locator('.lib-title')).toHaveText('Lectures');
    await expect(page.locator('.doc-card', { hasText: 'Gradient descent' })).toHaveCount(1);
    await side(page, 'All files').click();
    await expect(page.locator('.doc-card', { hasText: 'Gradient descent' })).toHaveCount(1);
  });

  test('front page lists all my courses; each course is its own page', async ({ page }) => {
    await as(page, 'thomas');
    await page.getByRole('button', { name: 'All courses' }).click();
    await page.getByRole('button', { name: '+ New course' }).click();
    await page.getByPlaceholder(/Code/).fill('HIST200');
    await page.getByPlaceholder(/Name/).fill('Modern History');
    await page.getByRole('button', { name: 'Create course' }).click();
    await expect(page.locator('.lib-title')).toHaveText('Modern History');
    await expect(page.locator('#lib-crumb-slot')).toContainText('HIST200');
    // both courses are in the sidebar; a course is joined, not created as a folder
    await expect(page.locator('.side-course')).toHaveCount(2);
    await openedFolder(page, 'Lectures');
    await expect(page.locator('.doc-card')).toHaveCount(0);
    await menu(page, page.locator('.lib-content'), 'New notebook');
    await page.getByPlaceholder(/Revision/).fill('Essay plan');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.nb-title')).toHaveValue('Essay plan');
    // back from a notebook returns to where it was opened, not the front page
    await page.getByRole('button', { name: 'Back to course' }).click();
    await expect(page.locator('.lib-title')).toHaveText('Lectures');
    await expect(page.locator('#lib-crumb-slot')).toContainText('HIST200');
    // front page shows both courses with their own counts
    await page.getByRole('button', { name: 'All courses' }).click();
    const ml = page.locator('.course-card', { hasText: 'ML1000' });
    const hist = page.locator('.course-card', { hasText: 'HIST200' });
    await expect(ml).toContainText('1 lecture');
    await expect(hist).toContainText('0 lectures · 1 notebook');
    await ml.click();
    await side(page, 'All files').click();
    await expect(page.locator('.doc-card', { hasText: 'Essay plan' })).toHaveCount(0);
    // the tree is a real URL: opening a folder and reloading stays there
    await openFolder(page, 'Quizzes');
    await page.reload();
    await expect(page.locator('.lib-title')).toHaveText('Quizzes');
    await expect(page.locator('#lib-crumb-slot')).toContainText('ML1000/Quizzes');
  });

  test('works at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await as(page, 'thomas');
    // the sidebar slides over on narrow screens
    await expect(page.locator('.lib-side')).not.toBeInViewport();
    await page.getByRole('button', { name: 'Courses and files' }).click();
    await expect(page.locator('.lib-side')).toBeInViewport();
    await side(page, 'All files').click();
    await expect(page.locator('.lib-side')).not.toBeInViewport();
    await page.locator('.doc-card', { hasText: 'Gradient' }).click();
    await expect(page.locator('.page-stage').first()).toBeVisible();
    await page.getByRole('button', { name: '✦ Study' }).click();
    await expect(page.locator('.panel')).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page.locator('.panel')).toHaveCount(0);
  });
  test('a note judged wrong is hidden from classmates and explained to its author', async ({ page, request }) => {
    await as(page, 'thomas');
    await openLecture(page);
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    // Leaving the notebook is what merges its notes for classmates.
    await page.getByRole('button', { name: 'Back to course' }).click();
    await expect.poll(async () => (await request.get('/api/notebooks?course=1')).status(), { timeout: 30000 }).toBeLessThan(500);
    // A classmate finds the suggestion on the same slide and says it looks wrong.
    await as(page, 'priya');
    await openLecture(page);
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await expect.poll(async () => page.locator('.gap-marker').count(), { timeout: 60000 }).toBeGreaterThan(0);
    await page.locator('.gap-marker').first().click();
    const card = page.locator('.suggest-card').first();
    // Wait for the card to be the classmate's note, not the slide fallback: only a peer card
    // carries an entry, and only an entry can be reported.
    await expect(card.locator('.suggest-src')).toContainText(/From \d+ classmates?' notes?/, { timeout: 60000 });
    await card.getByRole('button', { name: 'More actions' }).click();
    await page.locator('.suggest-menu').getByRole('menuitem', { name: 'Looks wrong' }).click();
    // The author sees an amber marker and, in the panel, the reason — nobody else sees a flag.
    await as(page, 'thomas');
    await openLecture(page);
    await expect.poll(async () => page.locator('.gap-marker.disputed').count(), { timeout: 60000 }).toBe(1);
    await page.locator('.gap-marker.disputed').click();
    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('.mine-item.disputed')).toContainText('contradicts the slide');
  });

});
