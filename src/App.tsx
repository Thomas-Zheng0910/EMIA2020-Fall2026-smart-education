import { useCallback, useEffect, useState } from 'react';
import type { Bootstrap } from '../shared/types';
import { api, getCourse, getStudent, setCourse, setStudent } from './api';
import { BootContext } from './boot';
import { Library } from './Library';
import { Home } from './Home';
import { Editor } from './editor/Editor';
import { NoticeCenter } from './NoticeCenter';
import { lastLibrary, lastPage } from './ui';

/**
 * Routes: `#` home (all courses) · `#course=<id>` a course's file tree · `&folder=<id>` one folder in it
 * · `&view=notes|all` a smart view · `#nb=<id>` a notebook.
 */
export type LibView = 'course' | 'notes' | 'all' | 'folder';
type Route = { course: string | null; nb: string | null; view: LibView; folder: string | null };
const parse = (): Route => {
  const q = new URLSearchParams(location.hash.slice(1));
  const v = q.get('view');
  const folder = q.get('folder');
  const view: LibView = v === 'notes' || v === 'all' ? v : folder ? 'folder' : 'course';
  return { course: q.get('course'), nb: q.get('nb'), view, folder: view === 'folder' ? folder : null };
};
const toHash = (r: Route) => {
  if (r.nb) return `nb=${r.nb}`;
  if (!r.course) return '';
  const q = new URLSearchParams({ course: r.course });
  if (r.view === 'notes' || r.view === 'all') q.set('view', r.view);
  if (r.view === 'folder' && r.folder) q.set('folder', r.folder);
  return q.toString();
};

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootFor, setBootFor] = useState<string>(''); // course header the current bootstrap was fetched with
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parse);
  const [student, setStudentState] = useState(getStudent());
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(() => {
    const requested = getCourse();
    api<Bootstrap>('/api/bootstrap')
      .then((b) => (setBoot(b), setBootFor(requested), setError(null)))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (route.course) setCourse(route.course);
    reload();
  }, [route.course, route.nb, student, reload]);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const go = (next: Partial<Route>) => {
    const r: Route = { course: next.course ?? null, nb: next.nb ?? null, view: next.view ?? 'course', folder: next.folder ?? null };
    location.hash = toHash(r);
    setRoute(r);
  };
  // Remember where in the course the student was, so leaving a notebook returns there.
  useEffect(() => {
    if (route.course && !route.nb) lastLibrary.set(route.course, toHash(route));
  }, [route]);
  const backToCourse = (courseId?: string) => {
    const saved = courseId ? lastLibrary.get(courseId) : null;
    if (saved) {
      location.hash = saved;
      setRoute(parse());
    } else go({ course: courseId ?? null });
  };
  const selectCourse = useCallback(
    (id: string) => {
      if (id === getCourse() && boot?.course?.id === id) return;
      setCourse(id);
      reload();
    },
    [boot?.course?.id, reload],
  );
  const switchStudent = (id: string) => {
    setStudent(id);
    setStudentState(id);
    go({});
  };

  // A course link the student isn't enrolled in goes back home instead of showing another course.
  useEffect(() => {
    if (boot && route.course && !route.nb && bootFor === route.course && !boot.enrolled.includes(route.course)) {
      setToast('Join that course first to open it.');
      go({});
    }
  }, [boot, bootFor, route.course, route.nb]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !boot)
    return (
      <div className="center-message">
        <p>{error}</p>
        <button className="btn" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!boot) return <div className="center-message">Loading…</div>;
  const me = boot.students.find((s) => s.id === student) ?? boot.students[0];
  const inCourse = route.course && boot.course?.id === route.course ? boot.course : null;
  return (
    <BootContext.Provider value={{ ...boot, reload, selectCourse }}>
      <div className="app">
        {!route.nb && (
          <header className="app-top">
            {route.course && <span id="lib-toggle-slot" className="header-slot" />}
            <nav className="crumbs" aria-label="Breadcrumb">
              <button className="brand" onClick={() => go({})} aria-label="All courses">
                <span className="logo">N</span> Notebook
              </button>
              {route.course && <span id="lib-crumb-slot" className="crumb-path" />}
            </nav>
            <div className="spacer" />
            {!boot.ai.configured && (
              <span className="ai-pill off" title="Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env, then restart the server.">
                AI is off — notes won’t be organized or shared
              </span>
            )}
            <label className="who" title="Demo identities — not authentication">
              <span className="avatar" style={{ background: me?.color }}>
                {me?.initials}
              </span>
              <select value={me?.id} onChange={(e) => switchStudent(e.target.value)} aria-label="Demo account">
                {boot.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </header>
        )}
        {route.nb ? (
          <Editor key={`${route.nb}:${student}`} notebookId={route.nb} onBack={backToCourse} onToast={setToast} />
        ) : route.course ? (
          inCourse ? (
            <Library
              key={`${student}:${inCourse.id}`}
              view={route.view}
              folder={route.folder}
              onNavigate={(r) => go({ course: r.course ?? inCourse.id, view: r.view ?? 'course', folder: r.folder ?? null })}
              onHome={() => go({})}
              onOpen={(id) => go({ nb: id })}
              onToast={setToast}
            />
          ) : (
            <div className="center-message">Opening course…</div>
          )
        ) : (
          <Home
            key={student}
            onOpen={(id) => go({ course: id })}
            onOpenNotebook={(n) => {
              if (n.lastPageId && !lastPage.get(n.id)) lastPage.set(n.id, n.lastPageId);
              go({ nb: n.id });
            }}
            onToast={setToast}
          />
        )}
        <NoticeCenter key={`notices:${student}`} onOpenNotebook={(id) => go({ nb: id })} onToast={setToast} />
        {toast && (
          <div className="toast" role="status" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </div>
    </BootContext.Provider>
  );
}
