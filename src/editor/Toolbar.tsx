import { useRef } from 'react';
import type { ToolName, ToolState } from './types';
import { isTouchDevice } from '../ui';

const PEN_COLORS = ['#1f2933', '#2f6fed', '#d6336c', '#2b8a3e', '#e8590c', '#7048e8'];
const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#ffa8a8'];
const ICONS: Record<ToolName, { label: string; svg: React.ReactNode; key: string }> = {
  pen: { label: 'Pen', key: 'P', svg: <path d="M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3" /> },
  highlighter: { label: 'Highlighter', key: 'H', svg: <path d="M6 19h6M9 15l-3 3M8 14l7-9 4 4-9 7-2-2z" /> },
  eraser: { label: 'Eraser', key: 'E', svg: <path d="M8 20h12M5 15l9-9 5 5-8 8H9l-4-4z" /> },
  lasso: { label: 'Lasso: select, move, explain', key: 'L', svg: <path d="M12 5c5 0 8 2 8 5s-3 5-8 5-8-2-8-5 3-5 8-5zM7 14c-1 2 0 4 2 4s2 2 1 3" strokeDasharray="2.5 2" /> },
  text: { label: 'Text', key: 'T', svg: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
};

export function Toolbar({
  tool,
  setTool,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onImage,
}: {
  tool: ToolState;
  setTool: (f: (t: ToolState) => ToolState) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onImage: (f: File) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const hl = tool.tool === 'highlighter';
  const colors = hl ? HL_COLORS : PEN_COLORS;
  const active = hl ? tool.hlColor : tool.color;
  const sizes = hl ? [14, 22, 32] : [2.5, 4, 7];
  const curSize = hl ? tool.hlSize : tool.size;
  return (
    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
      <div className="tool-group">
        {(Object.keys(ICONS) as ToolName[]).map((t) => (
          <button
            key={t}
            className={`tool ${tool.tool === t ? 'active' : ''}`}
            title={`${ICONS[t].label} (${ICONS[t].key})`}
            aria-label={ICONS[t].label}
            aria-pressed={tool.tool === t}
            onClick={() => setTool((s) => ({ ...s, tool: t }))}
          >
            <svg viewBox="0 0 24 24">{ICONS[t].svg}</svg>
          </button>
        ))}
        <button className="tool" title="Insert image" aria-label="Insert image" onClick={() => file.current?.click()}>
          <svg viewBox="0 0 24 24">
            <path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1 1 0 100-.01" />
          </svg>
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImage(f);
            e.target.value = '';
          }}
        />
      </div>
      {(tool.tool === 'pen' || tool.tool === 'highlighter' || tool.tool === 'text') && (
        <div className="tool-group">
          {(tool.tool === 'text' ? PEN_COLORS : colors).map((c) => (
            <button
              key={c}
              className={`swatch ${active === c ? 'active' : ''}`}
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              onClick={() => setTool((s) => (hl ? { ...s, hlColor: c } : { ...s, color: c }))}
            />
          ))}
          {tool.tool !== 'text' &&
            sizes.map((sz) => (
              <button key={sz} className={`size ${curSize === sz ? 'active' : ''}`} aria-label={`Width ${sz}`} onClick={() => setTool((s) => (hl ? { ...s, hlSize: sz } : { ...s, size: sz }))}>
                <span style={{ width: Math.min(18, sz * (hl ? 0.6 : 1.6)), height: Math.min(18, sz * (hl ? 0.6 : 1.6)) }} />
              </button>
            ))}
        </div>
      )}
      <div className="tool-group">
        <button className="tool" disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <svg viewBox="0 0 24 24">
            <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />
          </svg>
        </button>
        <button className="tool" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <svg viewBox="0 0 24 24">
            <path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />
          </svg>
        </button>
      </div>
      {isTouchDevice() && (
        <button
          className={`tool ${tool.stylusOnly ? 'active' : ''}`}
          aria-pressed={tool.stylusOnly}
          title={tool.stylusOnly ? 'Stylus only: fingers scroll' : 'Fingers and stylus both draw'}
          aria-label="Stylus only"
          onClick={() => setTool((s) => ({ ...s, stylusOnly: !s.stylusOnly }))}
        >
          <svg viewBox="0 0 24 24">
            <path d="M15 4l5 5-9 9H6v-5zM4 20h6" />
          </svg>
        </button>
      )}
    </div>
  );
}
