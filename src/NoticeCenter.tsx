import { useEffect, useRef, useState } from 'react';
import type { InviteNotice, LiveSession, Notices, ShareNotice } from '../shared/types';
import { api, getStudent } from './api';
import { useBoot } from './boot';
import { Dialog } from './Home';
import { LiveViewer } from './LiveViewer';

const shareKey = (s: ShareNotice) => `s:${s.shareId}`;
const inviteKey = (i: InviteNotice) => `i:${i.notebookId}:${i.createdAt}`;

/**
 * The small inbox for named sharing: a received copy, a co-edit invitation, or a professor's live
 * handout. AI suggestions stay anonymous and never appear here. The polling is deliberately simple;
 * the demo does not need a websocket.
 */
export function NoticeCenter({ onOpenNotebook, onToast }: { onOpenNotebook: (id: string) => void; onToast: (m: string) => void }) {
  const boot = useBoot();
  const me = getStudent();
  const [notices, setNotices] = useState<Notices>({ shares: [], invites: [], live: null });
  const [live, setLive] = useState<LiveSession | null>(null);
  const [busy, setBusy] = useState(false);
  /** Things put away this visit. Later is not the same as opened, and closing an invitation is not declining it. */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const tick = async () => {
      try {
        const next = await api<Notices>('/api/notices');
        if (mounted.current) setNotices(next);
      } catch {
        /* transient */
      }
    };
    const t = window.setInterval(tick, 4000);
    tick();
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, []);

  const putAway = (key: string) => setDismissed((v) => new Set(v).add(key));
  const restore = (key: string) =>
    setDismissed((v) => {
      const n = new Set(v);
      n.delete(key);
      return n;
    });

  const share: ShareNotice | null = notices.shares.find((s) => !dismissed.has(shareKey(s))) ?? null;
  const invite: InviteNotice | null = notices.invites.find((i) => !dismissed.has(inviteKey(i))) ?? null;

  const openShare = async (s: ShareNotice) => {
    putAway(shareKey(s));
    await api(`/api/shares/${s.shareId}/seen`, { method: 'POST' }).catch(() => {});
    onOpenNotebook(s.notebookId);
  };
  const openInvite = async (i: InviteNotice, join: boolean) => {
    setBusy(true);
    const key = inviteKey(i);
    putAway(key);
    try {
      if (join) {
        await api(`/api/notebooks/${i.notebookId}/members/accept`, { method: 'POST' });
        boot.reload();
        onOpenNotebook(i.notebookId);
      } else {
        await api(`/api/notebooks/${i.notebookId}/members/decline`, { method: 'POST' });
      }
    } catch (e) {
      restore(key);
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {share && (
        <Dialog title="A note was shared with you" onClose={() => putAway(shareKey(share))}>
          <p>
            <b>{share.fromName}</b> shared <b>“{share.title}”</b> with you.
          </p>
          <div className="share-note">
            {share.mode === 'pull'
              ? 'It is pullable: you can fetch their later changes, and your own writing is kept.'
              : 'It is a snapshot: a copy frozen when they sent it.'}{' '}
            It is in your course files; the <b>Shared with me</b> folder if it still exists.
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => putAway(shareKey(share))}>Later</button>
            <button className="btn primary" onClick={() => openShare(share)}>Open</button>
          </div>
        </Dialog>
      )}
      {!share && invite && (
        <Dialog title="Co-edit invitation" onClose={() => putAway(inviteKey(invite))}>
          <p>
            <b>{invite.fromName}</b> invited you to co-edit <b>“{invite.title}”</b>.
          </p>
          <div className="share-note">A group note is the same note for everyone: all members can write and edit it. Your own writing stays yours, and the AI bank does not ingest group notes.</div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => putAway(inviteKey(invite))}>Later</button>
            <button className="btn ghost" disabled={busy} onClick={() => openInvite(invite, false)}>Not now</button>
            <button className="btn primary" disabled={busy} onClick={() => openInvite(invite, true)}>Join</button>
          </div>
        </Dialog>
      )}
      {notices.live && notices.live.hostId !== me && !live && (
        <button className="live-pill" onClick={() => setLive(notices.live)}>
          <span className="live-dot" />
          {notices.live.hostName} is live · Join
        </button>
      )}
      {live && (
        <LiveViewer
          session={live}
          onClose={() => setLive(null)}
          onOpenCopy={(id) => {
            setLive(null);
            onOpenNotebook(id);
          }}
        />
      )}
    </>
  );
}
