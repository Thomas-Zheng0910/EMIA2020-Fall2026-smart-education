import type { Page } from '../../shared/types';

export type ToolName = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text';
export type ToolState = {
  tool: ToolName;
  color: string;
  size: number;
  hlColor: string;
  hlSize: number;
  stylusOnly: boolean;
};
export type EditorPage = Page & {
  peerCount: number;
  /** Changes when this page's suggestions would look different, so the editor refetches them. */
  suggestVersion?: string;
};
export type Selection = {
  pageId: string;
  strokeIds: Set<string>;
  itemIds: Set<string>;
  area: [number, number, number, number];
};
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
