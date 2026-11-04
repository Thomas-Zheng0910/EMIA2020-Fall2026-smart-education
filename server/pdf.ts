import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppError } from './db';
import { PAGE_WIDTH } from '../shared/ink';

const exec = promisify(execFile);

export type RenderedPage = { page: number; width: number; height: number; image: string; text: string };

/** Renders every PDF page to PNG under assetsDir/relDir and extracts per-page text. */
export async function renderPdf(file: string, assetsDir: string, relDir: string, maxPages = 400): Promise<RenderedPage[]> {
  const out = join(assetsDir, relDir);
  await mkdir(out, { recursive: true });
  let info: string;
  try {
    info = (await exec('pdfinfo', [file], { maxBuffer: 4 << 20 })).stdout;
  } catch {
    throw new AppError(400, 'This file could not be read as a PDF.');
  }
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  if (!pages) throw new AppError(400, 'The PDF has no pages.');
  if (pages > maxPages) throw new AppError(400, `PDFs are limited to ${maxPages} pages.`);
  try {
    await exec('pdftoppm', ['-scale-to', '1600', '-png', file, join(out, 'p')], { timeout: 600_000, maxBuffer: 8 << 20 });
  } catch (e: any) {
    // Flexcil/GoodNotes exports emit recoverable syntax warnings; only fail when nothing rendered.
    if (!(await readdir(out)).some((f) => f.endsWith('.png')))
      throw new AppError(500, 'PDF rendering failed. Make sure poppler-utils (pdftoppm) is installed.');
  }
  let texts: string[] = [];
  try {
    texts = (await exec('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 64 << 20, timeout: 120_000 })).stdout.split('\f');
  } catch {
    texts = [];
  }
  const files = (await readdir(out))
    .filter((f) => /^p-\d+\.png$/.test(f))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  const result: RenderedPage[] = [];
  for (let i = 0; i < files.length; i++) {
    const name = `${i + 1}.png`;
    await rename(join(out, files[i]!), join(out, name));
    const meta = await sharp(join(out, name)).metadata();
    result.push({
      page: i + 1,
      width: PAGE_WIDTH,
      height: Math.round((PAGE_WIDTH * meta.height!) / meta.width!),
      image: `${relDir}/${name}`,
      text: (texts[i] ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000),
    });
  }
  return result;
}

export async function pngBuffer(path: string, width = 1280) {
  return sharp(await readFile(path)).resize({ width, withoutEnlargement: true }).png().toBuffer();
}
