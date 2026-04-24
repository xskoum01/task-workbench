/**
 * MarkdownView — lightweight Markdown-to-HTML renderer.
 *
 * Handles the subset of Markdown produced by AI reviewer responses:
 *   - ATX headings (## H2, ### H3)
 *   - Horizontal rules (---, ***)
 *   - Fenced code blocks (``` ... ```)
 *   - Unordered bullet lists (- item)
 *   - Ordered lists (1. item)
 *   - Inline bold (**text**)
 *   - Inline code (`code`)
 *   - Plain paragraphs
 *
 * Uses DOMPurify for sanitisation — no external markdown library required.
 */
import DOMPurify from 'dompurify';

interface MarkdownViewProps {
  markdown: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Minimal tokenising converter
// ---------------------------------------------------------------------------

function mdToHtml(md: string): string {
  // Normalise CRLF
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function inlineHtml(s: string): string {
    return escapeHtml(s)
      // **bold**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // *italic*
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // `code`
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // consume closing ```
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    // ATX headings
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { out.push(`<h2>${inlineHtml(h2[1])}</h2>`); i++; continue; }

    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { out.push(`<h3>${inlineHtml(h3[1])}</h3>`); i++; continue; }

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { out.push(`<h2>${inlineHtml(h1[1])}</h2>`); i++; continue; }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push('<hr />'); i++; continue;
    }

    // Unordered list — collect consecutive list items
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(`<li>${inlineHtml(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${inlineHtml(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line — paragraph break
    if (line.trim() === '') { i++; continue; }

    // Plain paragraph
    out.push(`<p>${inlineHtml(line)}</p>`);
    i++;
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MarkdownView({ markdown, className }: MarkdownViewProps) {
  const raw = mdToHtml(markdown);
  const safe = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'hr', 'br'],
    ALLOWED_ATTR: ['class'],
  });

  return (
    <div
      className={['markdown-view', className].filter(Boolean).join(' ')}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by DOMPurify
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
