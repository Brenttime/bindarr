// POST /api/cardscan/cards: on-device scan results -> hydrated card_cache rows.
// scryfallApi is stubbed so the test needs no network and no database.
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const apiPath = path.join(__dirname, '..', 'src', 'scryfallApi.js');
const asked = [];
require.cache[apiPath] = {
  id: apiPath, filename: apiPath, loaded: true,
  exports: {
    getCardById: async (id) => {
      asked.push(id);
      return id.endsWith('00000000-0000-0000-0000-000000000000') ? null
        : { id, name: 'Mine Collapse', set_id: 'mh2', number: '408', prices: { usd: '0.40' } };
    },
  },
};
const router = require('../src/routes/cardscan');

async function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ port, path: '/api/cardscan/cards', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
    });
    req.on('error', reject); req.end(data);
  });
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cardscan', router);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const id = '4c5d2b8e-1f4c-4a50-9b1d-1a2b3c4d5e6f';
    let r = await post(port, { results: [{ number: 1, scryfallId: id, title: 'mine collapse', via: 'title+collector (retro frame)' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].ok, true);
    assert.equal(r.body.results[0].number, 1);
    assert.equal(r.body.results[0].card.id, `mtg-${id}`);
    assert.equal(r.body.results[0].via, 'title+collector (retro frame)');
    assert.deepEqual(asked, [`mtg-${id}`]);

    // Unknown to the card database: reported, never silently dropped.
    r = await post(port, { results: [{ number: 2, scryfallId: '00000000-0000-0000-0000-000000000000' }] });
    assert.equal(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /not in the card database/);

    // Only Scryfall UUIDs reach the lookup.
    r = await post(port, { results: [{ number: 1, scryfallId: '../../etc/passwd' }] });
    assert.equal(r.status, 400);
    r = await post(port, { results: [] });
    assert.equal(r.status, 400);
    r = await post(port, { results: Array.from({ length: 9 }, () => ({ scryfallId: id })) });
    assert.equal(r.status, 400);
    console.log('cardscancards.test.js: ok');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
