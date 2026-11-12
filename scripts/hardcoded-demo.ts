import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { ModelGateway } from '../server/ai';
import { buildApp } from '../server/app';
import { Store } from '../server/db';
import { fileLectureNotebook, importLecture } from '../server/importer';
import type { Item, Stroke, Student } from '../shared/types';

const project = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(project, 'data', 'hardcoded-demo');
const webDir = join(dataDir, 'web');
const port = Number(process.env.HARDCODED_DEMO_PORT || 4313);
const course = {
  id: 'arith101',
  code: 'ARITH101',
  name: 'Four Operations',
  description: 'One slide each for addition, subtraction, multiplication, and division.',
};
const students: Student[] = [
  { id: 'thomas', name: 'A student', initials: 'A', color: '#234699', role: 'student' },
  { id: 'alex', name: 'B student', initials: 'B', color: '#9a4c23', role: 'student' },
];
const seedNotes = JSON.parse(await readFile(join(project, 'demo', 'notes.json'), 'utf8')) as Record<
  string,
  Record<number, { strokes: Stroke[]; items: Item[] }>
>;

process.env.VITE_ARITHMETIC_DEMO = '1';
await build({ root: project, build: { outDir: join(webDir, 'dist'), emptyOutDir: true } });
process.chdir(webDir);

const store = new Store(join(dataDir, 'notebook.sqlite'));
const { app, jobs } = await buildApp({ store, ai: new ModelGateway({}), dataDir, background: false });
try {
  store.upsertCourse(course);
  for (const student of students) {
    store.upsertStudent(student);
    if (!store.isEnrolled(student.id, course.id)) store.enroll(student.id, course.id);
  }

  const lectureId = store.lectures(course.id).find((lecture) => lecture.status === 'ready')?.id
    ?? await importLecture(store, jobs, dataDir, course.id, join(project, 'demo', 'four-operations.pdf'), 'four-operations.pdf', {
      number: 1,
      title: 'Four Operations',
    });
  const slides = store.slides(lectureId);
  store.tx(() => {
    for (const student of students) {
      if (store.lectureNotebook(student.id, lectureId)) continue;
      const notebookId = fileLectureNotebook(store, student.id, lectureId, {
        folderId: store.lecturesFolder(course.id, student.id),
      });
      for (const slide of slides) {
        const pageId = store.addPage({
          notebookId,
          position: slide.page,
          kind: 'slide',
          slideId: slide.id,
          width: slide.width,
          height: slide.height,
          link: { lectureId, slideId: slide.id, confidence: 1, confirmed: true },
        });
        const note = seedNotes[student.id]?.[slide.page];
        if (note) store.run('UPDATE pages SET strokes=?, items=? WHERE id=?', JSON.stringify(note.strokes), JSON.stringify(note.items), pageId);
      }
    }
  });

  await app.listen({ host: '127.0.0.1', port });
  console.log(`Hardcoded Demo at http://localhost:${port}/#course=arith101&view=all`);
} catch (error) {
  await app.close();
  store.close();
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}
