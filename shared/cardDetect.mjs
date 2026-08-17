// The card detector — the single implementation, shared by both sides.
//
// The server runs it against opencv-wasm to crop a scan; the browser runs it
// against OpenCV.js to draw the live overlay and to choose which frame to send.
// ONE copy, deliberately: the overlay's entire value is that it shows what the
// scanner sees, and two implementations would drift until the overlay started
// reassuring the user at exactly the moments detection was failing.
//
// `cv` is injected rather than imported. The two environments load different
// builds of OpenCV and this module must not care which.
//
// Everything here is pure pixel work — nothing touches the card index, the
// network or the filesystem, which is what makes it portable at all.
export function createDetector(cv) {
  // The one call whose name differs between builds. opencv-wasm exposes a free
  // `rotatedRectPoints`; other OpenCV.js builds expose it as a static on
  // RotatedRect. Resolve it once here rather than let the browser copy fail at
  // runtime on a frame nobody is watching.
  const rectPoints = typeof cv.rotatedRectPoints === 'function'
    ? (r) => cv.rotatedRectPoints(r)
    : (r) => cv.RotatedRect.points(r);

  const CARD_ASPECT = 2.5 / 3.5;
  const WARP_W = 500, WARP_H = Math.round(500 / CARD_ASPECT); // rectified card size

  // Order 4 quad points as [tl, tr, br, bl].
  //
  // The sum/diff trick is exact for an axis-aligned-ish quad but degenerates near
  // 45°, where one point can win two slots and leave another unused — that feeds
  // warpPerspective a collapsed quad and produces the badly sheared crops. So the
  // result is checked for duplicates and falls back to ordering by angle around the
  // centroid, which is rotation-proof.
  function orderQuad(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const guess = [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
    if (new Set(guess).size === 4) return guess;
  
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    // Clockwise from the top-left-most quadrant so the order still reads tl,tr,br,bl.
    const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const start = byAngle.reduce((bi, p, i) => (p.x + p.y < byAngle[bi].x + byAngle[bi].y ? i : bi), 0);
    return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
  }
  
  // Geometry of an ordered quad, or null if it is too small to judge. Used to throw
  // out candidates that are not plausibly a card seen at an angle.
  function quadMetrics(pts) {
    const [tl, tr, br, bl] = orderQuad(pts);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const top = d(tl, tr), bottom = d(bl, br), left = d(tl, bl), right = d(tr, br);
    if (Math.min(top, bottom, left, right) < 20) return null;
    const w = (top + bottom) / 2, h = (left + right) / 2;
    // How much the opposite sides agree. A real card (even in perspective) keeps
    // this high; a blob merging the card with a hand or a neighbouring card does not.
    const parallelism = (Math.min(top, bottom) / Math.max(top, bottom)) * (Math.min(left, right) / Math.max(left, right));
  
    // Corner orthogonality: check that corner angles stay close to 90 degrees (prevents shear/trapezoid distortion).
    const corners = [tl, tr, br, bl];
    let maxCos = 0;
    for (let i = 0; i < 4; i++) {
      const pPrev = corners[(i + 3) % 4];
      const pCurr = corners[i];
      const pNext = corners[(i + 1) % 4];
      const v1x = pPrev.x - pCurr.x, v1y = pPrev.y - pCurr.y;
      const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 > 0 && l2 > 0) {
        const cosVal = Math.abs((v1x * v2x + v1y * v2y) / (l1 * l2));
        if (cosVal > maxCos) maxCos = cosVal;
      }
    }
    const orthogonality = Math.max(0, 1 - maxCos);
  
    return { corners: [tl, tr, br, bl], w, h, ar: w / h, parallelism, orthogonality };
  }
  
  // Is this quad plausibly a portrait card?
  //
  // Portrait is required rather than rotated into place: the scanner's guide box is
  // portrait and every indexed reference image is portrait upright, so a landscape
  // quad means the detector merged the card with something else. Rotating it would
  // be a coin flip on which way is up, and dHash recall is rotation-sensitive — so a
  // landscape candidate is rejected instead of guessed at.
  function isCardQuad(m) {
    return !!m && m.ar <= 0.95 && m.ar >= 0.5 && m.parallelism >= 0.6 && m.orthogonality >= 0.55;
  }
  
  // Locate the card and return a rectified raw-RGBA image, or null if no card-like
  // region is found. Two strategies, tried in order:
  //   1. A clean 4-point convex quad -> perspective-warp flat (handles tilt/skew).
  //   2. Else the largest card-aspect region's bounding box -> plain crop (slinger
  //      cards sit flat and upright, so a crop is enough and works when the card is
  //      small/far where a crisp quad isn't found).
  // Both prefer the region nearest the frame center (the card the user aimed at).
  // The area floor is low (4%) so distant cards are still detected instead of
  // falling back to a background-dominated center crop.
  // Finds the 4 true perspective corners of a card contour by dynamically stepping
  // epsilon on its convex hull to simplify rounded corners into exactly 4 primary vertices.
  function findCardQuad(c) {
    const hull = new cv.Mat();
    cv.convexHull(c, hull);
    const peri = cv.arcLength(hull, true);
    let quad = null;
  
    for (let epsScale = 0.015; epsScale <= 0.12; epsScale += 0.005) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, epsScale * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        quad = Array.from({ length: 4 }, (_, j) => ({
          x: approx.data32S[j * 2],
          y: approx.data32S[j * 2 + 1]
        }));
        approx.delete();
        break;
      }
      approx.delete();
    }
    hull.delete();
    return quad;
  }
  
  // Every way we know of turning a photo into "regions that might be a card".
  // One segmentation is not enough in practice:
  //   - OTSU (both polarities) is the cheapest and wins on a plain table, but it
  //     merges the card with anything of similar brightness touching it — a hand, a
  //     neighbouring card in the binder — and then the region's outline is not the
  //     card's outline, which is what produced skewed crops.
  //   - Canny keys on the card's BORDER instead of its brightness, so it survives a
  //     hand, glare, and a background whose tone is close to the card's.
  // Candidates from all of them compete on the same score, so adding a strategy can
  // only help: a wrong region still has to beat a right one on card-likeness.
  // Canny thresholds derived from the frame's own median intensity, not fixed.
  //
  // 50/150 is tuned for a well-lit photo. In a dim room the whole histogram slides
  // down, gradients across the card border shrink with it, and a fixed 50 rejects
  // them — Canny returns almost nothing and the card's outline is never among the
  // candidates at all. That is not hypothetical: on the dark half of the sample
  // captures the true card was missing from the detector's candidate list entirely,
  // while the same card in daylight was found cleanly.
  //
  // The 0.66/1.33 spread around the median is the standard auto-Canny rule. The
  // floor on `hi` keeps a nearly-black frame from setting both bounds to ~0, which
  // would call every sensor speckle an edge and fill the mask with noise.
  function cannyThresholds(gray) {
    const hist = new Uint32Array(256);
    const d = gray.data;
    for (let i = 0; i < d.length; i++) hist[d[i]]++;
    const half = d.length / 2;
    let cum = 0, median = 0;
    for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= half) { median = v; break; } }
    const lo = Math.max(10, Math.round(0.66 * median));
    const hi = Math.max(40, Math.round(1.33 * median));
    return [lo, hi];
  }
  
  function segmentations(blur, w, h) {
    const closeK = Math.max(15, Math.round(Math.min(w, h) * 0.035));
    const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeK, closeK));
    const masks = [];
  
    for (const polarity of [cv.THRESH_BINARY_INV, cv.THRESH_BINARY]) {
      const thresh = new cv.Mat(), closed = new cv.Mat();
      cv.threshold(blur, thresh, 0, 255, polarity | cv.THRESH_OTSU);
      cv.morphologyEx(thresh, closed, cv.MORPH_CLOSE, kClose);
      thresh.delete();
      masks.push(closed);
    }
  
    // Edge pass: Canny, then a light dilate to close the small gaps a card border
    // picks up over busy art, then close to fill it into a solid region. The kernel
    // is deliberately much smaller than the OTSU one — a big kernel is exactly what
    // bridges the card to a hand resting against it.
    const kEdge = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const kFill = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(Math.min(w, h) * 0.01)), Math.max(5, Math.round(Math.min(w, h) * 0.01))));
    //
    // TWO edge passes, not one. The fixed 50/150 pair is right for a well-lit
    // photo and wrong for a dim one; the median-derived pair is the reverse — it
    // recovers a dark frame's border but, on a bright scene, scales its upper
    // bound past the gradients it needs to keep and loses the card to a hand
    // resting against it. Measured on test/crop.test.js: fixed-only fails the
    // three dim/blur scenes, adaptive-only fails two bright hand-holding ones.
    // Both as candidates fails neither, because they compete on the same
    // card-likeness score and a wrong region still has to beat a right one.
    for (const [lo, hi] of [[50, 150], cannyThresholds(blur)]) {
      const edges = new cv.Mat(), dil = new cv.Mat(), filled = new cv.Mat();
      cv.Canny(blur, edges, lo, hi);
      cv.dilate(edges, dil, kEdge);
      cv.morphologyEx(dil, filled, cv.MORPH_CLOSE, kFill);
      edges.delete(); dil.delete();
      masks.push(filled);
    }
    kEdge.delete(); kFill.delete();
  
    kClose.delete();
    return masks;
  }
  
  // Card must cover at least this fraction of the frame. Low on purpose: a card held
  // back from the camera is small, and rejecting it means matching the whole photo —
  // background included — which is far worse than a slightly loose crop. (The old
  // floor was 0.15 while the comment above claimed 0.04; 4% is the intent.)
  const MIN_AREA_FRAC = 0.04;
  // Upper cap earns its keep: with the wrong OTSU polarity the BACKGROUND becomes
  // the blob, and "the whole frame" has whatever aspect the sensor has — 3:4 sails
  // through the card-aspect gate, scores enormously on area, and crops the entire
  // photo. Keep this comfortably below 1.
  const MAX_AREA_FRAC = 0.85;
  
  function detectCard(rgbaData, w, h) {
    const src = cv.matFromImageData({ data: rgbaData, width: w, height: h });
    const gray = new cv.Mat(), blur = new cv.Mat();
    let out = null;
    let masks = [];
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  
      const imgArea = w * h, cx = w / 2, cy = h / 2, halfDiag = Math.hypot(w, h) / 2;
      let best = null; // { score, pts }
  
      // Is a point sitting on the capture's own boundary? Tolerance scales with the
      // frame so it means the same thing at any upload resolution.
      const edgeTol = Math.max(2, Math.round(Math.min(w, h) * 0.01));
      const atFrameEdge = (p) =>
        p.x <= edgeTol || p.y <= edgeTol || p.x >= w - 1 - edgeTol || p.y >= h - 1 - edgeTol;
  
      // Freed in the finally below, not inline: an exception between here and there
      // would otherwise strand three full-frame Mats on the wasm heap, which never
      // shrinks — the failure mode that used to kill scanning after ~67 cards.
      masks = segmentations(blur, w, h);
      // Order matches segmentations(): two OTSU polarities, then the fixed-threshold
      // and median-derived Canny passes. These names land in the debug dump, so a
      // bad crop says which strategy produced it.
      const MASK_NAMES = ['otsu-inv', 'otsu', 'canny', 'canny-auto'];
      for (let mi = 0; mi < masks.length; mi++) {
        const mask = masks[mi];
        const maskName = MASK_NAMES[mi] || `mask${mi}`;
        const contours = new cv.MatVector(), hier = new cv.Mat();
        try {
          // RETR_LIST, not RETR_EXTERNAL: the card is not always the outermost
          // thing in the frame. Photograph it on a playmat, a binder page, or any
          // border brighter than the background and OTSU returns ONE blob for the
          // whole surface — the card's own outline is a CHILD contour, which
          // RETR_EXTERNAL discards outright. The detector then had only the mat to
          // choose from, warped that, and handed the matcher a sheared card.
          //
          // Every contour still competes on the same card-likeness score, so this
          // can only add candidates; the nested one wins when it is more card-like.
          cv.findContours(mask, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  
          for (let i = 0; i < contours.size(); i++) {
            const c = contours.get(i);
            const area = cv.contourArea(c);
            if (area >= MIN_AREA_FRAC * imgArea && area <= MAX_AREA_FRAC * imgArea) {
              const rect = cv.minAreaRect(c);
              let rw = rect.size.width;
              let rh = rect.size.height;
              if (rw > rh) { const tmp = rw; rw = rh; rh = tmp; } // ensure portrait
              const ar = rw / rh; // ideal card aspect = 0.714
  
              if (ar >= 0.55 && ar <= 0.88) {
                const rcx = rect.center.x, rcy = rect.center.y;
                const centrality = 1 - Math.min(1, Math.hypot(rcx - cx, rcy - cy) / halfDiag);
                const aspectFit = 1 - Math.min(1, Math.abs(ar - CARD_ASPECT) / 0.15);
  
                // opencv-wasm calls this rotatedRectPoints and returns the points
                // directly. It has NO cv.boxPoints — the old code called that in its
                // fallback branch, so any contour without a clean hull quad threw
                // TypeError, aborted the whole detection (no catch inside), and the
                // scan silently fell back to matching the uncropped photo.
                const boxPts = rectPoints(rect).map(p => ({ x: p.x, y: p.y }));
  
                // The hull quad follows real perspective, so it beats the bounding
                // box when it is trustworthy — but only then. An unvalidated quad was
                // preferred outright (1.2x), which is how a hand-merged blob's
                // garbage quad won over its own sane bounding box and sheared the crop.
                const hullQuad = findCardQuad(c);
                const hullMetrics = hullQuad && quadMetrics(hullQuad);
                const rectArea = rect.size.width * rect.size.height;
                const hullOk = isCardQuad(hullMetrics)
                  // A trustworthy quad also has to explain the region it came from:
                  // a sliver cutting across the blob does not.
                  && hullMetrics.w * hullMetrics.h >= 0.7 * rectArea;
  
                // A VALIDATED hull quad is still preferred: it follows real
                // perspective, where the bounding box of a tilted card includes
                // background at two corners. `hullOk` is what makes that safe — it
                // is the gate the original 1.2x lacked.
                //
                // Preferring the box instead (box 1.2 / hull 1.0, behind an extra
                // 0.85 orthogonality+parallelism gate on the hull) was measured
                // against test/crop.test.js: mean crop distance 4.15 -> 8.57 and bad
                // crops 4/120 -> 22/120. The orthogonality metric itself is free and
                // is kept; it was only the preference flip that cost accuracy.
                const candidates = [];
                const boxMetrics = quadMetrics(boxPts);
                if (hullOk) candidates.push({ pts: hullMetrics.corners, bonus: 1.2, par: hullMetrics.parallelism, ortho: hullMetrics.orthogonality, m: hullMetrics });
                if (isCardQuad(boxMetrics)) candidates.push({ pts: boxMetrics.corners, bonus: 1.0, par: boxMetrics.parallelism, ortho: boxMetrics.orthogonality, m: boxMetrics });
  
                for (const cand of candidates) {
                  // Belt to the area cap's braces: a quad that spans essentially the
                  // whole frame is the background, not a card. Cropping to it is a
                  // no-op that still runs the image through a perspective warp.
                  if (cand.m.w >= 0.95 * w && cand.m.h >= 0.95 * h) continue;
                  // And a quad whose corners ARE the frame's corners is the frame,
                  // whatever its aspect ratio says. A card photographed against a
                  // playmat gives OTSU one bright blob spanning the whole capture;
                  // its hull then pins three corners to the image bounds and drags
                  // the fourth inward, which passes every aspect/fill/parallelism
                  // gate and warps into a badly sheared card.
                  //
                  // That is not hypothetical: it is the crop that made a global scan
                  // return 7 inliers of unrelated cards while the same capture
                  // scored 54 against its own set. The 0.95 test above missed it by
                  // a hair — the quad measured 94.4% x 92.4% of the frame.
                  //
                  // A genuine card inside the guide box never has a corner AT the
                  // image bound; one that bleeds off the edge is not croppable
                  // anyway, so falling through to the raw frame is the better answer.
                  if (cand.m.corners.filter(atFrameEdge).length >= 3) continue;
                  // How much of the quad the region actually fills. A card fills its
                  // own outline almost completely; a region that merged the card with
                  // a hand or a neighbouring card is L-shaped, so the quad drawn
                  // around it is mostly empty.
                  const fill = Math.min(1, area / Math.max(1, cand.m.w * cand.m.h));
                  const score = (area / imgArea) * (aspectFit * aspectFit) * (0.4 + 0.6 * centrality) * cand.bonus * (0.5 + 0.5 * cand.par) * fill;
                  if (!best || score > best.score) best = { score, pts: cand.pts, source: maskName, fill, par: cand.par, ar };
                }
              }
            }
            c.delete();
          }
        } finally { contours.delete(); hier.delete(); }
      }
  
      if (best && best.pts) {
        const [tl, tr, brc, bl] = orderQuad(best.pts);
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, brc.x, brc.y, bl.x, bl.y]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const warped = new cv.Mat();
        cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));
        // `quad`/`pick` are diagnostics only (preprocessCard ignores them); they make
        // a bad crop debuggable — which segmentation won, and where it thought the
        // card was — instead of guessable.
        out = {
          data: new Uint8Array(warped.data), width: WARP_W, height: WARP_H, channels: 4,
          quad: [tl, tr, brc, bl].map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
          pick: { source: best.source, score: +best.score.toFixed(4), fill: +best.fill.toFixed(2), par: +best.par.toFixed(2), ar: +best.ar.toFixed(3) },
        };
        srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
      }
    } finally {
      for (const m of masks) { try { m.delete(); } catch { /* already freed */ } }
      src.delete(); gray.delete(); blur.delete();
    }
    return out;
  }

  return { detectCard, CARD_ASPECT, WARP_W, WARP_H, MIN_AREA_FRAC, MAX_AREA_FRAC };
}
