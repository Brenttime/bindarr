// Guards the ManaBox theme contract (docs/THEME-MANABOX.md): style-only,
// fully scoped, never hides app content, and selectable in Settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(SRC, 'theme-manabox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const SCOPE = ':root[data-theme="manabox"]';

test('every manabox selector is scoped to data-theme="manabox"', () => {
  const selectors = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(css))) {
    const head = m[1].trim();
    if (head.startsWith('@')) continue;
    head.split(',').map(s => s.trim()).filter(Boolean).forEach(s => selectors.push(s));
  }
  assert.ok(selectors.length > 20, 'expected theme rules');
  const bad = selectors.filter(s => !s.startsWith(SCOPE));
  assert.deepEqual(bad, [], `unscoped selectors: ${bad.join(' | ')}`);
});

test('manabox theme never hides content', () => {
  assert.doesNotMatch(css, /display\s*:\s*none/i);
  assert.doesNotMatch(css, /visibility\s*:\s*hidden/i);
  assert.doesNotMatch(css, /opacity\s*:\s*0\s*[;}!]/i);
});

test('manabox is selectable and translated', () => {
  const settings = readFileSync(join(SRC, 'components', 'Settings.jsx'), 'utf8');
  assert.match(settings, /<option value="manabox">/);
  assert.match(readFileSync(join(SRC, 'main.jsx'), 'utf8'), /theme-manabox\.css/);
  for (const f of readdirSync(join(SRC, 'locales')).filter(f => f.endsWith('.json'))) {
    const dict = JSON.parse(readFileSync(join(SRC, 'locales', f), 'utf8'));
    assert.ok(dict['theme.manabox'], `${f} missing theme.manabox`);
  }
});
