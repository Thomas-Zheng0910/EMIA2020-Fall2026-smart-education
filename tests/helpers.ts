import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db';
import { ModelGateway } from '../server/ai';
import { buildApp } from '../server/app';
import { ensureStudents, COURSE } from '../server/seed';
import { makePdf } from './pdf';
export { makePdf };

export type Handler = (prompt: string, images: number) => unknown;

/** OpenAI-compatible fake: routes by prompt content and records calls. */
export function mockModel(handler: Handler) {
  const calls: { prompt: string; images: number }[] = [];
  const http = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const user = body.messages.find((m: any) => m.role === 'user').content;
    const prompt = typeof user === 'string' ? user : user.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    const images = typeof user === 'string' ? 0 : user.filter((p: any) => p.type === 'image_url').length;
    calls.push({ prompt, images });
    const out = handler(prompt, images);
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof out === 'string' ? out : JSON.stringify(out) } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { http, calls };
}

export async function setup(handler: Handler | null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'margin-test-'));
  const store = new Store(join(dataDir, 'db.sqlite'));
  ensureStudents(store);
  store.upsertCourse(COURSE);
  for (const s of ['thomas', 'alex', 'priya']) store.enroll(s, COURSE.id);
  const mock = handler ? mockModel(handler) : null;
  const ai = new ModelGateway(handler ? { baseUrl: 'http://mock/v1', key: 'k', model: 'mock' } : {}, mock?.http);
  const { app, jobs } = await buildApp({ store, ai, dataDir, background: false });
  await app.ready();
  const pdf = join(dataDir, 'lecture.pdf');
  writeFileSync(pdf, makePdf(['Bayes rule', 'Conditional probability', 'Naive assumption']));
  return { app, jobs, store, dataDir, calls: mock?.calls ?? [], pdf };
}

export async function upload(app: Awaited<ReturnType<typeof setup>>['app'], url: string, file: Buffer, name: string, student = 'thomas') {
  const boundary = '----notebook' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-student-id': student, 'x-course-id': 'comp2211' } });
}

export const waitFor = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
