import { useEffect, useRef, useState } from 'react';
import type { Course, CourseSummary, RecentNotebook } from '../shared/types';
import { api } from './api';
import { useBoot } from './boot';
import { useEscape } from './ui';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function ago(iso: string | null) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const SHARING_NOTICE = (code: string) =>
  `While you take notes in ${code}, Notebook reads them and shares the useful parts with classmates in ${code}, under your name. Unclear handwriting and things already on the slides stay private, and you can stop sharing any item at any time.`;

/** Front page: continue where I left off, then my courses, then courses to join. */
export function Home({ onOpen, onOpenNotebook, onToast }: { onOpen: (id: string) => void; onOpenNotebook: (n: RecentNotebook) => void; onToast: (m: string) => void }) {
  const { courses, enrolled, recent, reload } = useBoot();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<CourseSummary | null>(null);
  const mine = courses.filter((c) => enrolled.includes(c.id)).sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? '') || a.code.localeCompare(b.code));
  const others = courses.filter((c) => !enrolled.includes(c.id));
  const join = async (c: Course) => {
    try {
      await api(`/api/courses/${c.id}/enroll`, { method: 'POST' });
      onOpen(c.id);
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const leave = async (c: Course) => {
    if (!confirm(`Leave ${c.code}? Your notebooks are kept and come back if you rejoin. Notes you already shared stay visible to classmates unless you stop sharing them first.`)) return;
    try {
      await api(`/api/courses/${c.id}/enroll`, { method: 'DELETE' });
      reload();
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  return (
    <div className="library home">
      {recent.length > 0 && (
        <section className="continue">
          <h2 className="section-title first">Continue</h2>
          <div className="grid continue-grid">
            {recent.map((n) => (
              <button key={n.id} className="continue-card" onClick={() => onOpenNotebook(n)}>
                <div className="continue-thumb">{n.lastPageId && <img src={`/api/pages/${n.lastPageId}/render.png?w=480`} alt="" loading="lazy" />}</div>
                <div className="continue-meta">
                  <span className="course-badge">{n.courseCode}</span>
                  <b>{n.title}</b>
                  <span className="muted small">Edited {ago(n.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="home-head">
        <h1>My courses</h1>
        <button className="btn" onClick={() => setCreating(true)}>
          + New course
        </button>
      </section>
      {mine.length === 0 ? (
        <div className="empty-lectures">
          <b>You haven’t joined a course yet</b>
          <p className="muted">Join one of the courses below, or create a new one and add its lecture slides.</p>
        </div>
      ) : (
        <div className="grid course-grid">
          {mine.map((c) => (
            <CourseCard key={c.id} c={c} onOpen={() => onOpen(c.id)} menu={[{ label: `Leave ${c.code}`, danger: true, run: () => leave(c) }]} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <>
          <h2 className="section-title">Other courses</h2>
          <div className="grid course-grid">
            {others.map((c) => (
              <CourseCard key={c.id} c={c} other>
                <button className="btn small primary" onClick={() => setJoining(c)}>
                  Join
                </button>
              </CourseCard>
            ))}
          </div>
        </>
      )}
      {creating && <NewCourse onClose={() => setCreating(false)} onCreated={(id) => onOpen(id)} onToast={onToast} />}
      {joining && (
        <Dialog title={`Join ${joining.code}?`} onClose={() => setJoining(null)}>
          <p>
            <b>{joining.name}</b> · {plural(joining.memberCount, 'student')} · {plural(joining.lectureCount, 'lecture')}
          </p>
          <div className="notice">{SHARING_NOTICE(joining.code)}</div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setJoining(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => (setJoining(null), join(joining))}>
              Join course
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

type MenuItem = { label: string; danger?: boolean; run: () => void };
function CourseCard({ c, other, onOpen, menu, children }: { c: CourseSummary; other?: boolean; onOpen?: () => void; menu?: MenuItem[]; children?: React.ReactNode }) {
  return (
    <div
      className={`course-card ${other ? 'other' : ''}`}
      {...(onOpen
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onOpen());
            },
          }
        : {})}
      aria-label={`${c.code} ${c.name}`}
    >
      <div className="course-cover">{c.cover ? <img src={c.cover} alt="" loading="lazy" /> : <span>{c.code}</span>}</div>
      <div className="course-body">
        <div className="course-row">
          <span className="course-badge">{c.code}</span>
          {menu && <Menu items={menu} label={`${c.code} options`} />}
        </div>
        <b>{c.name}</b>
        {other && <span className="muted small clamp">{c.description}</span>}
        <span className="muted small course-stats">
          {plural(c.lectureCount, 'lecture')}
          {other ? ` · ${plural(c.memberCount, 'student')}` : c.notebookCount > 0 ? ` · ${plural(c.notebookCount, 'notebook')}` : ''}
          {!other && c.lastActive && ` · edited ${ago(c.lastActive)}`}
        </span>
        {children && <div className="course-actions">{children}</div>}
      </div>
    </div>
  );
}

export function Menu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', esc));
  }, [open]);
  return (
    <div className="page-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn small" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => (setOpen(false), i.run())}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function NewCourse({ onClose, onCreated, onToast }: { onClose: () => void; onCreated: (id: string) => void; onToast: (m: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const c = await api<Course>('/api/courses', { method: 'POST', json: { code, name, description } });
      onCreated(c.id);
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="New course" onClose={onClose}>
      <input autoFocus className="input" placeholder="Code, e.g. COMP3311" value={code} onChange={(e) => setCode(e.target.value)} />
      <input className="input" placeholder="Name, e.g. Database Management Systems" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="input" rows={2} placeholder="Short description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="notice">{SHARING_NOTICE(code.trim().toUpperCase() || 'this course')}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || code.trim().length < 2 || !name.trim()} onClick={create}>
          Create course
        </button>
      </div>
    </Dialog>
  );
}
