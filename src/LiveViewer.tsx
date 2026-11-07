import { useEffect, useState } from 'react';
import type { LiveSession } from '../shared/types';
import { api } from './api';

/**
 * A live handout is a read-only view of the professor's current page. The page image is re-fetched
 * when the server's render version changes; the viewer never edits the professor's note.
 */
export function LiveViewer({ session, onClose, onOpenCopy }: { session: LiveSession; onClose: () => void; onOpenCopy: (id: string) => void }) {
  const [live, setLive] = useState(session);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api<LiveSession>(`/api/live/${session.id}`);
        if (!stopped) {
          setLive(next);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    const t = window.setInterval(tick, 2000);
    tick();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [session.id]);
  return (
    <div className="live-backdrop" role="dialog" aria-label="Live class handout">
      <div className="live-view">
        <header className="live-head">
          <span className={`live-dot ${live.endedAt ? 'off' : ''}`} />
          <div>
            <b>{live.endedAt ? 'Live handout ended' : `${live.hostName} is live`}</b>
            <small>{live.title}{live.currentPageLabel ? ` · ${live.currentPageLabel}` : ''}</small>
          </div>
          <div className="spacer" />
          {!live.endedAt && <span className="live-audience">{live.audience} {live.audience === 1 ? 'student' : 'students'}</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Close live handout">✕</button>
        </header>
        {live.endedAt ? (
          <div className="live-ended">
            <b>{live.pullable ? 'The handout is ready to pull.' : 'The handout is ready as a snapshot.'}</b>
            <p>The copy is in your course files; the <b>Shared with me</b> folder if it still exists.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>Close</button>
              {live.copyNotebookId && <button className="btn primary" onClick={() => onOpenCopy(live.copyNotebookId!)}>Open my copy</button>}
            </div>
          </div>
        ) : live.currentPageId ? (
          <div className="live-page">
            <img src={`/api/live/${live.id}/page.png?v=${encodeURIComponent(live.renderVersion)}`} alt={live.currentPageLabel ?? 'Live page'} />
          </div>
        ) : (
          <div className="live-ended"><b>Waiting for the first page…</b></div>
        )}
        {error && <div className="live-error">{error}</div>}
        <footer className="live-foot">
          {live.endedAt ? 'You can write on your copy after the session.' : 'Following the professor. The handout is read-only during the session.'}
        </footer>
      </div>
    </div>
  );
}
