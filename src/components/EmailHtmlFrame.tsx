/**
 * EmailHtmlFrame — renders a raw Outlook email body inside a sandboxed iframe.
 *
 * Goals:
 *  - Visual fidelity: the email renders with its own CSS, fonts, and layout —
 *    completely isolated from the app's stylesheet.
 *  - Safety: email-embedded <script> tags are stripped before rendering; only
 *    our own injected inline script runs (for resize + link interception).
 *  - Link handling: anchor clicks are intercepted inside the iframe and
 *    forwarded to the parent via postMessage → tauriApi.openUrl so the OS
 *    default browser opens them (window.open is blocked inside Tauri WebView).
 *  - Auto-resize: the iframe reports its scrollHeight after load and after any
 *    DOM mutation, so no scrollbar appears inside the email reader.
 */
import { useEffect, useRef, useState } from 'react';
import * as tauriApi from '../lib/tauriCommands';

interface EmailHtmlFrameProps {
  html: string;
}

/**
 * Strip <script>...</script> blocks from email HTML so we can safely use
 * sandbox="allow-scripts" for our own injected resize/link script without
 * executing arbitrary email-client JavaScript.
 */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '');
}

/**
 * Inline script injected into the iframe document.
 * Responsibilities:
 *  1. Intercept <a href="http..."> clicks → postMessage to parent.
 *  2. Notify parent of document scrollHeight so the iframe can be resized.
 */
const IFRAME_BRIDGE = `
<script>
(function () {
  'use strict';

  // --- Link interception ---------------------------------------------------
  document.addEventListener('click', function (e) {
    var el = e.target;
    // Walk up the DOM to find the nearest anchor.
    while (el && el.tagName !== 'A') { el = el.parentElement; }
    if (el && el.href && /^https?:/i.test(el.href)) {
      e.preventDefault();
      window.parent.postMessage({ type: 'email-open-url', url: el.href }, '*');
    }
  }, true);

  // --- Auto-resize ---------------------------------------------------------
  function reportHeight() {
    var h = document.documentElement
      ? document.documentElement.scrollHeight
      : (document.body ? document.body.scrollHeight : 0);
    window.parent.postMessage({ type: 'email-resize', height: h }, '*');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportHeight);
  } else {
    reportHeight();
  }
  window.addEventListener('load', reportHeight);

  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver(reportHeight).observe(document.body, {
      subtree: true, childList: true, attributes: true,
    });
  }
}());
</script>
`;

/**
 * Wrap a raw email HTML fragment (or full document) into a self-contained
 * document suitable for iframe srcDoc.
 *
 * - If the content is already a full HTML document: strip scripts and inject
 *   the bridge before </body>.
 * - Otherwise: wrap in a minimal shell that resets margins and caps image width.
 */
function buildSrcDoc(rawHtml: string): string {
  const safe = stripScripts(rawHtml);
  const isFullDoc = /^\s*(?:<!DOCTYPE|<html)/i.test(safe.trimStart());

  if (isFullDoc) {
    // Inject a dark-theme base style before anything else so the email reads
    // legibly against the app's dark background. We only set base body colors;
    // all original HTML structure and inline formatting is preserved.
    const darkStyle = `<style>html,body{background:#1e1e1e!important;color:#d4d4d4!important}a{color:#6ab0f5!important}img{max-width:100%;height:auto}</style>`;
    const headClose = safe.search(/<\/head>/i);
    const withStyle = headClose !== -1
      ? safe.slice(0, headClose) + darkStyle + safe.slice(headClose)
      : darkStyle + safe;
    const bodyClose = withStyle.lastIndexOf('</body>');
    if (bodyClose !== -1) {
      return withStyle.slice(0, bodyClose) + IFRAME_BRIDGE + withStyle.slice(bodyClose);
    }
    return withStyle + IFRAME_BRIDGE;
  }

  // Fragment — wrap in a minimal shell.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Dark theme shell matching the host app. */
  html, body {
    margin: 0;
    padding: 8px;
    box-sizing: border-box;
    background: #1e1e1e;
    color: #d4d4d4;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }
  img { max-width: 100%; height: auto; }
  a { color: #6ab0f5; }
</style>
</head>
<body>
${safe}
${IFRAME_BRIDGE}
</body>
</html>`;
}

export default function EmailHtmlFrame({ html }: EmailHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  // Listen for messages from the sandboxed iframe.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== 'object') return;

      if (e.data.type === 'email-resize' && typeof e.data.height === 'number') {
        // Add a small bottom margin so scrollHeight doesn't include phantom space.
        setHeight(Math.max(80, e.data.height + 8));
      }

      if (e.data.type === 'email-open-url' && typeof e.data.url === 'string') {
        tauriApi.openUrl(e.data.url).catch((err) => {
          console.warn('[email-html] openUrl failed, falling back:', err);
          // window.open is blocked inside Tauri WebView but this is a safe fallback.
          window.open(e.data.url, '_blank');
        });
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const srcDoc = buildSrcDoc(html);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      /**
       * Sandbox permissions:
       *  allow-same-origin — required so our injected script can read
       *    document.documentElement.scrollHeight and attach event listeners.
       *  allow-scripts     — required for the injected bridge script to run.
       *
       * Intentionally NOT granted:
       *  allow-forms, allow-popups, allow-top-navigation, allow-modals
       */
      sandbox="allow-same-origin allow-scripts"
      style={{
        display: 'block',
        width: '100%',
        height: `${height}px`,
        border: 'none',
        overflow: 'hidden',
      }}
      title="Email content"
    />
  );
}
