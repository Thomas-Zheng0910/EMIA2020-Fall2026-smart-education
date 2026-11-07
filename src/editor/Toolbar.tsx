import { useRef } from 'react';
import { Eraser, Highlighter, ImagePlus, LassoSelect, Pen, PenTool, Redo2, StickyNote, Type, Undo2 } from 'lucide-react';
import type { ToolName, ToolState } from './types';
import { isTouchDevice } from '../ui';

const PEN_COLORS = ['#1f2933', '#2f6fed', '#d6336c', '#2b8a3e', '#e8590c', '#7048e8'];
const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#ffa8a8'];
const ICONS: Record<ToolName, { label: string; icon: React.ReactNode; key: string }> = {
  pen: { label: 'Pen', icon: <Pen />, key: 'P' },
  highlighter: { label: 'Highlighter', icon: <Highlighter />, key: 'H' },
  eraser: { label: 'Eraser', icon: <Eraser />, key: 'E' },
  lasso: { label: 'Lasso: select, move, explain', icon: <LassoSelect />, key: 'L' },
  text: { label: 'Text', icon: <Type />, key: 'T' },
  memo: { label: 'Memo: stick a note on the page', icon: <StickyNote />, key: 'M' },
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
            {ICONS[t].icon}
          </button>
        ))}
        <button className="tool" title="Insert image" aria-label="Insert image" onClick={() => file.current?.click()}>
          <ImagePlus />
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
          <Undo2 />
        </button>
        <button className="tool" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 />
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
          <PenTool />
        </button>
      )}
    </div>
  );
}
