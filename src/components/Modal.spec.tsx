/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Modal from './Modal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderModal(onClose: () => void) {
  act(() => {
    root?.render(
      <Modal title="Note" onClose={onClose}>
        <textarea aria-label="note" />
      </Modal>,
    );
  });
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('Modal focus management', () => {
  it('keeps the active input focused when the parent supplies a new onClose callback', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const firstClose = vi.fn();
    renderModal(firstClose);

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="note"]');
    expect(textarea).not.toBeNull();
    textarea?.focus();
    expect(document.activeElement).toBe(textarea);

    const latestClose = vi.fn();
    renderModal(latestClose);

    expect(document.activeElement).toBe(textarea);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(latestClose).toHaveBeenCalledTimes(1);
    expect(firstClose).not.toHaveBeenCalled();
  });
});
