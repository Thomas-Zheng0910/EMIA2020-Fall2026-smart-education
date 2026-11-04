import { useEffect, useRef } from 'react';

/** Closes overlays with Escape; the latest handler wins without re-subscribing. */
export function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ref.current();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}

/** Reads a current preference key, migrating the pre-rename value once and removing it. */
export function readMigrated(key: string) {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const oldKey = key.replace(/^notebook\./, 'margin.');
  const old = localStorage.getItem(oldKey);
  if (old !== null) {
    localStorage.setItem(key, old);
    localStorage.removeItem(oldKey);
  }
  return old;
}

/** Last page viewed per notebook, so reopening resumes where the student was. */
export const lastPage = {
  get: (nb: string) => readMigrated(`notebook.lastPage.${nb}`),
  set: (nb: string, page: string) => localStorage.setItem(`notebook.lastPage.${nb}`, page),
};

/** Last place in each course's library (My notes, a folder, Lectures), restored after closing a notebook. */
export const lastLibrary = {
  get: (course: string) => sessionStorage.getItem(`notebook.lastLibrary.${course}`),
  set: (course: string, hash: string) => sessionStorage.setItem(`notebook.lastLibrary.${course}`, hash),
};

export const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
