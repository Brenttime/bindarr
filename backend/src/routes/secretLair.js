// Secret Lair drops: search a drop by name, preview its card list, and add the
// whole product to the collection in one action.
//
//   GET  /api/secret-lair?q=...        ranked search over the (cached) MTGJSON
//                                      drop index — each result carries the
//                                      base `fileName` and, when one exists,
//                                      `foil.fileName` (the real Foil Edition
//                                      product), which is how the client chooses
//                                      a printing
//   GET  /api/secret-lair/preview      resolve one product file's card list
//        ?fileName=<file>                to real, ownable card_cache rows
//   POST /api/secret-lair/add          file the whole product into the
//                                      collection at the chosen printing
//
// The foil/non-foil choice is a *product*, not a flag: MTGJSON ships a Secret
// Lair drop and its foil twin as two separate DeckList entries, each with its
// own card list and its own scryfallIds. The client passes the fileName of the
// one it wants (base, or the Foil Edition twin from `foil.fileName`), so every
// copy is filed under the printings the real product actually contains — never
// a guessed overlay. The `foil` body/query flag is a convenience for callers
// that only kept the base fileName: the server swaps in the drop's Foil Edition
// twin when MTGJSON publishes one, and reports a clear error when it does not.
//
// Auth is the server-wide /api authenticateToken middleware (see server.js);
// req.user is populated before these run, same as the precons router.
const express = require('express');
const { getPreconIndex } = require('../utils/preconData');
const { baseName, searchSecretLair, previewSecretLairDrop, addSecretLairToCollection } = require('../utils/secretLair');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Number(req.query.limit) || undefined;
  try {
    res.json(await searchSecretLair(q, { limit }));
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: `Secret Lair search failed: ${err.message}` });
  }
});

router.get('/preview', async (req, res) => {
  const fileName = String(req.query.fileName || '').trim();
  if (!fileName) return res.status(400).json({ error: 'fileName is required' });
  const wantFoil = req.query.foil === '1' || req.query.foil === 'true';
  try {
    const r = await resolveFoilFileName(fileName, wantFoil);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const out = await previewSecretLairDrop({ fileName: r.fileName, userId: req.user.id });
    res.json({ ...out, fileName: r.fileName, resolvedFoil: wantFoil && r.fileName !== fileName });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: `Secret Lair preview failed: ${err.message}` });
  }
});

router.post('/add', async (req, res) => {
  const body = req.body || {};
  const fileName = String(body.fileName || '').trim();
  if (!fileName) return res.status(400).json({ error: 'fileName is required' });
  const wantFoil = body.foil === true || body.foil === 'true' || body.foil === 1;
  try {
    const r = await resolveFoilFileName(fileName, wantFoil);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const out = await addSecretLairToCollection({
      fileName: r.fileName,
      user: req.user,
      printingMode: body.printingMode || 'auto',
      condition: body.condition,
      language: body.language,
      copies: body.copies,
    });
    // A product whose card list resolves to nothing real is a bad answer, not
    // a server fault: report it as unprocessable (with the count that DID
    // resolve) rather than a 200 that reads like a successful add.
    const anythingResolved = (out.resolvedCount || 0) > 0 || (out.added || 0) > 0;
    res.status(anythingResolved ? 200 : 422).json({
      ...out,
      fileName: r.fileName,
      resolvedFoil: wantFoil && r.fileName !== fileName,
      message: out.message
        || (out.added
          ? `Added ${out.added} card${out.added === 1 ? '' : 's'} from ${out.name}.`
          : anythingResolved
            ? `Nothing filed — ${out.unresolved || 0} card(s) could not be matched to your catalog.`
            : 'No cards could be read from this product.'),
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: `Secret Lair add failed: ${err.message}` });
  }
});

// A product whose card list names the Foil Edition variant in its fileName
// (MTGJSON's own convention: `<Name>FoilEdition_<CODE>`).
function isFoilFileName(fileName) {
  return /foiledition/i.test(String(fileName || ''));
}

// The foil choice is a second product file, not a flag on the first. When the
// caller asks for foil but handed the base fileName, swap in MTGJSON's own Foil
// Edition twin so the ask resolves to real foil printings (never a dead guess).
// A fileName that already names the Foil Edition product, or a drop with no
// foil twin and no foil request, passes through untouched.
async function resolveFoilFileName(fileName, wantFoil) {
  if (!wantFoil || isFoilFileName(fileName)) return { fileName };
  const index = await secretLairIndex();
  const hit = index.find((d) => String(d.fileName).toLowerCase() === String(fileName).toLowerCase())
    || index.find((d) => String(d.name).toLowerCase() === String(fileName).toLowerCase());
  if (!hit) return { fileName }; // not a known drop: let the card-list fetch answer honestly
  const needle = baseName(hit.name).toLowerCase();
  const twin = index.find((d) => isFoilFileName(d.fileName)
    && baseName(d.name).toLowerCase() === needle);
  if (!twin) return { error: 'This Secret Lair drop has no foil edition available.', status: 422 };
  return { fileName: twin.fileName };
}

// The Secret Lair slice of the (cached) MTGJSON index. getPreconIndex already
// walks the mirror with caching and returns every product row; filtering by the
// exact drop type here is what makes the foil-twin lookup O(1) network-free —
// the search route and the twin lookup share one warm cache rather than each
// re-downloading the 3k-row index on every foil add.
async function secretLairIndex() {
  const idx = await getPreconIndex();
  return (idx.decks || []).filter((d) => String(d.type || '') === 'Secret Lair Drop');
}

module.exports = router;
