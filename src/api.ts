import { readMigrated } from './ui';
let student = readMigrated('notebook.student') || 'thomas';
// Images (page renders, handwriting crops) can't send headers, so the demo identity also travels as a cookie.
const syncCookie = () => {
  document.cookie = `notebook_student=${encodeURIComponent(student)}; path=/; SameSite=Strict`;
  document.cookie = 'margin_student=; path=/; Max-Age=0; SameSite=Strict';
};
syncCookie();
export const getStudent = () => student;
export const setStudent = (s: string) => {
  student = s;
  localStorage.setItem('notebook.student', s);
  syncCookie();
  reloadCourse();
};

/** Selected course is remembered per student, since enrollments differ. */
const courseKey = () => `notebook.course.${student}`;
let course = readMigrated(courseKey()) || '';
export const getCourse = () => course;
export const setCourse = (c: string) => {
  course = c;
  localStorage.setItem(courseKey(), c);
};
const reloadCourse = () => (course = readMigrated(courseKey()) || '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-student-id': student, ...(course ? { 'x-course-id': course } : {}), ...(init.headers as any) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'Cannot reach the notebook server. Check your connection.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export function upload<T = any>(path: string, file: File, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', file);
  return api<T>(path, { method: 'POST', body: fd });
}

export const uid = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
