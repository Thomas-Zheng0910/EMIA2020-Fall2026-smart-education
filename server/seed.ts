import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './db';
import type { Student } from '../shared/types';

export const COURSE = {
  id: 'comp2211',
  code: 'COMP2211',
  name: 'Exploring Artificial Intelligence',
  description: 'HKUST · Python for AI, Naive Bayes, KNN, K-means, perceptrons, MLPs, image processing, CNNs, minimax and AI ethics.',
};
export const PROFESSOR_ID = 'professor';
export const STUDENTS: Student[] = [
  { id: 'thomas', name: 'Thomas', initials: 'T', color: '#2f6fed', role: 'student' },
  { id: 'alex', name: 'Alex', initials: 'A', color: '#d9480f', role: 'student' },
  { id: 'priya', name: 'Priya', initials: 'P', color: '#2b8a3e', role: 'student' },
  // Demo identity only: no password, no authentication. The professor can create courses and go live.
  { id: PROFESSOR_ID, name: 'Professor', initials: 'P', color: '#6b4e8e', role: 'professor' },
];

/** Display titles for the COMP2211 Flexcil export (file names are lossy). */
export const TITLES: Record<number, string> = {
  0: 'Course logistics',
  1: 'Introduction to AI',
  2: 'Advanced Python for AI',
  3: 'Naive Bayes',
  4: 'K-Nearest Neighbors',
  5: 'K-Means Clustering',
  6: 'ANN: Perceptron',
  7: 'ANN: Multilayer Perceptron',
  8: 'Image Processing Fundamentals',
  9: 'Convolutional Neural Networks',
  10: 'Minimax',
  11: 'AI Ethics',
  12: 'Supplement: Model Evaluation',
};

/** Demo identities; also migrates single-course databases from before enrollments existed. */
export function ensureStudents(store: Store) {
  for (const s of STUDENTS) store.upsertStudent(s);
  const enrolled = store.db.prepare('SELECT COUNT(*) n FROM enrollments').get() as { n: number };
  if (!enrolled.n) for (const c of store.courses()) for (const s of STUDENTS.filter((x) => x.role === 'student')) store.enroll(s.id, c.id);
  // Existing databases get the professor on every course, as the instructor, without changing
  // students' existing enrollments. A professor who left/rejoined as a student is repaired here.
  for (const c of store.courses()) {
    if (!store.isEnrolled(PROFESSOR_ID, c.id)) store.enroll(PROFESSOR_ID, c.id, 'instructor');
    else store.ensureInstructorForCourse(PROFESSOR_ID, c.id);
  }
  // Every existing enrollment gets the tree a course starts with (idempotent, additive).
  for (const s of STUDENTS) for (const cid of store.enrolledCourseIds(s.id)) store.seedCourseFolders(cid, s.id);
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** CLI: npm run seed -- <Flexcil zip or folder of PDFs> */
async function main() {
  const { ModelGateway, envConfig } = await import('./ai');
  const { Jobs } = await import('./jobs');
  const { importLecture, importNotebookPdf } = await import('./importer');
  const src = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  if (!src) throw new Error('Usage: npm run seed -- <zip-or-folder> [--code COMP2211] [--name "Course name"] [--description "..."]');
  const code = arg('code') ?? COURSE.code;
  const course =
    code === COURSE.code
      ? COURSE
      : { id: code.toLowerCase().replace(/[^a-z0-9]+/g, '-'), code, name: arg('name') ?? code, description: arg('description') ?? '' };
  let dir = resolve(src);
  if (statSync(dir).isFile()) {
    dir = mkdtempSync(join(tmpdir(), 'margin-seed-'));
    // Python's zipfile tolerates the absolute entry names in Flexcil exports.
    execFileSync('python3', [
      '-c',
      `import zipfile,sys,os\nz=zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist():\n  n=os.path.basename(i.filename)\n  if n.lower().endswith('.pdf'): open(os.path.join(sys.argv[2],n),'wb').write(z.read(i))`,
      resolve(src),
      dir,
    ]);
  }
  const dataDir = resolve(process.env.DATA_DIR || 'data');
  const store = new Store(join(dataDir, 'notebook.sqlite'));
  ensureStudents(store);
  store.upsertCourse(course);
  store.enroll(PROFESSOR_ID, course.id, 'instructor');
  for (const s of STUDENTS.filter((x) => x.role === 'student')) {
    store.enroll(s.id, course.id);
  }
  const ai = new ModelGateway(envConfig());
  if (!ai.configured) console.warn('AI is not configured: slides import without digests and notes are not indexed.');
  const jobs = new Jobs(store, ai, dataDir, { indexDelayMs: 0, background: true });
  const have = new Set(store.lectures(course.id).map((l) => l.number));
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  for (const f of files.sort((a, b) => (parseInt(a) || 99) - (parseInt(b) || 99))) {
    let meta: { number?: number; title?: string } | null = null;
    const isComp2211 = course.id === COURSE.id;
    if (/^\d+[-_ ]/.test(f)) meta = { title: isComp2211 ? TITLES[parseInt(f)] : undefined };
    else if (isComp2211 && /^supp-model-evaluation/i.test(f)) meta = { number: 12, title: TITLES[12] };
    if (!meta) continue;
    const n = meta.number ?? parseInt(f);
    if (have.has(n)) continue;
    console.log(`Importing lecture ${n}: ${f}`);
    await importLecture(store, jobs, dataDir, course.id, join(dir, f), f, meta);
  }
  const notes = files.find((f) => /notes\.pdf$/i.test(f));
  const alexHas = store.notebooks(course.id, 'alex').some((n) => n.kind === 'pdf');
  if (notes && !alexHas) {
    console.log(`Importing ${notes} as Alex's handwritten notebook`);
    await importNotebookPdf(store, jobs, dataDir, course.id, 'alex', join(dir, notes), basename(notes), `Alex's ${course.code} notes`);
  }
  const tick = setInterval(() => {
    const ls = store.lectures(course.id);
    const digested = ls.reduce((a, l) => a + l.digested, 0);
    const total = ls.reduce((a, l) => a + l.pageCount, 0);
    const q = store.db.prepare(`SELECT indexStatus s, COUNT(*) n FROM pages GROUP BY indexStatus`).all() as any[];
    console.log(`digested ${digested}/${total} slides · pages ${q.map((r) => `${r.s}:${r.n}`).join(' ')}`);
  }, 15000);
  while (!jobs.idle) await new Promise((r) => setTimeout(r, 1000));
  clearInterval(tick);
  console.log('Seed complete.');
  store.close();
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
