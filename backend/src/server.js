// Load .env from the CWD first (how a normal `npm start` from backend/ behaves),
// then from backend/ explicitly. dotenv never overwrites an already-set variable,
// so the first one to define a key still wins and nothing changes for existing
// deployments — this only rescues the case where the server was launched by
// absolute path from some other directory, which silently ignored the file and
// left settings like HTTPS_PORT looking as though they had no effect.
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const db = require('./db');
const tcgApi = require('./tcgApi');
const scryfallApi = require('./scryfallApi');

const authRoutes = require('./routes/auth');
const sharedRoutes = require('./routes/shared');
const adminRoutes = require('./routes/admin');
const collectionRoutes = require('./routes/collection');
const storageRoutes = require('./routes/storage');
const statsRoutes = require('./routes/stats');
const importExportRoutes = require('./routes/importExport');
const setsRoutes = require('./routes/sets');
const decksRoutes = require('./routes/decks');
const settingsRoutes = require('./routes/settings');
const tagsRoutes = require('./routes/tags');
const notesRoutes = require('./routes/notes');
const cardArtRoutes = require('./routes/cardArt');
const { getAuditLogs, revertAuditEvent } = require('./utils/auditLogger');
const { startHttps, selfSignedTls } = require('./utils/tls');


const app = express();
const PORT = process.env.PORT || 3001;

// The index directories are created here, at startup, as the app's own user —
// deliberately not by the root entrypoint. A directory root creates inside a
// volume that has already been handed over to `node` is one this process can
// never write into, and the first thing to notice was a build dying hours later
// with `EACCES: mkdir '/app/database/index/.staging-mtg'`.
//
// Probed with a real write rather than fs.access(W_OK): access reports the
// permission bits, which is not the same question as whether this filesystem
// will accept a file (NFS/SMB squash a root-owned mount's bits into a yes it
// does not honour). Unwritable is not fatal — the collection, scanning by set
// code, and everything else still work — so it says so plainly and carries on.
function ensureWritable() {
  const fs = require('fs');
  const setIndex = require('./setIndex');
  for (const dir of [require('./utils/globalIndexPaths').DATA_DIR, setIndex.SETS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      console.error(`STARTUP: ${dir} is not writable (${err.code}) — scan index builds will fail.`);
      console.error('STARTUP: fix it with  docker exec -u root <container> chown -R node:node /app/database');
    }
  }
}
ensureWritable();

// Behind a reverse proxy (nginx/Traefik/Caddy terminating TLS — effectively
// required, since mobile camera access needs HTTPS), set TRUST_PROXY so req.ip
// and the rate limiters use the real client IP from X-Forwarded-For instead of
// the proxy's. Leave it UNSET when the app is directly exposed: trusting that
// header otherwise lets any client spoof its IP and defeat the rate limiter.
// Accepts a hop count ("1"), "true", or an express trust-proxy string ("loopback").
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : (Number.isNaN(Number(tp)) ? tp : Number(tp)));
}

// Content Security Policy. Card identification is server-side (the client just
// POSTs a photo to /api/scan-match), so the browser needs nothing beyond the
// app's own bundle plus the card-image hosts. Kept Report-Only for now: flip
// `reportOnly` to false to enforce once a production smoke test confirms the
// scan flow and card images load cleanly under these directives.
// ponytail: Report-Only ceiling — enforce after a prod verification pass.
app.use(helmet({
  // HSTS pins the host to HTTPS in the browser. When we terminate TLS ourselves
  // with a self-signed certificate that is a lockout: Chrome stops offering the
  // "proceed anyway" bypass, and http://<host>:3001 gets upgraded too. Left at
  // helmet's default (on) for every other deployment, including a reverse proxy
  // with a real certificate.
  hsts: !selfSignedTls(),
  contentSecurityPolicy: {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' is what lets the browser compile WebAssembly. The card
      // scanner runs OpenCV.js locally to find the card in the frame, and without
      // this the wasm is refused outright. Harmless today because the policy is
      // report-only, but it would silently break scanning the moment that flips.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://images.pokemontcg.io', 'https://cards.scryfall.io', 'https://c1.scryfall.com', 'https://img.scryfall.com', 'https://assets.tcgdex.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

// Restrict cross-origin access to known frontend origins. Localhost + private-
// LAN origins are ALWAYS allowed (see PRIVATE_ORIGIN below); CORS_ORIGIN adds
// public origins on top (e.g. a reverse-proxy domain) rather than replacing the
// LAN allowance, so a self-hosted instance behind a proxy stays reachable both
// ways without listing the LAN IP. The Vite dev server runs with host:true +
// HTTPS so the mobile scanner can reach it over the LAN, which makes the
// browser send an Origin like https://192.168.1.20:5173 on writes (PUT/POST/
// DELETE) — GETs are same-origin and send none, which is why only writes were
// being rejected before.
const explicitOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The reverse-proxy domain is already configured as PUBLIC_BASE_URL for share
// links, so reuse its origin as an allowed CORS origin — setting it alone is
// enough for proxied logins, no separate CORS_ORIGIN needed.
if (process.env.PUBLIC_BASE_URL) {
  try { explicitOrigins.push(new URL(process.env.PUBLIC_BASE_URL).origin); }
  catch { /* malformed URL — ignore */ }
}

// Loopback + RFC1918 private ranges (10/8, 172.16-31/12, 192.168/16) and
// *.local, with any scheme/port. Not internet-routable, so this is safe for a
// self-hosted app while still blocking arbitrary public websites.
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.local)(:\d+)?$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser client
  if (PRIVATE_ORIGIN.test(origin)) return true; // localhost + private LAN, always
  return explicitOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
// Default 100kb body limit is too small for the collection import/export
// feature: a JSON backup wraps the export payload in a string field, which
// added escaping overhead pushed a ~90-card collection past the default
// limit already. 15mb comfortably covers even large (multi-thousand card)
// collections.
app.use(express.json({ limit: '15mb' }));

// gzip matters for the API payload as much as for static assets: a
// multi-thousand-card collection's /api/collection response is tens of MB of
// JSON, and must be registered BEFORE the API routes below or it never sees
// them. For the scanner specifically, card detection runs in the browser
// against OpenCV.js, which is an ~11 MB chunk. Uncompressed that is a long
// wait on a phone over wifi and, worse, a stall that looks like a hang.
// Compressed it is ~3.5 MB, and it is immutable-hashed so it is fetched once.
app.use(compression());

// Initialize Database on startup
db.initDb()
  .then(async () => {
    console.log('Database tables verified/created successfully.');

    // Un-stack legacy multi-quantity entries so every copy is its own row (one
    // physical card = one storage slot). No-op once migrated.
    const { splitStackedEntries } = require('./utils/collectionHelpers');
    const splitCount = await splitStackedEntries(db);
    if (splitCount > 0) console.log(`Split ${splitCount} stacked collection copies into individual rows.`);

    // Sync sets on startup (both games)
    await tcgApi.fetchAndCacheSets();
    await scryfallApi.fetchAndCacheSets();

    // Load sets into compartmentSort memory cache
    const { loadSetsCache } = require('./utils/compartmentSort');
    await loadSetsCache(db);

    // A global index build takes hours, so a restart mid-build used to leave the
    // panel showing nothing in flight and the staged work invisible. Surface any
    // interrupted build so it can be resumed rather than restarted from zero.
    try {
      const globalIndex = require('./globalIndex');
      const langCodes = require('./utils/languages').LANGUAGES.map(l => l.code);
      globalIndex.restoreInterrupted(langCodes);
      // Not awaited: this is a rollup re-concatenation on an upgrade from an
      // install whose rollup predates the hash columns, and does nothing at all
      // on every other boot, so it must not hold up listening. Until it finishes,
      // code-free scanning reports "not built" — which is the truth.
      globalIndex.backfillRecall(langCodes)
        .catch(err => console.warn('Could not derive missing recall indexes:', err.message));
    } catch (err) {
      console.warn('Could not restore interrupted global builds:', err.message);
    }

    // Weekly: refresh sets (picks up newly released ones) and reload the
    // in-memory sets cache so chronological sorting stays current without a
    // restart. Scryfall's guidance is that gameplay/set data changes rarely and
    // weekly is plenty — prices are on their own schedule below.
    setInterval(async () => {
      try {
        await tcgApi.fetchAndCacheSets(true);
        await scryfallApi.fetchAndCacheSets(true);
        await loadSetsCache(db);
      } catch (err) {
        console.error('Weekly sets refresh failed:', err);
      }
    }, 1000 * 60 * 60 * 24 * 7);

    // Daily: prices. Scryfall refreshes prices once a day, so this is both the
    // most often worth doing and the most often allowed. `force` because the
    // interval itself is already the right cadence.
    setInterval(() => {
      tcgApi.updateCollectionPrices(true);
      scryfallApi.updateCollectionPrices(true);
      // Non-English Pokémon cards: their ids 404 on pokemontcg.io, so tcgApi's
      // sweep skips them and this is their only price refresh. No-op until the
      // user actually owns one.
      require('./tcgdexApi').updateCollectionPrices(true);
      // TCGCSV runs LAST of the Pokémon sweeps on purpose. It writes the same
      // columns as the other two and is the better source — TCGplayer market
      // prices in USD, and 97% coverage against TCGdex's 8% — so it should have
      // the final say on any card it can place.
      require('./tcgcsvApi').updateCollectionPrices(true);
    }, 1000 * 60 * 60 * 24);

    // Shortly after startup, catch up if the last sweep was over a day ago.
    // NOT forced: without that gate this re-ran on every restart, which under
    // nodemon meant a full sweep on every code edit — for data that cannot have
    // changed since the last one.
    setTimeout(() => {
      tcgApi.updateCollectionPrices();
      scryfallApi.updateCollectionPrices();
      require('./tcgdexApi').updateCollectionPrices();
      require('./tcgcsvApi').updateCollectionPrices();
    }, 30000);

    // Periodically purge expired sessions so the table doesn't grow unbounded
    setInterval(() => {
      db.run(`DELETE FROM sessions WHERE expires_at <= DATETIME('now')`).catch(err => {
        console.error('Failed to purge expired sessions:', err);
      });
    }, 1000 * 60 * 60 * 24);

    // Periodic auto-backup (BACKUP_INTERVAL_HOURS, default 24; 0 disables)
    require('./backup').startAutoBackup();

  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
  });

// Readiness/liveness probe for orchestrators (Docker HEALTHCHECK, etc.).
// Unauthenticated; pings the DB so a wedged database reads as unhealthy.
// Declared before the /api collection mount so nothing shadows it.
app.get('/api/health', async (req, res) => {
  res.setHeader('X-App-Name', 'Bindarr');
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// --- API ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/shared', sharedRoutes);
app.use('/api/admin', adminRoutes);
// Ahead of the bare '/api' mounts so nothing shadows it. Its reads are
// deliberately unauthenticated — a public shared collection renders card art too.
app.use('/api/card-art', cardArtRoutes);
app.use('/api', collectionRoutes);
app.use('/api', storageRoutes);
app.use('/api', statsRoutes);
app.use('/api', importExportRoutes);
app.use('/api', tagsRoutes);
app.use('/api', notesRoutes);
app.get('/api/audit-logs', getAuditLogs);
app.post('/api/audit-logs/:id/revert', revertAuditEvent);
app.use('/api/sets', setsRoutes);
app.use('/api/decks', decksRoutes);
app.use('/api/settings', settingsRoutes);

// (compression() is registered early, before the API routes — see above.)
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Catch-all route to serve Index.html in production
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Generic error handler (e.g. rejected CORS origins) — never leak stack traces to clients
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Try exporting/importing in smaller batches.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`Bindarr Server running on port ${PORT}`);
  console.log(`Access local: http://localhost:${PORT}`);
  console.log(`=========================================`);
  // Camera scanning needs a secure context, so a LAN/Docker install serves TLS
  // too when HTTPS_PORT is set. Certificates live beside the database.
  startHttps(app, path.join(path.dirname(db.dbPath), 'ssl'));
  // Warm the scan worker pool so the first set-scoped scan doesn't pay worker
  // spawn + opencv-wasm load. No-op when SCAN_WORKERS=0.
  try { require('./scanPool').getPool(); } catch (e) { console.warn('scanPool warmup skipped:', e.message); }
});
