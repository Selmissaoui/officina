// Markdown rendering for notes. Notes can be written by agents that read
// untrusted web pages, so the HTML is always sanitised before insertion.
import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener');
  }
});

export function renderMarkdown(src) {
  return DOMPurify.sanitize(marked.parse(src || ''), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
}
