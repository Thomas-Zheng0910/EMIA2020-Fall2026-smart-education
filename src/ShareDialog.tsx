import { useEffect, useMemo, useState } from 'react';
import type { LiveSession, Notebook, NotebookMember, ShareMode, Student } from '../shared/types';
import { api, getStudent } from './api';
import { useBoot } from './boot';
import { Dialog } from './Home';

type CourseMember = Student & { courseRole: string };
type Tab = 'copy' | 'group' | 'live';

const initials = (name: string) => name.slice(0, 1).toUpperCase();

/**
 * The share sheet: send a copy (pullable or snapshot), invite co-editors, or — for the professor —
 * go live with the class. Direct shares are named and irreversible; the copy is a real editable note.
 */
export function ShareDialog({
  notebook,
  pageId,
  initialTab,
  onClose,
  onToast,
  onChanged,
  onStartedLive,
  onLeft,
  onBeforeChange,
}: {
  notebook: Notebook;
  pageId?: string | null;
  initialTab?: Tab | null;
  onClose: () => void;
  onToast: (m: string) => void;
  onChanged?: () => void;
  onStartedLive?: (s: LiveSession) => void;
  onLeft?: () => void;
  onBeforeChange?: () => Promise<void>;
}) {
  const boot = useBoot();
  const me = getStudent();
  const courseRole = boot.course?.id === notebook.courseId ? boot.course?.myRole : null;
  const [myRole, setMyRole] = useState<string | null>(courseRole ?? null);
  const isInstructor = myRole === 'instructor';
  const canInvite = notebook.role === 'owner' && notebook.kind !== 'lecture';
  const canLive = Boolean(onStartedLive) && isInstructor && notebook.studentId === me && notebook.kind !== 'shared' && notebook.kind !== 'group';
  const [tab, setTab] = useState<Tab>(initialTab ?? 'copy');
  const [roster, setRoster] = useState<CourseMember[]>([]);
  const [members, setMembers] = useState<NotebookMember[]>([]);
  const [sent, setSent] = useState<{ toStudentId: string; toName: string; mode: string; createdAt: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wholeClass, setWholeClass] = useState(false);
  const [onlyPage, setOnlyPage] = useState(false);
  const [mode, setMode] = useState<ShareMode>('pull');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CourseMember[]>(`/api/courses/${notebook.courseId}/members`)
      .then((rows) => {
        setRoster(rows);
        const mine = rows.find((r) => r.id === me);
        if (mine) setMyRole(mine.courseRole);
      })
      .catch((e) => setError(e.message));
    if (notebook.kind === 'group') api<{ members: NotebookMember[] }>(`/api/notebooks/${notebook.id}/members`).then((r) => setMembers(r.members)).catch(() => {});
    api<typeof sent>(`/api/notebooks/${notebook.id}/shares`).then(setSent).catch(() => {});
  }, [notebook.courseId, notebook.id, notebook.kind, me]);

  const classmates = useMemo(() => roster.filter((s) => s.courseRole === 'student' && s.id !== me), [roster, me]);
  const activeMemberIds = useMemo(() => new Set(members.filter((m) => m.status === 'active').map((m) => m.id)), [members]);
  const canInviteMore = canInvite;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'copy', label: 'Send a copy' },
    ...(canInvite || notebook.kind === 'group' ? [{ id: 'group' as Tab, label: notebook.kind === 'group' ? 'Members' : 'Invite to co-edit' }] : []),
    ...(canLive ? [{ id: 'live' as Tab, label: 'Go live' }] : []),
  ];
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(tabs[0]!.id);
  }, [tabs, tab]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      // A membership change or a share must not race a pending page save.
      await onBeforeChange?.();
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendCopy = () =>
    run(async () => {
      const { shared, keptSnapshots } = await api<{ shared: number; keptSnapshots?: number }>(`/api/notebooks/${notebook.id}/share`, {
        method: 'POST',
        json: { students: [...selected], wholeClass, mode, pageId: onlyPage && pageId ? pageId : null },
      });
      const kept = keptSnapshots ? ` ${keptSnapshots} kept a snapshot, so their copy was not changed.` : '';
      onToast(`Sent a ${mode === 'pull' ? 'pullable' : 'snapshot'} copy to ${shared} ${shared === 1 ? 'classmate' : 'classmates'}.${kept}`);
      onChanged?.();
      onClose();
    });

  const invite = () =>
    run(async () => {
      const ids = [...selected];
      if (!ids.length) throw new Error('Choose at least one classmate.');
      await api(`/api/notebooks/${notebook.id}/invite`, { method: 'POST', json: { students: ids } });
      onToast(`Invited ${ids.length} ${ids.length === 1 ? 'classmate' : 'classmates'} to co-edit.`);
      onChanged?.();
      onClose();
    });

  const goLive = () =>
    run(async () => {
      const session = await api<LiveSession>(`/api/notebooks/${notebook.id}/live`, { method: 'POST', json: { pullable: mode === 'pull', pageId: pageId ?? null } });
      onStartedLive?.(session);
      onToast('You are live. Students can follow your page; end the session when you are done.');
      onClose();
    });

  const remove = (sid: string) =>
    run(async () => {
      await api(`/api/notebooks/${notebook.id}/members/${sid}`, { method: 'DELETE' });
      setMembers((m) => m.filter((x) => x.id !== sid));
      onChanged?.();
    });

  const copyTab = (
    <>
      <div className="share-note">They get an editable copy. Pullable copies can fetch your later changes; snapshots stay as they are. Sent copies cannot be taken back.</div>
      <div className="share-people">
        {isInstructor && (
          <label className="share-person all">
            <input type="checkbox" checked={wholeClass} onChange={(e) => setWholeClass(e.target.checked)} />
            <span className="avatar" style={{ background: '#6b4e8e' }}>ALL</span>
            <span>
              <b>The whole class</b>
              <small>{classmates.length} students</small>
            </span>
          </label>
        )}
        {classmates.map((s) => (
          <label key={s.id} className="share-person">
            <input type="checkbox" checked={!wholeClass && selected.has(s.id)} disabled={wholeClass} onChange={() => toggle(s.id)} />
            <span className="avatar" style={{ background: s.color }}>{s.initials || initials(s.name)}</span>
            <span>
              <b>{s.name}</b>
              <small>{s.courseRole === 'instructor' ? 'Instructor' : 'Classmate'}</small>
            </span>
          </label>
        ))}
        {!classmates.length && <p className="muted small">No classmates have joined this course yet.</p>}
      </div>
      {pageId && (
        <label className="share-person share-page-choice">
          <input type="checkbox" checked={onlyPage} onChange={(e) => setOnlyPage(e.target.checked)} />
          <span>
            <b>Only this page</b>
            <small>Send the page you are reading, not the whole notebook.</small>
          </span>
        </label>
      )}
      <div className="share-mode" role="radiogroup" aria-label="Copy updates">
        <button role="radio" aria-checked={mode === 'pull'} className={mode === 'pull' ? 'active' : ''} onClick={() => setMode('pull')}>
          <b>Pullable</b>
          <span>They can fetch your later changes. Their own writing is kept.</span>
        </button>
        <button role="radio" aria-checked={mode === 'snapshot'} className={mode === 'snapshot' ? 'active' : ''} onClick={() => setMode('snapshot')}>
          <b>Snapshot</b>
          <span>A copy frozen now; later changes stay with you.</span>
        </button>
      </div>
      {sent.length > 0 && (
        <div className="share-sent">
          <b>Already sent</b>
          <span>{[...new Set(sent.map((s) => `${s.toName} (${s.mode === 'pull' ? 'pullable' : 'snapshot'})`))].join(' · ')}</span>
        </div>
      )}
    </>
  );

  const groupTab = (
    <>
      <div className="share-note">A group note is the same note for everyone: all members can write, move and erase on it. The AI bank does not ingest group notes.</div>
      {members.length > 0 && (
        <div className="share-members">
          {members.map((m) => (
            <div key={m.id} className="share-person">
              <span className="avatar" style={{ background: m.color }}>{m.initials}</span>
              <span>
                <b>{m.name}</b>
                <small>{m.role === 'owner' ? 'Owner' : 'Editor'}{m.status === 'invited' ? ' · invited' : ''}</small>
              </span>
              {m.role !== 'owner' && notebook.role === 'owner' && (
                <button className="btn small ghost" onClick={() => remove(m.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canInviteMore && (
        <>
          <div className="share-people">
            {classmates.filter((s) => !activeMemberIds.has(s.id)).map((s) => (
              <label key={s.id} className="share-person">
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                <span className="avatar" style={{ background: s.color }}>{s.initials || initials(s.name)}</span>
                <span>
                  <b>{s.name}</b>
                  <small>Classmate</small>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !selected.size} onClick={invite}>Invite to co-edit</button>
          </div>
        </>
      )}
      {!canInviteMore && notebook.role !== 'owner' && (
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn" onClick={() => run(async () => { await api(`/api/notebooks/${notebook.id}/members/${me}`, { method: 'DELETE' }); onToast('You left the group note. It stays with the other members.'); onLeft?.(); onClose(); })}>
            Leave group
          </button>
        </div>
      )}
      {notebook.role === 'owner' && members.filter((m) => m.status === 'active').length > 1 && (
        <div className="modal-actions">
          <button
            className="btn ghost"
            onClick={() =>
              run(async () => {
                await api(`/api/notebooks/${notebook.id}/members/${me}`, { method: 'DELETE' });
                onToast('You left the group note. Ownership passed to the oldest member.');
                onLeft?.();
                onClose();
              })
            }
          >
            Transfer and leave
          </button>
        </div>
      )}
    </>
  );

  const liveTab = (
    <>
      <div className="share-note">Students follow the page you are on while you write. They cannot edit the handout during the session. When you end it, they get a copy in their course files; the <b>Shared with me</b> folder if it still exists.</div>
      <div className="share-mode" role="radiogroup" aria-label="Handout after live">
        <button role="radio" aria-checked={mode === 'pull'} className={mode === 'pull' ? 'active' : ''} onClick={() => setMode('pull')}>
          <b>Pullable afterwards</b>
          <span>Students can fetch corrections after class.</span>
        </button>
        <button role="radio" aria-checked={mode === 'snapshot'} className={mode === 'snapshot' ? 'active' : ''} onClick={() => setMode('snapshot')}>
          <b>Snapshot afterwards</b>
          <span>The handout freezes when you end the session.</span>
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={goLive}>Start live</button>
      </div>
    </>
  );

  return (
    <Dialog title={`Share “${notebook.title}”`} onClose={onClose} wide>
      <div className="share-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <div className="share-error">{error}</div>}
      {tab === 'copy' && copyTab}
      {tab === 'group' && groupTab}
      {tab === 'live' && liveTab}
      {tab === 'copy' && (
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (!wholeClass && !selected.size)} onClick={sendCopy}>
            {wholeClass ? 'Send to the class' : `Send ${selected.size || ''} ${selected.size === 1 ? 'copy' : 'copies'}`}
          </button>
        </div>
      )}
    </Dialog>
  );
}
