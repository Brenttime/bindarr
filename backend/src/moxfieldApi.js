// Client for Moxfield's public read-only API (api2.moxfield.com).
//
// Moxfield has no published API contract; these endpoints are the ones its own
// website uses, scraped into the shape the community libraries document. They
// answer without authentication.
//
// The requests never go through node's HTTP stack: Cloudflare fronts the API
// and fingerprints the TLS *client* (JA3), and both node's handshake and the
// container's system curl (OpenSSL 3.0.x) get a 403 challenge page while a
// browser-shaped handshake gets straight through — verified side by side from
// the same container on the same egress IP. So we shell out to
// `curl-impersonate` (a static curl 8.21 built against BoringSSL that emits a
// Chrome 124 ClientHello). The Dockerfile downloads it into
// /usr/local/bin/curl-impersonate; on dev machines without it we fall back to
// plain `curl`, which may be challenged by Cloudflare.
//
// The three calls this feature needs:
//   getUser(username)          /v2/users/search-sfw   — does the author exist,
//                                                       and what are they called
//   getAuthorDeckSummaries     /v2/decks/search-sfw   — every public deck with
//                                                       its lastUpdatedAtUtc stamp
//   getDeckDetails(publicId)   /v3/decks/all/:id      — the full card list
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.MOXFIELD_API_BASE || 'https://api2.moxfield.com';
const TIMEOUT_S = 30;

// Chrome 124 TLS fingerprint: ciphers + key groups exactly as curl-impersonate's
// curl_chrome124 wrapper passes them. This is what makes the handshake
// indistinguishable from a real Chrome client to Cloudflare's bot detection.
const TLS_ARGS = [
  '--ciphers',
  'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
  '--curves',
  'X25519Kyber768Draft00:X25519:P-256:P-384'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  Referer: 'https://www.moxfield.com/',
  Accept: 'application/json'
};

// Prefer the bundled curl-impersonate; fall back to system curl (works on
// dev machines, but Cloudflare may challenge it depending on its TLS stack).
function pickCurlBinary() {
  const candidates = [
    process.env.MOXFIELD_CURL_BIN,
    '/usr/local/bin/curl-impersonate',
    path.join(__dirname, '..', '..', 'bin', 'curl-impersonate')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'curl';
}

const CURL_BIN = pickCurlBinary();

class MoxfieldError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MoxfieldError';
    this.status = status;
  }
}

// One GET through the curl binary. `-w '\n%{http_code}'` appends the status on
// its own line so a 4xx body (a Cloudflare page) and its code arrive in one
// capture.
function httpGet(path, params) {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const args = ['-sS', '-X', 'GET', '--max-time', String(TIMEOUT_S), '-w', '\n%{http_code}'];
  // curl-impersonate understands these; plain curl errors on unknown options,
  // so only pass the TLS args when we are actually running the impersonating build.
  if (CURL_BIN.includes('curl-impersonate')) args.push(...TLS_ARGS);
  for (const [k, v] of Object.entries(HEADERS)) args.push('-H', `${k}: ${v}`);
  args.push(url.toString());

  return new Promise((resolve, reject) => {
    execFile(CURL_BIN, args, { maxBuffer: 10 * 1024 * 1024, timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new MoxfieldError(`Could not reach Moxfield: ${String(stderr || err.message).slice(0, 200)}`, 0));
        return;
      }
      const nl = String(stdout).lastIndexOf('\n');
      const body = String(stdout).slice(0, nl);
      const status = parseInt(String(stdout).slice(nl + 1), 10) || 0;
      let data;
      try { data = body ? JSON.parse(body) : {}; }
      catch {
        // A non-JSON body with a non-2xx status is a challenge/interstitial page.
        if (status === 403) reject(new MoxfieldError('Moxfield blocked the request (rate limit or Cloudflare). It usually clears on its own; try again in a minute.', 403));
        else if (status === 404) reject(new MoxfieldError('Moxfield returned 404 (deck or user not found)', 404));
        else reject(new MoxfieldError(`Moxfield returned non-JSON (HTTP ${status})`, status || 0));
        return;
      }
      if (status === 404) reject(new MoxfieldError('Moxfield returned 404 (deck or user not found)', 404));
      if (status === 403) reject(new MoxfieldError('Moxfield blocked the request (rate limit or Cloudflare). It usually clears on its own; try again in a minute.', 403));
      if (status >= 200 && status < 300) resolve(data);
      else reject(new MoxfieldError(`Moxfield request failed with HTTP ${status}`, status));
    });
  });
}

// Resolve a username to Moxfield's canonical one (case-insensitive match).
// Returns { userName, displayName, profileImageUrl } or throws MoxfieldError.
async function getUser(username) {
  const data = await httpGet('/v2/users/search-sfw', {
    filter: username,
    pageNumber: 1,
    pageSize: 10
  });
  const entries = data.data || [];
  const match = entries.find(e => String(e.userName || '').toLowerCase() === String(username).toLowerCase())
    || entries[0];
  if (!match || !match.userName) {
    throw new MoxfieldError(`Moxfield has no user named "${username}"`, 404);
  }
  return {
    userName: match.userName,
    displayName: match.displayName || match.userName,
    profileImageUrl: match.profileImageUrl || null
  };
}

// Every public deck of an author, all pages. Each summary carries
// publicId, name, format, the board counts and — the important one —
// lastUpdatedAtUtc, which is what makes the fast content check cheap.
async function getAuthorDeckSummaries(username, { pageSize = 100 } = {}) {
  const decks = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const data = await httpGet('/v2/decks/search-sfw', {
      authorUserNames: username,
      pageNumber: page,
      pageSize,
      sortType: 'Updated',
      sortDirection: 'Descending',
      filter: '',
      fmt: '',
      includePinned: true,
      showIllegal: true
    });
    const rows = data.data || [];
    decks.push(...rows);
    totalPages = parseInt(data.totalPages, 10) || page;
    if (rows.length === 0) break;
    page += 1;
  }
  return decks;
}

// The full deck: boards.mainboard/sideboard/maybeboard/commanders as maps of
// { cardId: { quantity, card: { scryfall_id, name, set, ... } } }.
async function getDeckDetails(publicId) {
  return httpGet(`/v3/decks/all/${encodeURIComponent(publicId)}`);
}

module.exports = { getUser, getAuthorDeckSummaries, getDeckDetails, MoxfieldError, httpGet, BASE_URL };
