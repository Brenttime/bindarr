// MTG rules reference: Comprehensive Rules + Commander rules, searchable in the
// Rules view.
//
//   GET /api/rules            cached JSON (refetched weekly)
//   GET /api/rules?refresh=1  force refetch
//
// Sources: the CR .txt linked from magic.wizards.com/en/rules and the official
// rules page on mtgcommander.net. Parsed once and cached next to the DB so a
// failed fetch falls back to the last good copy.
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const router = express.Router();
const CACHE = process.env.RULES_CACHE || path.join(__dirname, '../../../database/mtg-rules.json');
const MAX_AGE = 7 * 86400 * 1000;
const UA = { 'User-Agent': 'Bindarr/1.0 (rules reference)' };
let mem = null;
let inflight = null;

function decode(buf) {
  const s = buf.toString('utf8');
  // Wizards' .txt has shipped as cp1252 before; fall back when UTF-8 is broken.
  return s.includes('\uFFFD') ? buf.toString('latin1') : s.replace(/^\uFEFF/, '');
}

async function fetchText(url) {
  const r = await axios.get(url, { headers: UA, responseType: 'arraybuffer', timeout: 30000 });
  return decode(Buffer.from(r.data));
}

function parseCR(txt) {
  const lines = txt.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  const out = [];
  const starts = lines.reduce((a, l, i) => (l === '1. Game Concepts' ? [...a, i] : a), []);
  let i = starts.length > 1 ? starts[1] : 0;
  let section = '';
  let gloss = false;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) { i++; continue; }
    if (l === 'Glossary') { gloss = true; section = 'Glossary'; i++; continue; }
    if (l === 'Credits' && gloss) break;
    if (gloss) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && lines[j]) body.push(lines[j++]);
      out.push({ src: 'Glossary', id: l, section: 'Glossary', text: body.join(' ') });
      i = j; continue;
    }
    let m;
    if ((m = l.match(/^(\d{3}\.\d+[a-z]?)\.?\s+(.*)$/))) {
      out.push({ src: 'Comprehensive', id: m[1], section, text: m[2] });
    } else if (/^\d{3}\.\s/.test(l)) {
      section = l;
      out.push({ src: 'Comprehensive', id: l.split('.')[0], section: l, text: l, header: true });
    } else if (/^\d\.\s/.test(l)) {
      section = l;
    } else if (l.startsWith('Example:') && out.length) {
      out[out.length - 1].text += '\n' + l;
    }
    i++;
  }
  return out;
}

const unescape = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'")
  .replace(/&rdquo;|&ldquo;/g, '"').replace(/&ndash;/g, '-').replace(/&mdash;/g, '-')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseCommander(page) {
  const m = page.match(/<div class="entry-content[^>]*>([\s\S]*?)<\/article/);
  const body = m ? m[1] : page;
  const out = [];
  let section = 'Commander';
  let n = 0;
  const re = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/g;
  let t;
  while ((t = re.exec(body))) {
    const text = unescape(t[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (t[1].startsWith('h')) { section = text; continue; }
    out.push({ src: 'Commander', id: `CMD ${++n}`, section, text });
  }
  return out;
}

async function build() {
  const idx = await fetchText('https://magic.wizards.com/en/rules');
  const urls = idx.match(/https:\/\/media\.wizards\.com\/[^"']*?\.txt/g);
  if (!urls) throw new Error('could not find Comprehensive Rules .txt link');
  const crUrl = urls[0].replace(/ /g, '%20');
  const cr = parseCR(await fetchText(crUrl));
  const cmdUrl = 'https://mtgcommander.net/index.php/rules/';
  const cmd = parseCommander(await fetchText(cmdUrl));
  if (cr.length < 1000 || cmd.length < 5) throw new Error(`parse sanity failed cr=${cr.length} cmd=${cmd.length}`);
  const ver = urls[0].match(/(\d{8})/);
  return { fetched: Date.now(), crUrl, crVersion: ver ? ver[1] : '', commanderUrl: cmdUrl, rules: [...cmd, ...cr] };
}

async function getRules(force) {
  if (!mem) { try { mem = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { mem = null; } }
  if (mem && !force && Date.now() - mem.fetched < MAX_AGE) return mem;
  inflight = inflight || build().finally(() => { inflight = null; });
  try {
    mem = await inflight;
    try { fs.writeFileSync(CACHE, JSON.stringify(mem)); } catch { /* cache is best-effort */ }
    return mem;
  } catch (err) {
    if (mem) return { ...mem, stale: err.message };
    throw err;
  }
}

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(await getRules('refresh' in req.query));
  } catch (err) {
    res.status(502).json({ error: `Could not load rules: ${err.message}` });
  }
});

module.exports = router;
module.exports.parseCR = parseCR;
module.exports.parseCommander = parseCommander;
