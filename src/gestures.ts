import { useEffect, useRef } from 'react';

/**
 * Library gestures that work the same with a finger, an Apple Pencil and a mouse.
 *
 * Elements opt in with data attributes:
 *  - `data-note="<notebookId>"`  can be picked up and dropped onto a folder.
 *  - `data-deck="<lectureId>"`   an official deck, dragged the same way (its id is the lecture's).
 *  - `data-ctx`                   has a menu (long-press, or right-click with a mouse).
 *                                 `data-ctx="area"` marks a background area: same menu, no lift effect.
 *  - `data-drop="<target>"`       accepts a dropped note.
 *
 * Touch/pen: hold ~0.35 s to lift. Releasing without moving opens the menu; moving while lifted drags.
 * A finger that moves before the lift is a scroll, so lists still scroll normally.
 * Mouse: dragging starts after a few pixels; right-click opens the menu.
 */
export type DropVerdict = 'ok' | 'same' | 'blocked';
export type PressHandlers = {
  onMenu: (el: HTMLElement, x: number, y: number) => void;
  canDrop: (noteId: string, target: string) => DropVerdict;
  onDrop: (noteId: string, target: string) => void;
  onBlocked: (noteId: string, target: string) => void;
  onDragChange?: (dragging: boolean) => void;
};

const LIFT_MS = 350;
/** What a lifted element carries: a notebook id, or a deck's lecture id. Both are opaque ids. */
const dragId = (el: HTMLElement) => el.dataset.note ?? el.dataset.deck ?? '';
const draggable = '[data-note], [data-deck], [data-ctx]';

export function usePressGestures(handlers: PressHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    type Press = {
      el: HTMLElement;
      x: number;
      y: number;
      id: number;
      touch: boolean;
      lifted: boolean;
      dragging: boolean;
      timer?: ReturnType<typeof setTimeout>;
      ghost?: HTMLElement;
      over?: HTMLElement | null;
    };
    let press: Press | null = null;
    // The click a browser sends when the finger lifts after a long-press or a drop: swallowed, wherever it lands
    // (the menu opens under the finger, so it could otherwise hit a menu item).
    let lifted: { x: number; y: number; t: number } | null = null;

    const liftClass = (el: HTMLElement) => el.dataset.ctx !== 'area';
    const clearOver = () => document.querySelectorAll('.drop-ok, .drop-no').forEach((x) => x.classList.remove('drop-ok', 'drop-no'));
    const end = () => {
      if (!press) return;
      clearTimeout(press.timer);
      press.el.classList.remove('lifted');
      press = null;
    };
    const stopDrag = () => {
      if (!press) return;
      press.ghost?.remove();
      press.el.classList.remove('dragging');
      clearOver();
      document.body.classList.remove('note-dragging');
      ref.current.onDragChange?.(false);
    };
    const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]') ?? null;

    const onDown = (e: PointerEvent) => {
      lifted = null;
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [data-no-press], .lib-menu')) return;
      const el = t.closest<HTMLElement>(draggable);
      if (!el) return;
      press = { el, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse', lifted: false, dragging: false };
      if (press.touch)
        press.timer = setTimeout(() => {
          if (!press) return;
          press.lifted = true;
          if (liftClass(press.el)) press.el.classList.add('lifted');
          navigator.vibrate?.(8);
        }, LIFT_MS);
    };
    const startDrag = () => {
      if (!press) return;
      press.dragging = true;
      const r = press.el.getBoundingClientRect();
      const g = press.el.cloneNode(true) as HTMLElement;
      g.classList.add('drag-ghost');
      g.classList.remove('lifted');
      g.removeAttribute('data-note');
      g.removeAttribute('data-deck');
      g.style.width = `${r.width}px`;
      document.body.append(g);
      press.ghost = g;
      press.el.classList.add('dragging');
      document.body.classList.add('note-dragging');
      ref.current.onDragChange?.(true);
    };
    const onMove = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (!press.dragging) {
        if (press.touch && !press.lifted) {
          if (dist > 8) end(); // the finger is scrolling
          return;
        }
        if (!press.el.dataset.note && !press.el.dataset.deck) return;
        if (dist < 6) return;
        startDrag();
      }
      press.ghost!.style.left = `${e.clientX - 24}px`;
      press.ghost!.style.top = `${e.clientY - 24}px`;
      clearOver();
      const over = targetAt(e.clientX, e.clientY);
      press.over = over;
      if (over) {
        const v = ref.current.canDrop(dragId(press.el), over.dataset.drop!);
        if (v !== 'same') over.classList.add(v === 'ok' ? 'drop-ok' : 'drop-no');
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      if (p.dragging) {
        lifted = { x: e.clientX, y: e.clientY, t: performance.now() };
        stopDrag();
        const over = targetAt(e.clientX, e.clientY);
        const note = dragId(p.el);
        if (over) {
          const target = over.dataset.drop!;
          const v = ref.current.canDrop(note, target);
          if (v === 'ok') ref.current.onDrop(note, target);
          else if (v === 'blocked') ref.current.onBlocked(note, target);
        }
      } else if (p.lifted) {
        lifted = { x: e.clientX, y: e.clientY, t: performance.now() };
        ref.current.onMenu(p.el, e.clientX + 10, e.clientY + 10);
      }
      end();
    };
    const onCancel = () => {
      if (press?.dragging) stopDrag();
      end();
    };
    // The click that follows a long-press or a drop must not also open the item.
    const onClick = (e: MouseEvent) => {
      if (!lifted) return;
      const same = performance.now() - lifted.t < 800 && Math.hypot(e.clientX - lifted.x, e.clientY - lifted.y) < 16;
      lifted = null;
      if (same) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onContext = (e: MouseEvent) => {
      if (press?.touch) return e.preventDefault(); // long-press is handled on release
      const el = (e.target as HTMLElement).closest<HTMLElement>(draggable);
      if (!el || (e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      ref.current.onMenu(el, e.clientX || r.left + 16, e.clientY || r.top + 16);
    };
    // Once something is lifted, the finger moves it instead of scrolling the page.
    const onTouchMove = (e: TouchEvent) => {
      if (press && (press.lifted || press.dragging)) e.preventDefault();
    };

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      onCancel();
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('touchmove', onTouchMove);
    };
  }, []);
}

/** Where a file dragged in from outside (desktop, iPad Files app) would land. */
export type FileTarget = { el: HTMLElement; label: string; hint: string; ok: boolean; accept?: (files: File[]) => void };

/** PDFs dragged in from outside the app. `resolve` maps the element under the pointer to a target. */
export function useFileDrop(resolve: (el: HTMLElement) => FileTarget | null, onHint: (t: FileTarget | null) => void) {
  const ref = useRef({ resolve, onHint });
  ref.current = { resolve, onHint };
  useEffect(() => {
    let current: FileTarget | null = null;
    const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const set = (t: FileTarget | null) => {
      if (current?.el !== t?.el || current?.ok !== t?.ok) {
        document.querySelectorAll('.drop-ok, .drop-no').forEach((x) => x.classList.remove('drop-ok', 'drop-no'));
        t?.el.classList.add(t.ok ? 'drop-ok' : 'drop-no');
      }
      current = t;
      ref.current.onHint(t);
    };
    const onOver = (e: DragEvent) => {
      if (!isFiles(e)) return;
      const t = ref.current.resolve(e.target as HTMLElement);
      if (t?.ok) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      } else {
        e.preventDefault(); // keep the browser from opening the PDF in place of the app
        e.dataTransfer!.dropEffect = 'none';
      }
      set(t);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) set(null);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      const t = ref.current.resolve(e.target as HTMLElement);
      set(null);
      if (!t?.ok || !t.accept) return;
      t.accept(Array.from(e.dataTransfer!.files));
    };
    document.addEventListener('dragover', onOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      set(null);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, []);
}
