import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableChildren(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => (
    element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ));
}

/**
 * Keep keyboard focus inside an open dialog, focus its primary control, close
 * consistently on Escape, and return focus to the control that opened it.
 */
export function useDialogFocus({ isOpen, containerRef, initialFocusRef, returnFocusRef, onEscape }) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!isOpen) return undefined;

    const returnFocusTo = returnFocusRef?.current || document.activeElement;
    const focusTimer = setTimeout(() => {
      const container = containerRef.current;
      const target = initialFocusRef?.current || focusableChildren(container)[0] || container;
      target?.focus({ preventScroll: true });
    }, 0);

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscapeRef.current?.();
        return;
      }

      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      const focusable = focusableChildren(container);
      if (!focusable.length) {
        event.preventDefault();
        container?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const escapedDialog = !container?.contains(active);

      if (event.shiftKey && (active === first || escapedDialog)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || escapedDialog)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      if (returnFocusTo?.isConnected && typeof returnFocusTo.focus === 'function') {
        setTimeout(() => returnFocusTo.focus({ preventScroll: true }), 0);
      }
    };
  }, [isOpen, containerRef, initialFocusRef, returnFocusRef]);
}
