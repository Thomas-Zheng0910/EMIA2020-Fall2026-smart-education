import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const shot = async (p, n) => p.screenshot({ path: `/tmp/opencode/rv/${n}.png` });
const ctx = async (w, h, student = 'thomas') => {
  const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: w < 1000 });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('http://127.0.0.1:5173/'); await p.evaluate((s) => localStorage.setItem('notebook.student', s), student); await p.reload();
  await p.waitForSelector('.course-card'); await p.waitForTimeout(600);
  return p;
};
// desktop
let p = await ctx(1440, 900);
await p.locator('.course-card').first().click(); await p.waitForSelector('.lecture-card'); await p.waitForTimeout(800);
await p.mouse.wheel(0, 700); await p.waitForTimeout(500); await shot(p, 'd-course-scrolled');
await p.mouse.wheel(0, -700);
await p.getByRole('button', { name: '+ New notebook' }).click(); await p.waitForTimeout(300); await shot(p, 'd-newnb'); await p.keyboard.press('Escape'); await p.getByRole('button', { name: 'Cancel' }).click();
await p.locator('.lecture-card', { hasText: 'Naive Bayes' }).click(); await p.waitForSelector('.page-stage'); await p.waitForTimeout(1500);
await shot(p, 'd-editor-first');
await p.locator('.thumb').nth(13).click(); await p.waitForTimeout(1500); await shot(p, 'd-editor-slide14');
await p.locator('.page-slot').nth(13).locator('.page-menu button').click(); await p.waitForTimeout(200); await shot(p, 'd-pagemenu'); await p.keyboard.press('Escape');
await p.getByRole('tab', { name: 'Explain' }).click(); await p.waitForTimeout(300); await shot(p, 'd-explain-empty');
await p.getByRole('tab', { name: 'Quiz me' }).click(); await p.waitForTimeout(300); await shot(p, 'd-quiz-empty');
await p.getByRole('tab', { name: 'Classmates' }).click(); await p.waitForTimeout(1200);
await p.locator('.peer-card').first().getByRole('button', { name: 'Source' }).click().catch(() => {}); await p.waitForTimeout(800); await shot(p, 'd-source-peer'); await p.keyboard.press('Escape');
await p.getByRole('button', { name: 'Highlighter' }).click(); await p.waitForTimeout(200); await shot(p, 'd-toolbar-hl');
await p.getByRole('button', { name: 'Toggle page thumbnails' }).click(); await p.waitForTimeout(300); await shot(p, 'd-nothumbs');
await p.close();
// alex sees own notebook
p = await ctx(1440, 900, 'alex');
await p.locator('.course-card').first().click(); await p.waitForSelector('.nb-card'); await p.locator('.nb-card').first().click();
await p.waitForSelector('.page-stage'); await p.waitForTimeout(2000); await shot(p, 'd-alex-notebook');
await p.locator('.mine summary').click().catch(() => {}); await p.waitForTimeout(800); await shot(p, 'd-alex-mine');
await p.close();
// tablet
p = await ctx(820, 1180);
await shot(p, 't-home');
await p.locator('.course-card').first().click(); await p.waitForSelector('.lecture-card'); await p.waitForTimeout(600); await shot(p, 't-course');
await p.locator('.lecture-card', { hasText: 'Naive Bayes' }).click(); await p.waitForSelector('.page-stage'); await p.waitForTimeout(1500); await shot(p, 't-editor');
await p.getByRole('button', { name: '✦ Study' }).click(); await p.waitForTimeout(1200); await shot(p, 't-panel');
await p.close();
// phone
p = await ctx(390, 844);
await shot(p, 'p-home');
await p.locator('.course-card').first().click(); await p.waitForSelector('.lecture-card'); await p.waitForTimeout(600); await shot(p, 'p-course');
await p.locator('.lecture-card', { hasText: 'Naive Bayes' }).click(); await p.waitForSelector('.page-stage'); await p.waitForTimeout(1500); await shot(p, 'p-editor');
await p.getByRole('button', { name: '✦ Study' }).click(); await p.waitForTimeout(1200); await shot(p, 'p-panel');
await p.close();
await b.close();
