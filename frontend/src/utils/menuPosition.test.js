import assert from 'node:assert';
import { positionMenu } from './menuPosition.js';

const phone = { width: 375, height: 667 };
const trigger = { top: 340, bottom: 370, left: 330, right: 360 };

// 1. Room below: opens downward with the 6px gap, right edge tracks trigger.
let p = positionMenu(trigger, { width: 218, height: 150 }, phone);
assert.strictEqual(p.top, 376);
assert.strictEqual(p.flipped, false);
assert.strictEqual(p.left, 360 - 218);

// 2. Trigger near the fold: the panel flips ABOVE instead of running
//    off-screen (the phone case — header under the browser toolbar).
p = positionMenu({ top: 520, bottom: 550, left: 330, right: 360 }, { width: 218, height: 200 }, phone);
assert.strictEqual(p.top, 520 - 6 - 200);
assert.strictEqual(p.flipped, true);

// 3. Neither side fits: no flip; panel clamps into the viewport bottom.
p = positionMenu({ top: 200, bottom: 210, left: 10, right: 40 }, { width: 200, height: 300 }, { width: 375, height: 400 });
assert.strictEqual(p.flipped, false);
assert.strictEqual(p.top, 400 - 8 - 300);

// 4a. Trigger pinned to the left edge cannot push a wide menu past the margin.
p = positionMenu({ top: 100, bottom: 130, left: 2, right: 20 }, { width: 300, height: 120 }, phone);
assert.strictEqual(p.left, 8);

// 4b. A menu wider than the right-aligned slot clamps to the right margin.
p = positionMenu({ top: 100, bottom: 130, left: 355, right: 375 }, { width: 300, height: 120 }, phone);
assert.strictEqual(p.left, 375 - 8 - 300);

// 5. Desktop width: right-aligned under the trigger, exactly the old look.
p = positionMenu({ top: 80, bottom: 112, left: 1500, right: 1532 }, { width: 218, height: 150 }, { width: 1600, height: 900 });
assert.strictEqual(p.top, 118);
assert.strictEqual(p.left, 1532 - 218);
assert.strictEqual(p.flipped, false);

console.log('menuPosition self-check passed');
