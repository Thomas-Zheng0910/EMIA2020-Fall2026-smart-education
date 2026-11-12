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
  // A pending named share is a modal on the home page; tests that do not exercise it can put it away.
  const dialog = page.getByRole('dialog');
  const appeared = await dialog.waitFor({ state: 'visible', timeout: 700 }).then(() => true).catch(() => false);
  if (appeared) {
    const later = dialog.getByRole('button', { name: 'Later' });
    if (await later.isVisible().catch(() => false)) await later.click();
    else {
      const notNow = dialog.getByRole('button', { name: 'Not now' });
      if (await notNow.isVisible().catch(() => false)) await notNow.click();
    }
  }
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
  await page.locator('.doc-card[data-deck]', { hasText: 'Gradient' }).click();
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
  await expect(page.getByRole('dialog')).toContainText('offers the useful parts to classmates');
  await page.getByRole('button', { name: 'Join course' }).click();
  await expect(page.locator('.lib-kicker')).toContainText(code);
}

test.describe.serial('notebook workflow', () => {
  test('create a course, others join, import a lecture PDF', async ({ page }) => {
    await home(page, 'professor');
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
    for (const s of ['thomas', 'priya', 'alex']) await join(page, s, 'ML1000');
    // only the professor can add official slides
    await as(page, 'professor');
    await openedFolder(page, 'Lectures');
    await dropPdf(page, page.locator('.lib-content'), '1-gradient-descent.pdf', pdf);
    await expect(page.locator('.toast')).toContainText('Added “1-gradient-descent” to Lectures');
    const deck = page.locator('.doc-card', { hasText: 'Gradient descent' });
    await expect(deck).toBeVisible({ timeout: 20000 });
    await expect(deck.locator('.pdf-badge')).toHaveText('PDF');
    await expect(deck.locator('.doc-badge')).toHaveText('L1');
    // students can read the official deck; the professor owns publishing it
    await as(page, 'alex');
    await openedFolder(page, 'Lectures');
    await expect(page.locator('.doc-card', { hasText: 'Gradient descent' })).toBeVisible();
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
    await expect(page.locator('.inline-ghost')).toHaveCount(0);
    // Gaps are found when the page is read, which happens after the student writes.
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    // The suggestion appears inline in the page, like a completion: text plus an accept button.
    const ghost = page.locator('.page-slot').nth(1).locator('.inline-ghost');
    await expect(ghost).toBeVisible({ timeout: 60000 });
    await expect(ghost.locator('.ghost-gap')).toContainText('The step after the gradient.');
    // The card is grounded in something: a classmate's note, the slide, or the model itself.
    await expect(ghost.locator('.ghost-credit')).toHaveText(/From |AI explanation/, { timeout: 60000 });
    // One click accepts it: the text lands in the page as a quoted note and the ghost goes away.
    await page.locator('.ghost-accept-gutter').first().click();
    const note = page.locator('.page-slot').nth(1).locator('.annotation');
    await expect(note).toBeVisible();
    await expect(note.locator('.annotation-label.credit')).toHaveText(/From the slides|From a classmate’s note|AI explanation/);
    // The gap is answered, so its ghost is gone: the note on the page is the record.
    await expect(ghost).toHaveCount(0);
    // Undo takes the note back out, and the suggestion returns with it.
    await page.keyboard.press('Control+z');
    await expect(note).toHaveCount(0);
    await expect(ghost).toBeVisible({ timeout: 20000 });
    // "Full note" opens the side card, which is where a long answer and its sources live.
    await page.locator('.ghost-more').first().click();
    await page.getByRole('menuitem', { name: 'Full note' }).click();
    await expect(page.locator('.suggest-card')).toHaveCount(1);
    await page.locator('.suggest-card').first().getByRole('button', { name: 'Add beside my notes' }).click();
    await expect(note).toBeVisible();
    // Accepting is saved, not just drawn.
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('.page-slot').nth(1).locator('.annotation')).toBeVisible();
    await expect(page.locator('.page-slot').nth(1).locator('.inline-ghost')).toHaveCount(0);
  });

  test('hiding a suggestion two ways: "Not now" is temporary, Dismiss is remembered', async ({ page }) => {
    await as(page, 'thomas');
    await openLecture(page);
    await draw(page, 2);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    const ghost = page.locator('.page-slot').nth(2).locator('.inline-ghost');
    await expect(ghost).toBeVisible({ timeout: 60000 });
    // "Not now" only puts it away for this visit.
    await page.locator('.ghost-more').first().click();
    await page.getByRole('menuitem', { name: 'Not now' }).click();
    await expect(ghost).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.page-slot').nth(2).locator('.inline-ghost')).toBeVisible({ timeout: 60000 });
    // Dismiss, from the full note, is the remembered decision.
    await page.locator('.ghost-more').first().click();
    await page.getByRole('menuitem', { name: 'Full note' }).click();
    await page.locator('.suggest-card').first().getByRole('button', { name: 'Dismiss' }).click();
    await page.reload();
    await expect(page.locator('.page-slot').nth(2).locator('.inline-ghost')).toHaveCount(0, { timeout: 20000 });
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
    // A new notebook is made from the button beside "New folder".
    await page.getByRole('button', { name: '+ New notebook' }).click();
    await page.getByPlaceholder(/Revision/).fill('My revision');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.page-stage')).toHaveCount(1);
    await page.getByRole('button', { name: 'Text' }).click();
    await page.locator('.page-stage').click({ position: { x: 100, y: 150 } });
    await expect(page.locator('textarea.text-item')).toBeFocused();
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.locator('.page-stage').click({ position: { x: 100, y: 220 } });
    await expect(page.locator('.text-item')).toHaveCount(1);
    await page.locator('textarea.text-item').fill('   ');
    await page.keyboard.press('Escape');
    await expect(page.locator('.text-item')).toHaveCount(0);
    await page.locator('.page-stage').click({ position: { x: 100, y: 150 } });
    await page.keyboard.type('Gradient descent minimizes loss');
    await page.locator('.nb-title').click();
    await expect(page.locator('.text-item')).toHaveText('Gradient descent minimizes loss');
    await expect(page.locator('.save-state')).toHaveText('Saved');
    // Typed text is written on the paper: it starts inside the writing column, on a rule.
    const box = await page.locator('.text-item').boundingBox();
    const stage = await page.locator('.page-stage').first().boundingBox();
    expect(box!.x - stage!.x).toBeGreaterThan(40);
    await page.locator('.thumb-add').click();
    await expect(page.locator('.page-slot')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('.text-item')).toHaveText('Gradient descent minimizes loss');
    await expect(page.locator('.link-chip').first()).toContainText('L1', { timeout: 20000 });
    const textNote = page.locator('.text-item');
    await expect(page.getByRole('button', { name: 'Delete text note' })).toHaveCount(0);
    await textNote.click();
    await expect(textNote).toBeFocused();
    await expect(page.locator('textarea.text-item')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete text note' })).toBeVisible();
    await textNote.dblclick();
    await page.locator('textarea.text-item').fill('Gradient descent takes repeated steps');
    await page.locator('.nb-title').click();
    await expect(page.locator('.text-item')).toHaveText('Gradient descent takes repeated steps');
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(textNote).toHaveText('Gradient descent takes repeated steps');
    const beforeDrag = await textNote.evaluate((note) => ({ x: (note as HTMLElement).offsetLeft, y: (note as HTMLElement).offsetTop }));
    const textBox = (await textNote.boundingBox())!;
    await page.mouse.move(textBox.x + 24, textBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(textBox.x + 52, textBox.y + 72, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => textNote.evaluate((note) => (note as HTMLElement).offsetTop)).toBeGreaterThan(beforeDrag.y + 30);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    const moved = await textNote.evaluate((note) => ({ x: (note as HTMLElement).offsetLeft, y: (note as HTMLElement).offsetTop }));
    await page.reload();
    await expect(textNote).toHaveText('Gradient descent takes repeated steps');
    expect(await textNote.evaluate((note) => ({ x: (note as HTMLElement).offsetLeft, y: (note as HTMLElement).offsetTop }))).toEqual(moved);
    await expect(page.getByRole('button', { name: 'Delete text note' })).toHaveCount(0);
    await textNote.click();
    await page.getByRole('button', { name: 'Delete text note' }).click();
    await expect(page.locator('.text-item')).toHaveCount(0);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('.text-item')).toHaveCount(0);
  });

  test('typed text survives leaving while the box is still focused', async ({ page }) => {
    await as(page, 'priya');
    await page.getByRole('button', { name: '+ New notebook' }).click();
    await page.getByPlaceholder(/Revision/).fill('Draft text');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.page-stage')).toHaveCount(1);
    await page.getByRole('button', { name: 'Text' }).click();
    await page.locator('.page-stage').click({ position: { x: 100, y: 150 } });
    await page.keyboard.type('Leave while typing');
    // No click elsewhere to blur: going back must flush the live draft, not the empty box.
    await page.getByRole('button', { name: 'Back to course' }).click();
    await page.waitForTimeout(800);
    await page.locator('.doc-card', { hasText: 'Draft text' }).click();
    await expect(page.locator('.text-item')).toHaveText('Leave while typing');
  });

  test('a notebook keeps its paper, and a sheet can be re-papered', async ({ page }) => {
    await as(page, 'thomas');
    await page.getByRole('button', { name: '+ New notebook' }).click();
    await page.getByPlaceholder(/Revision/).fill('Grid revision');
    await page.locator('.paper-opt.paper-grid').click();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.page-stage.paper-grid')).toHaveCount(1);
    // The new sheet inherits the notebook's paper instead of falling back to ruled.
    await page.locator('.thumb-add').click();
    await expect(page.locator('.page-stage.paper-grid')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('.page-stage.paper-grid')).toHaveCount(2);
    // One sheet can be re-papered without losing what is on it.
    await page.locator('.page-slot').first().locator('.page-chrome').getByRole('button', { name: /Paper: Grid/ }).first().click();
    await page.getByRole('menuitem', { name: /Lined/ }).click();
    await expect(page.locator('.page-stage.paper-ruled')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.page-stage.paper-ruled')).toHaveCount(1);
    await expect(page.locator('.page-stage.paper-grid')).toHaveCount(1);
  });

  test('a memo is stuck onto the page, dragged, recoloured and saved', async ({ page }) => {
    await as(page, 'thomas');
    await page.getByRole('button', { name: '+ New notebook' }).click();
    await page.getByPlaceholder(/Revision/).fill('Memos on a page');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.page-stage')).toHaveCount(1);
    // A memo is an object on the note, added with its own tool — not a kind of page.
    await page.getByRole('button', { name: /Memo: stick a note/ }).click();
    await page.locator('.page-stage').click({ position: { x: 260, y: 220 } });
    await page.keyboard.type('Ask in tutorial: is the denominator always the marginal?');
    await page.locator('.editor-top').click();
    const memo = page.locator('.memo');
    await expect(memo).toHaveCount(1);
    await expect(memo).toContainText('Ask in tutorial');
    // It is the student's own writing, so it is saved like text and ink.
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('.memo')).toContainText('Ask in tutorial');
    // Dragging it moves it, and a second memo takes the next tint.
    const before = await page.locator('.memo').boundingBox();
    await page.getByRole('button', { name: /Memo: stick a note/ }).click();
    await page.mouse.move(before!.x + 40, before!.y + 16);
    await page.mouse.down();
    await page.mouse.move(before!.x + 140, before!.y + 96, { steps: 6 });
    await page.mouse.up();
    await page.locator('.page-stage').click({ position: { x: 620, y: 620 } });
    await page.keyboard.type('Second memo');
    await page.locator('.editor-top').click();
    await expect(page.locator('.memo')).toHaveCount(2);
    const classes = await page.locator('.memo').evaluateAll((els) => els.map((e) => e.className));
    expect(new Set(classes.map((c) => /tint-\w+/.exec(c)?.[0])).size).toBe(2);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('.memo')).toHaveCount(2);
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
    await as(page, 'professor');
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

  test('asking about a page works from the panel, without circling anything', async ({ page }) => {
    await as(page, 'thomas');
    await side(page, 'All files').click();
    await page.locator('.doc-card', { hasText: 'Gradient' }).click();
    await expect(page.locator('.page-stage').first()).toBeVisible();
    // Ask is reachable from the panel: no lasso, no circling first.
    await page.getByRole('button', { name: '✦ Ask' }).click();
    const box = page.locator('.ask-chat');
    await expect(box).toBeVisible();
    // The one-tap questions are offered before the first question.
    await expect(box.locator('.ask-empty .chip')).toHaveCount(3);
    await box.locator('.ask-compose-row textarea').fill('Why does gradient descent step against the gradient?');
    await box.getByRole('button', { name: 'Send question' }).click();
    // An answer arrives as a message in the conversation, with its sources, and can become a note.
    await expect(box.locator('.ask-answer').first()).toContainText('The update rule', { timeout: 30000 });
    await expect(box.locator('.ask-answer').first().locator('.cite').first()).toBeVisible();
    const before = await page.locator('.annotation').count();
    await box.locator('.ask-answer').first().getByRole('button', { name: 'Add beside my notes' }).click();
    await expect(page.locator('.annotation')).toHaveCount(before + 1);
    // History is a real session list: a new chat clears the thread, History brings it back.
    await box.getByRole('button', { name: 'History' }).click();
    await expect(box.locator('.ask-history button')).toHaveCount(1);
    await box.getByRole('button', { name: 'New chat' }).click();
    await expect(box.locator('.ask-msg')).toHaveCount(0);
    await box.getByRole('button', { name: 'History' }).click();
    await box.locator('.ask-history button').first().click();
    await expect(box.locator('.ask-msg')).toHaveCount(2);
  });

  test('the notebook browser lists every suggestion by page, with its source note', async ({ page }) => {
    // A classmate writes first on slide 1, so Priya sees a peer suggestion rather than her own note.
    await as(page, 'alex');
    await openLecture(page);
    await draw(page, 0);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Back to course' }).click();
    // Priya, on slides no earlier test has written on: an answered gap is settled for good.
    await as(page, 'priya');
    await openLecture(page);
    await draw(page, 0);
    await expect(page.locator('.page-slot').nth(0).locator('.inline-ghost')).toBeVisible({ timeout: 60000 });
    await draw(page, 2);
    await expect(page.locator('.page-slot').nth(2).locator('.inline-ghost')).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '✦ Ask' }).click();
    // Suggestions are their own tab; the notebook browser is a scope inside it.
    await page.getByRole('tab', { name: 'Suggestions' }).click();
    await page.getByRole('tab', { name: 'Whole notebook' }).click();
    const browse = page.locator('.nb-browse');
    await expect(browse).toBeVisible();
    // Grouped by page, in the notebook's order, each row saying what and from where.
    await expect(browse.locator('.nb-group')).toHaveCount(2);
    await expect(browse.locator('.nb-group-head').first()).toContainText('Slide 1');
    await expect(browse.locator('.nb-row').first()).toContainText('The step after the gradient.');
    await expect(browse.locator('.nb-row').first()).toContainText('From');
    // Opening one shows the suggestion and, when it comes from a classmate, the note behind it.
    await browse.locator('.nb-row').first().click();
    await expect(browse.locator('.nb-detail')).toBeVisible();
    // The detail shows the suggestion's own text — verbatim for a single classmate's note — and,
    // when the suggestion traces to one note, a crop of the handwriting it came from.
    await expect(browse.locator('.nb-detail')).toContainText(/Missing step|The update rule|Subtract/);
    const hasSource = await browse.locator('.nb-source img').count();
    if (hasSource) await expect(browse.locator('.nb-source img').first()).toBeVisible();
    // "Add to that page" merges it on the page it belongs to, not the one being read.
    const currentPage = await page.locator('.thumb.active .thumb-num').textContent();
    await browse.getByRole('button', { name: 'Add to that page' }).click();
    await expect(browse.locator('.nb-item')).toHaveCount(1);
    // Adding to another page is like adding a file to context: the page being read does not move.
    await expect(page.locator('.thumb.active .thumb-num')).toHaveText(currentPage!);
    await expect(page.locator('.page-slot').nth(0).locator('.annotation')).toBeVisible();
    // "Go to page" moves the notebook to that page.
    await browse.getByRole('button', { name: 'Go to page' }).first().click();
    await expect(page.locator('.panel-tabs')).toBeVisible();
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
    await page.getByRole('button', { name: '✦ Ask' }).click();
    await expect(page.locator('.panel')).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page.locator('.panel')).toHaveCount(0);
  });
  test('the inline suggestion answers the keyboard: Escape hides it and adds nothing', async ({ page }) => {
    // Last, because it writes on Priya's deck and an earlier test needs it untouched.
    await as(page, 'priya');
    await openLecture(page);
    await draw(page, 1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    const ghost = page.locator('.page-slot').nth(1).locator('.inline-ghost');
    await expect(ghost).toBeVisible({ timeout: 60000 });
    // Escape puts it away without adding anything.
    await ghost.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.page-slot').nth(1).locator('.inline-ghost')).toHaveCount(0);
    await expect(page.locator('.page-slot').nth(1).locator('.annotation')).toHaveCount(0);
    // Escape is not a judgement: the suggestion is back next time the page is opened.
    await page.reload();
    await expect(page.locator('.page-slot').nth(1).locator('.inline-ghost')).toBeVisible({ timeout: 60000 });
  });

  test('a named copy arrives, then the same note becomes a group note', async ({ page }) => {
    await as(page, 'alex');
    await page.getByRole('button', { name: '+ New notebook' }).click();
    await page.getByPlaceholder(/Revision/).fill('Share practice');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.nb-title')).toHaveValue('Share practice');
    await draw(page, 0);
    await expect(page.locator('.save-state')).toHaveText('Saved');

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const share = page.getByRole('dialog');
    await expect(share).toContainText('Send a copy');
    await share.locator('.share-person', { hasText: 'Thomas' }).click();
    await share.getByRole('button', { name: 'Send 1 copy' }).click();
    await expect(page.locator('.toast')).toContainText('Sent a pullable copy');

    // The recipient gets a named notice, opens the copy, and sees the sender's ink.
    await home(page, 'thomas');
    const notice = page.getByRole('dialog', { name: 'A note was shared with you' });
    await expect(notice).toBeVisible({ timeout: 12000 });
    await notice.getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.nb-title')).toHaveValue('Alex · Share practice');
    await expect(inkPaths(page, 0)).toHaveCount(1);
    // The copy is in the recipient's Shared with me folder.
    await page.getByRole('button', { name: 'Back to course' }).click();
    await side(page, 'Shared with me').click();
    await expect(page.locator('.doc-card', { hasText: 'Alex · Share practice' })).toBeVisible();

    // The sender's original is untouched by the copy.
    await as(page, 'alex');
    await side(page, 'All files').click();
    await page.locator('.doc-card', { hasText: 'Share practice' }).click();
    await expect(inkPaths(page, 0)).toHaveCount(1);

    // Invite the same classmate to co-edit the original note.
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const invite = page.getByRole('dialog');
    await invite.getByRole('tab', { name: 'Invite to co-edit' }).click();
    await invite.locator('.share-person', { hasText: 'Thomas' }).click();
    await invite.getByRole('button', { name: 'Invite to co-edit' }).click();
    await expect(page.locator('.toast')).toContainText('Invited 1 classmate');

    await home(page, 'thomas');
    const invitation = page.getByRole('dialog', { name: 'Co-edit invitation' });
    await expect(invitation).toBeVisible({ timeout: 12000 });
    await invitation.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.nb-title')).toHaveValue('Share practice');
    await draw(page, 0, [340, 60], [560, 150]);
    await expect(page.locator('.save-state')).toHaveText('Saved');

    // The owner sees the classmate's stroke arrive and the note reads as a group note.
    await as(page, 'alex');
    await side(page, 'All files').click();
    await expect(page.locator('.doc-card', { hasText: 'Share practice' }).locator('.group-badge')).toContainText('Group · 2');
    await page.locator('.doc-card', { hasText: 'Share practice' }).click();
    await expect(inkPaths(page, 0)).toHaveCount(2, { timeout: 10000 });
  });

  test('the professor goes live, and the class receives a pullable handout', async ({ page }) => {
    await as(page, 'professor');
    await openedFolder(page, 'Lectures');
    await page.locator('.doc-card', { hasText: 'Gradient descent' }).click();
    await expect(page.locator('.page-stage').first()).toBeVisible();
    await draw(page, 0);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const share = page.getByRole('dialog');
    await share.getByRole('tab', { name: 'Go live' }).click();
    await share.getByRole('button', { name: 'Start live' }).click();
    await expect(page.locator('.live-banner')).toContainText('Live to the class');

    // A student sees the live pill, watches the page, then gets the handout after the session.
    await home(page, 'thomas');
    const pill = page.locator('.live-pill');
    await expect(pill).toBeVisible({ timeout: 12000 });
    await pill.click();
    await expect(page.locator('.live-view')).toBeVisible();
    await expect(page.locator('.live-view img')).toBeVisible();
    await page.getByRole('button', { name: 'Close live handout' }).click();

    // The professor ends from the reopened notebook; the live banner is restored on load.
    await as(page, 'professor');
    await openedFolder(page, 'Lectures');
    await page.locator('.doc-card', { hasText: 'Gradient descent' }).click();
    await expect(page.locator('.live-banner')).toContainText('Live to the class', { timeout: 8000 });
    // End while the last stroke is still inside the autosave debounce; the handout must include it.
    await draw(page, 0, [420, 240], [620, 300]);
    await page.getByRole('button', { name: 'End live' }).click();
    await expect(page.locator('.toast')).toContainText('Live ended');

    await home(page, 'thomas');
    const notice = page.getByRole('dialog', { name: 'A note was shared with you' });
    await expect(notice).toBeVisible({ timeout: 12000 });
    await notice.getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.nb-title')).toHaveValue('Professor · L1 · Gradient descent');
    await expect(inkPaths(page, 0)).toHaveCount(2);
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
    // The suggestion arrives inline; "Full note" opens the card, which is where reporting lives.
    const ghost = page.locator('.inline-ghost').first();
    await expect(ghost).toBeVisible({ timeout: 60000 });
    await page.locator('.ghost-more').first().click();
    await page.getByRole('menuitem', { name: 'Full note' }).click();
    const card = page.locator('.suggest-card').first();
    // Wait for the card to be the classmate's note, not the slide fallback: only a peer card
    // carries an entry, and only an entry can be reported.
    await expect(card.locator('.suggest-credit')).toContainText(/From \d+ classmates?' notes?/, { timeout: 60000 });
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
