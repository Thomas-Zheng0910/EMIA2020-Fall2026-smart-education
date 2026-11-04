import { useMemo } from 'react';
import { marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const renderer = new marked.Renderer();
renderer.link = ({ text }) => `<span class="md-link">${text}</span>`;
renderer.image = ({ text }) => escape(text ?? '');
renderer.html = ({ text }) => escape(text);

/** Safe Markdown + LaTeX: raw HTML in the source is rendered as text, links are inert. */
export function renderMd(src: string) {
  const math: string[] = [];
  const stash = (tex: string, display: boolean) => {
    math.push(katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false }));
    return `@@M${math.length - 1}@@`;
  };
  let s = src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/\$([^$\n]+?)\$/g, (_, t) => stash(t, false));
  s = marked.parse(s, { renderer, async: false, gfm: true, breaks: true }) as string;
  return s.replace(/@@M(\d+)@@/g, (_, i) => math[Number(i)]!);
}

export function Md({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => renderMd(text), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
