// Placement math for the OverflowMenu popover, which renders through a
// portal on document.body at fixed viewport coordinates — trigger rects
// and innerWidth/innerHeight already speak that space. Kept pure so
// node --test pins the policy: never let the panel run past the bottom
// edge (the reported bug), never let a phone-width panel hang off an edge.
//
// triggerRect: {top, bottom, left, right} from getBoundingClientRect()
// menu:     {width, height} measured panel size
// viewport: {width, height}
export function positionMenu(triggerRect, menu, viewport) {
  const gap = 6;
  const margin = 8;

  // Prefer opening below the trigger. If it would cross the bottom edge,
  // flip above when it fits there; otherwise (short viewport) stay below
  // but clamp so the panel still fits inside.
  const below = triggerRect.bottom + gap;
  let top;
  let flipped = false;
  if (below + menu.height <= viewport.height - margin) {
    top = below;
  } else {
    const above = triggerRect.top - gap - menu.height;
    if (above >= margin) {
      top = above;
      flipped = true;
    } else {
      top = Math.max(margin, viewport.height - margin - menu.height);
    }
  }

  // Right-align to the trigger (menus grow leftward, the desktop look),
  // then clamp so neither edge leaves the viewport.
  let left = triggerRect.right - menu.width;
  if (left < margin) left = margin;
  if (left + menu.width > viewport.width - margin) {
    left = Math.max(margin, viewport.width - margin - menu.width);
  }

  return { top: Math.round(top), left: Math.round(left), flipped };
}
