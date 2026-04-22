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
    const bodyClose = safe.lastIndexOf('</body>');
    if (bodyClose !== -1) {
      return safe.slice(0, bodyClose) + IFRAME_BRIDGE + safe.slice(bodyClose);
    }
    // No </body> — append at end.
    return safe + IFRAME_BRIDGE;
  }

  // Fragment — wrap in a minimal shell.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Minimal reset so the email body is flush with the iframe edges. */
  html, body { margin: 0; padding: 8px; box-sizing: border-box; }
  img { max-width: 100%; height: auto; }
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
