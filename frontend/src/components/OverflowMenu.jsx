// Overflow ("more options") menu shared by the deck and list editor headers.
//
// WHY A PORTAL: every .glass-panel carries backdrop-filter, which gives each
// panel its own compositing layer that paints above earlier siblings no
// matter the z-index. The old absolutely-positioned popover inside the
// header panel lost that race on phones — measured at 375px: the panel
// below the header repainted over the open menu and hid its options, exactly
// what users reported. Portaled to document.body at fixed coordinates, the
// menu paints above the whole layout, flips above a trigger near the bottom
// fold, and clamps inside the viewport.
//
// CLOSE TIMING: the panel closes on the bubbled CLICK of a menuitem, after
// React ran the item's own onClick (same batching commit). Closing on
// mousedown instead would unmount the portal before the click ever reached
// the item — silently killing every menu action.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { positionMenu } from '../utils/menuPosition';

export default function OverflowMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  // Measure after paint (useLayoutEffect) so the flip/clamp decision uses
  // the panel's real size on this device, not an estimate.
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return undefined;
    const place = () => {
      const trig = triggerRef.current.getBoundingClientRect();
      // Trigger scrolled out of view (the portal is fixed, so it would keep
      // floating over unrelated content): close, the way native menus do.
      if (trig.bottom < 0 || trig.top > window.innerHeight) { setOpen(false); return; }
      const panel = panelRef.current.getBoundingClientRect();
      setPos(positionMenu(
        { top: trig.top, bottom: trig.bottom, left: trig.left, right: trig.right },
        { width: panel.width || 218, height: panel.height || 160 },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    place();
    // Recompute through any layout shift while open (rotation, scroll).
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (triggerRef.current && triggerRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    // pointerdown, not mousedown: a phone finger commits the tap long before
    // the synthesised mouse event, so an outside tap dismisses crisp/early.
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary btn-icon-only"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={label}
        title={label}
        style={{ borderRadius: '50%', padding: '0.25rem 0.5rem' }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          className="overflow-menu-panel"
          onClick={(e) => { if (e.target.closest('[role="menuitem"]')) setOpen(false); }}
          style={{
            position: 'fixed',
            zIndex: 1200,
            minWidth: '218px',
            maxWidth: 'calc(100vw - 16px)',
            padding: '0.3rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            // Hidden until measured, so there is no flash at a stale anchor.
            ...(pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }),
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
