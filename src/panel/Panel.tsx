import { useEffect, useState } from 'react';
import type { AskCard, AskResult, Citation, Fragment, Notebook, PrivateReason, Quiz, QuizResult } from '../../shared/types';
import { api } from '../api';
import { Md } from '../Md';
import { useBoot } from '../boot';
import type { EditorPage } from '../editor/types';

export type PanelTab = 'classmates' | 'ask' | 'quiz';
export type AskTarget = { pageId: string; bbox: [number, number, number, number]; nonce: string };
type AddFn = (pageId: string, a: { title: string; body: string; basis: 'official' | 'peer' | 'ai'; citations: Citation[] }, near?: [number, number, number, number] | null) => void;

export function Panel(props: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  onClose: () => void;
  page: EditorPage;
  pageNumber: number;
  notebook: Notebook;
  askTarget: AskTarget | null;
  quizSelection: AskTarget | null;
  clearAskTarget: () => void;
  onAdd: AddFn;
  onCitation: (c: Citation) => void;
  onDismissPeer: () => void;
  onToast: (m: string) => void;
  beforeAsk: () => Promise<void>;
}) {
  const { tab, setTab, onClose, page } = props;
  return (
    <aside className="panel" aria-label="Study panel">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(
            [
              ['classmates', 'Classmates'],
              ['ask', 'Explain'],
              ['quiz', 'Quiz me'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
              {k === 'classmates' && page.peerCount > 0 && <span className="tab-count">{page.peerCount}</span>}
            </button>
          ))}
        </div>
        <button className="icon-btn small" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-context">
        {page.kind === 'slide' ? `Slide ${page.position}` : `Page ${props.pageNumber}`} · {props.notebook.title}
      </div>
      <div className="panel-body">
        {tab === 'classmates' && <Classmates key={page.id} {...props} />}
        {tab === 'ask' && <Ask {...props} />}
        {tab === 'quiz' && <QuizTab {...props} />}
      </div>
    </aside>
  );
}

const REASON: Record<PrivateReason, string> = {
  unclear: 'Private · hard to read',
  unlinked: 'Private · lecture unclear',
  on_slide: 'Private · already on the slide',
  withheld: 'Not shared · turned off by you',
};

function Classmates({ page, onAdd, onCitation, onDismissPeer, onToast, setTab }: Parameters<typeof Panel>[0]) {
  const [data, setData] = useState<{ slideId: string | null; fragments: Fragment[]; lectureFragments: number } | null>(null);
  const [mine, setMine] = useState<Fragment[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const loadMine = () => api(`/api/pages/${page.id}/shared`).then(setMine).catch(() => {});
  useEffect(() => {
    let live = true;
    api(`/api/pages/${page.id}/classmates`).then((d) => live && setData(d)).catch((e) => onToast(e.message));
    loadMine();
    return () => {
      live = false;
    };
  }, [page.id, page.indexStatus, page.link.slideId, page.peerCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const dismiss = async (f: Fragment) => {
    setHidden((h) => new Set(h).add(f.id));
    onDismissPeer();
    await api(`/api/fragments/${f.id}/dismiss`, { method: 'POST' }).catch(() => {});
  };
  const toggleShare = async (f: Fragment) => {
    try {
      await api(`/api/fragments/${f.id}/sharing`, { method: 'POST', json: { shared: !f.shared } });
      loadMine();
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  if (!data) return <div className="muted pad">Looking for classmates’ notes…</div>;
  const frags = data.fragments.filter((f) => !hidden.has(f.id));
  const onSlide = page.kind === 'slide' || Boolean(page.link.slideId);
  const where = page.kind === 'slide' ? 'this slide' : onSlide ? 'the slide this page is about' : 'this page';
  const sharedMine = mine.filter((m) => m.shared);
  return (
    <div className="stack">
      {!page.link.lectureId ? (
        <Empty title="Not linked to a lecture yet">Write something and Notebook links the page to a lecture, or choose one from the chip above the page.</Empty>
      ) : frags.length === 0 ? (
        <Empty title={`No classmate notes for ${where}`}>
          {data.lectureFragments > 0 ? (
            <>
              Classmates wrote {data.lectureFragments} notes elsewhere in this lecture.{' '}
              <button className="link-btn" onClick={() => setTab('ask')}>
                Open Explain
              </button>
            </>
          ) : (
            'When classmates take notes on this lecture, what they add beyond the slides shows up here.'
          )}
        </Empty>
      ) : (
        <>
          <p className="muted small">What classmates added on {where}. Unverified — compare with the slide.</p>
          {frags.map((f) => (
            <article key={f.id} className="card peer-card">
              <header>
                <span className="avatar" style={{ background: f.authorColor }}>
                  {f.authorName[0]}
                </span>
                <b>{f.authorName}</b>
                <span className="muted small">{f.kind === 'other' ? 'note' : f.kind}</span>
              </header>
              <Md text={f.text} />
              {f.confidence < 0.75 && <div className="unclear">Handwriting was hard to read — check the original.</div>}
              <button className="crop-btn" onClick={() => onCitation({ kind: 'fragment', fragmentId: f.id, author: f.authorName, label: '' })} title="See the original handwriting">
                <img className="crop" src={`/api/fragments/${f.id}/crop.png`} alt={`${f.authorName}'s original handwriting`} loading="lazy" />
                <span>Original</span>
              </button>
              <footer>
                <button
                  className="btn small"
                  disabled={added.has(f.id)}
                  onClick={() => {
                    setAdded((a) => new Set(a).add(f.id));
                    onAdd(page.id, {
                      title: `${f.authorName}: ${f.topic || f.kind}`,
                      body: f.text,
                      basis: 'peer',
                      citations: [{ kind: 'fragment', fragmentId: f.id, author: f.authorName, label: `${f.authorName}'s note` }],
                    });
                  }}
                >
                  {added.has(f.id) ? 'Added ✓' : 'Add to my notes'}
                </button>
                <button className="btn small ghost" onClick={() => dismiss(f)}>
                  Dismiss
                </button>
              </footer>
            </article>
          ))}
        </>
      )}
      <section className="mine">
        <h4>
          From this page{' '}
          <span className="muted small">
            · {sharedMine.length} shared{mine.length > sharedMine.length ? `, ${mine.length - sharedMine.length} private` : ''}
          </span>
        </h4>
        {mine.length === 0 ? (
          <p className="muted small">Nothing yet. A few seconds after you write, Notebook reads the page and shares what would help classmates, under your name. You can stop sharing any item.</p>
        ) : (
          mine.map((m) => (
            <div key={m.id} className={`mine-item ${m.shared ? '' : 'private'}`}>
              <div className="mine-head">
                <span className="tag">{m.shared ? 'Shared' : REASON[m.reason ?? 'withheld']}</span>
                {(m.shared || m.reason === 'withheld') && (
                  <button className="link-btn" onClick={() => toggleShare(m)}>
                    {m.shared ? 'Stop sharing' : 'Share again'}
                  </button>
                )}
              </div>
              <Md text={m.text} className="small" />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function Ask({ page, askTarget, clearAskTarget, onAdd, onCitation, onToast, beforeAsk }: Parameters<typeof Panel>[0]) {
  const target = askTarget?.pageId === page.id ? askTarget : null;
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setGone(new Set());
    try {
      await beforeAsk();
      setResult(await api('/api/ask', { method: 'POST', json: { pageId: page.id, bbox: target?.bbox ?? null, question: question.trim() || undefined } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (target) run();
  }, [target?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cards = result?.cards.filter((c) => !gone.has(c.id)) ?? [];
  return (
    <div className="stack">
      <div className="ask-box">
        {target ? (
          <div className="sel-note">
            Using your lasso selection
            <button onClick={clearAskTarget}>use whole page</button>
          </div>
        ) : (
          <div className="sel-note muted">Whole page · tip: lasso a part and choose Explain</div>
        )}
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What's unclear? (optional) e.g. why do we take the log here?" rows={2} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && run()} />
        <button className="btn primary" onClick={run} disabled={loading}>
          {loading ? 'Reading your notes, slides and classmates’ notes…' : '✦ Explain / fill the gap'}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {loading && <Skeleton />}
      {cards.map((c) => (
        <AnswerCard key={c.id} card={c} onCitation={onCitation} onAdd={() => (onAdd(page.id, { title: c.title, body: c.body, basis: c.basis, citations: c.citations }, target?.bbox), setGone((g) => new Set(g).add(c.id)))} onDismiss={() => setGone((g) => new Set(g).add(c.id))} />
      ))}
      {result && cards.length === 0 && <p className="muted small">All suggestions handled.</p>}
      {!result && !loading && !error && (
        <Empty title="Fill gaps in your notes">The AI reads this page, the whole lecture and classmates’ notes, then explains what’s missing — labeled as official, classmate or AI, with sources. Nothing changes your notes unless you add it.</Empty>
      )}
    </div>
  );
}

const BASIS = { official: 'Official slides', peer: 'From classmates · unverified', ai: 'AI interpretation' };
function AnswerCard({ card, onCitation, onAdd, onDismiss }: { card: AskCard; onCitation: (c: Citation) => void; onAdd: () => void; onDismiss: () => void }) {
  return (
    <article className={`card answer basis-${card.basis}`}>
      <div className="basis-label">{BASIS[card.basis]}</div>
      <h4>{card.title}</h4>
      <Md text={card.body} />
      {card.conflict && <div className="conflict">⚠ {card.conflict}</div>}
      {card.citations.length > 0 && (
        <div className="citations">
          {card.citations.map((c, i) => (
            <button key={i} className={`cite cite-${c.kind}`} onClick={() => onCitation(c)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <footer>
        <button className="btn small" onClick={onAdd}>
          Add to my notes
        </button>
        <button className="btn small ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </footer>
    </article>
  );
}

function QuizTab({ page, notebook, quizSelection, onCitation, beforeAsk }: Parameters<typeof Panel>[0]) {
  const { lectures } = useBoot();
  const sel = quizSelection?.pageId === page.id ? quizSelection : null;
  const [scope, setScope] = useState<'lecture' | 'page' | 'selection'>(sel ? 'selection' : 'page');
  const lectureId = page.link.lectureId ?? notebook.lectureId ?? lectures[0]?.id ?? '';
  const [lectureChoice, setLectureChoice] = useState(lectureId);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sel) {
      setScope('selection');
      start('selection');
    }
  }, [sel?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setLectureChoice(lectureId), [lectureId]);
  useEffect(() => {
    if (!sel && scope === 'selection') setScope('page');
  }, [sel, scope]);
  useEffect(() => {
    setQuiz(null);
    setResult(null);
    setAnswers({});
    setError(null);
  }, [page.id]);
  const start = async (s = scope) => {
    setLoading(true);
    setError(null);
    setQuiz(null);
    setResult(null);
    setAnswers({});
    try {
      await beforeAsk();
      setQuiz(
        await api('/api/quizzes', {
          method: 'POST',
          json: { scope: { kind: s, lectureId: s === 'lecture' ? lectureChoice : lectureId || lectureChoice, pageId: s === 'lecture' ? undefined : page.id }, bbox: s === 'selection' ? sel?.bbox : null },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const submit = async () => {
    if (!quiz) return;
    try {
      setResult(await api(`/api/quizzes/${quiz.id}/grade`, { method: 'POST', json: { answers } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack">
      <div className="quiz-scope">
        <div className="seg">
          <button className={scope === 'page' ? 'active' : ''} onClick={() => setScope('page')}>
            This page
          </button>
          <button className={scope === 'selection' ? 'active' : ''} disabled={!sel} onClick={() => setScope('selection')} title={sel ? '' : 'Lasso part of the page first'}>
            Selection
          </button>
          <button className={scope === 'lecture' ? 'active' : ''} onClick={() => setScope('lecture')}>
            Lecture
          </button>
        </div>
        {scope === 'lecture' && (
          <select value={lectureChoice} onChange={(e) => setLectureChoice(e.target.value)}>
            {lectures.map((l) => (
              <option key={l.id} value={l.id}>
                L{l.number} · {l.title}
              </option>
            ))}
          </select>
        )}
        {scope === 'page' && !sel && <span className="muted small">Tip: lasso part of a page and choose “Quiz me” to focus on it.</span>}
        <button className="btn primary" onClick={() => start()} disabled={loading}>
          {loading ? 'Writing questions…' : quiz ? 'New quiz' : 'Start quiz'}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {loading && <Skeleton />}
      {quiz &&
        quiz.questions.map((q, qi) => {
          const r = result?.results.find((x) => x.questionId === q.id);
          return (
            <article key={q.id} className={`card quiz-q ${r ? (r.correct ? 'right' : 'wrong') : ''}`}>
              <div className="q-num">Question {qi + 1}</div>
              <Md text={q.question} />
              <div className="options">
                {q.options.map((o, oi) => (
                  <label key={oi} className={`option ${answers[q.id] === oi ? 'chosen' : ''} ${r && r.correctIndex === oi ? 'correct' : ''} ${r && answers[q.id] === oi && !r.correct ? 'incorrect' : ''}`}>
                    <input type="radio" name={q.id} disabled={!!result} checked={answers[q.id] === oi} onChange={() => setAnswers((a) => ({ ...a, [q.id]: oi }))} />
                    <Md text={o} />
                  </label>
                ))}
              </div>
              {r && (
                <div className="feedback">
                  <b>{r.correct ? 'Correct.' : 'Not quite.'}</b> <Md text={r.explanation} />
                </div>
              )}
              {r && (
                <div className="citations">
                  {q.citations.map((c, i) => (
                    <button key={i} className={`cite cite-${c.kind}`} onClick={() => onCitation(c)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      {quiz && !result && (
        <button className="btn primary" disabled={Object.keys(answers).length < quiz.questions.length} onClick={submit}>
          Check answers
        </button>
      )}
      {result && (
        <div className="score">
          {result.score} / {result.total} correct
        </div>
      )}
      {!quiz && !loading && !error && <Empty title="Check your understanding">Questions are grounded in the official slides. Classmate notes can inspire questions but never decide the answer.</Empty>}
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      <p>{children}</p>
    </div>
  );
}
function Skeleton() {
  return (
    <div className="card skeleton">
      <div />
      <div />
      <div />
    </div>
  );
}
