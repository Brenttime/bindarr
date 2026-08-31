import assert from 'node:assert/strict';
import { manualSearchFields } from './cardSearchInput.js';

assert.deepEqual(manualSearchFields('FDN 540'), { set: 'FDN', number: '540' });
assert.deepEqual(manualSearchFields('lea #5/295'), { set: 'lea', number: '5/295' });
assert.deepEqual(manualSearchFields('Lightning Bolt'), { name: 'Lightning Bolt' });
assert.deepEqual(manualSearchFields('t:creature c:r'), { q: 't:creature c:r' });
assert.deepEqual(manualSearchFields('  Sol Ring  '), { name: 'Sol Ring' });

console.log('PASS: cardSearchInput.test.js');
