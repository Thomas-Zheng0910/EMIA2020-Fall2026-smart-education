import sharp, { type OverlayOptions } from 'sharp';
import { join } from 'node:path';
import type { Page, Item } from '../shared/types';
import { strokePath, strokeOpacity } from '../shared/ink';
import type { Store } from './db';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function paperSvg(kind: Page['kind'], w: number, h: number) {
  const lines: string[] = [];
  if (kind === 'ruled') lines.push(`<line x1="90" x2="90" y1="0" y2="${h}" stroke="#f2b8b8" stroke-width="1.2"/>`);
  if (kind === 'ruled') for (let y = 120; y < h - 40; y += 36) lines.push(`<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="#c9d6e8" stroke-width="1.2"/>`);
  if (kind === 'grid') {
    for (let y = 30; y < h; y += 30) lines.push(`<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="#dfe5ec" stroke-width="1"/>`);
    for (let x = 30; x < w; x += 30) lines.push(`<line y1="0" y2="${h}" x1="${x}" x2="${x}" stroke="#dfe5ec" stroke-width="1"/>`);
  }
  return lines.join('');
}

function wrap(text: string, width: number, size: number) {
  const max = Math.max(4, Math.floor(width / (size * 0.52)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > max && line) {
        out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

function textSvg(it: Extract<Item, { type: 'text' }>) {
  return wrap(it.text, it.w, it.size)
    .map((l, i) => `<text x="${it.x}" y="${it.y + it.size * (i + 1) * 1.25}" font-size="${it.size}" font-family="Helvetica, Arial, sans-serif" fill="${esc(it.color)}">${esc(l)}</text>`)
    .join('');
}

/**
 * Renders a page as the student sees it: background, original ink and the student's own text/images.
 * AI-added annotations are excluded by default so generated text never re-enters the shared index.
 */
export async function renderPage(
  page: Page & { image?: string | null },
  store: Store,
  dataDir: string,
  { width = 1400, annotations = false } = {},
): Promise<Buffer> {
  const scale = width / page.width;
  const height = Math.round(page.height * scale);
  const base = page.image
    ? sharp(join(dataDir, 'assets', page.image)).resize(width, height, { fit: 'fill' })
    : sharp({ create: { width, height, channels: 3, background: '#ffffff' } });
  const overlays: OverlayOptions[] = [];
  for (const it of page.items)
    if (it.type === 'image') {
      const f = store.file(it.fileId);
      if (!f) continue;
      try {
        const buf = await sharp(f.path).resize(Math.max(1, Math.round(it.w * scale)), Math.max(1, Math.round(it.h * scale)), { fit: 'fill' }).png().toBuffer();
        overlays.push({ input: buf, left: Math.round(it.x * scale), top: Math.round(it.y * scale) });
      } catch {
        /* missing image file: skip */
      }
    }
  const svgParts = [
    page.image ? '' : paperSvg(page.kind, page.width, page.height),
    ...page.strokes.map((s) => `<path d="${strokePath(s)}" fill="${esc(s.color)}" fill-opacity="${strokeOpacity(s)}"/>`),
    ...page.items.flatMap((it) => (it.type === 'text' ? [textSvg(it)] : [])),
    ...(annotations
      ? page.items.flatMap((it) =>
          it.type === 'annotation'
            ? [`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="120" fill="#fff7d6" stroke="#e8c45c"/>` + textSvg({ ...it, type: 'text', text: it.title + '\n' + it.body, color: '#5b4a12', size: 14 } as any)]
            : [],
        )
      : []),
  ];
  overlays.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${page.width} ${page.height}">${svgParts.join('')}</svg>`),
    left: 0,
    top: 0,
  });
  return base.composite(overlays).png().toBuffer();
}

/** Crops a normalized bbox from a rendered page with a little padding. */
export async function cropPng(png: Buffer, bbox: [number, number, number, number], pad = 0.015) {
  const meta = await sharp(png).metadata();
  const W = meta.width!,
    H = meta.height!;
  const x = Math.max(0, bbox[0] - pad),
    y = Math.max(0, bbox[1] - pad);
  const x2 = Math.min(1, bbox[0] + bbox[2] + pad),
    y2 = Math.min(1, bbox[1] + bbox[3] + pad);
  const left = Math.floor(x * W),
    top = Math.floor(y * H);
  const width = Math.max(8, Math.min(W - left, Math.ceil((x2 - x) * W)));
  const height = Math.max(8, Math.min(H - top, Math.ceil((y2 - y) * H)));
  return sharp(png).extract({ left, top, width, height }).png().toBuffer();
}

export const hasOriginalContent = (p: Page) =>
  p.strokes.length > 0 || p.items.some((i) => (i.type === 'text' && i.text.trim()) || i.type === 'image');
