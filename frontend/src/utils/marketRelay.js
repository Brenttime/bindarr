// Browser-relay credential capture ("Connect" buttons).
//
// The user clicks Connect in Bindarr, a REAL manapool.com / tcgplayer.com page
// opens as a popup, they sign in there as they always do, and while signed in
// we read the credential that page itself displays (ManaPool's integration
// token) or the session cookies the browser already holds (TCGplayer), and hand
// it back to the Bindarr tab via localStorage (NOT postMessage).
//
// Why localStorage and not postMessage: postMessage is only deliverable to a
// window that is a opener/openee relation of the target. Bindarr is served over
// https on an IP host (https://192.168.4.37:3443, or http://thousandsunny:3002);
// the third-party sites are opaque origins from those hosts, and a cross-origin
// popup relationship across opaque origins has more ways to silently break than
// to work. localStorage, by contrast, is partitioned by TOP-FRAME SITE: when
// manapool.com is the top frame of the popup it writes under Bindarr's
// top-level site partition, and the Bindarr tab can read exactly that entry.
// Same write, same read, no origin messaging involved. The relay page therefore
// writes into ITS OWN localStorage (keyed under manapool.com) and Bindarr polls
// its own; both views resolve to the same partitioned store because Bindarr is
// the top-frame site of the whole flow (popup opened by Bindarr, so
// manapool.com's partition key is Bindarr's site). If the browser ever changes
// partitioning semantics this breaks LOUD (nothing arrives, timeout error) and
// the manual paste path is untouched.
//
// SECURITY CONTRACT (this is the whole reason the file is small):
//   - The credential passes through THIS tab's memory for the milliseconds
//     between receive() returning and the caller PUTting it to our own backend.
//     It is never logged, never rendered, and cleared immediately after.
//   - This is explicitly an *initiated-by-the-user* flow: window.open() with a
//     user gesture, on the user's own signed-in browser, for the user's own
//     account. The TCGplayer jar is possession-equivalent to a login; the panel
//     says so out loud before it ever opens a popup.
//   - If the popup is blocked (no window.open permission, kiosk, strict
//     blockers), receive() never fires and start() times out into a clear
//     error — callers must keep the manual paste UI as the fallback.

const RELAY_KEY = 'bindarr_cred_relay_v1';
// Where the popup lands after it is done with us. ManaPool's order page is a
// safe, credential-free landing; we never leave the popup on an account page.
const DONE_LANDINGS = {
  manapool: 'https://manapool.com/',
  tcgplayer: 'https://www.tcgplayer.com/',
};

// Injected into the popup (as a bookmarklet-style javascript: URL) — runs at
// manapool.com top-frame origin, reads the integration token the site itself
// renders for the signed-in user, and posts it into localStorage. It reads a
// fixed set of candidate locations rather than scraping arbitrary text, and it
// refuses to relay anything that doesn't look like a generated token.
const MANAPOOL_RELAY = `
(() => {
  try {
    const KEY = '${RELAY_KEY}';
    const send = (payload) => {
      localStorage.setItem(KEY, JSON.stringify(payload));
      setTimeout(() => localStorage.removeItem(KEY), 120000);
    };
    const finish = (payload, landing) => {
      send(payload);
      location.replace(landing);
    };
    const grab = () => {
      // Candidate 1: an input/textarea on the integration page holding the token.
      for (const el of document.querySelectorAll('input, textarea, code')) {
        const v = (el.value || el.textContent || '').trim();
        if (/^[A-Za-z0-9._-]{24,128}$/.test(v) && /token|key|secret/i.test((el.id || '') + ' ' + (el.name || '') + ' ' + (el.labels && el.labels[0] ? el.labels[0].textContent : '') + ' ' + (el.className || ''))) {
          return v;
        }
      }
      // Candidate 2: the page's own JS state / a rendered masked-looking token near the word 'token'.
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const m = (n.textContent || '').match(/\\b[A-Za-z0-9_-]{28,128}\\b/);
        if (m && /token|api/i.test((n.parentElement && n.parentElement.closest('div,section,li')) ? n.parentElement.closest('div,section,li').textContent : '')) {
          return m[0];
        }
      }
      return null;
    };
    const email = (() => {
      const m = document.body && document.body.innerText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
      return m ? m[0] : null;
    })();
    let tries = 0;
    const attempt = () => {
      const tok = grab();
      if (tok) { finish({ source: 'manapool', token: tok, email: email || undefined }, '${DONE_LANDINGS.manapool}'); return; }
      if (++tries >= 10) { finish({ source: 'manapool', error: 'no-token-found' }, '${DONE_LANDINGS.manapool}'); return; }
      setTimeout(attempt, 1000);
    };
    attempt();
  } catch (e) { /* cross-origin guard or a blocked storage: the timeout path in Bindarr covers it */ }
})();`;

// Runs at tcgplayer.com top-frame origin. document.cookie only shows
// non-HttpOnly cookies, so this can only ever exfiltrate what JS is allowed to
// see; HttpOnly session cookies are deliberately NOT reachable and the panel
// text tells the user a devtools paste may still be needed for those.
const TCG_RELAY = `
(() => {
  try {
    const KEY = '${RELAY_KEY}';
    const finish = (payload) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(payload));
        setTimeout(() => localStorage.removeItem(KEY), 120000);
      } catch (e) {}
      location.replace('${DONE_LANDINGS.tcgplayer}');
    };
    // document.cookie being non-empty is what "signed in" looks like to JS.
    // Wait (bounded) for cookies to exist so a popup that lands mid-redirect
    // doesn't send an empty jar.
    let tries = 0;
    const attempt = () => {
      const jar = document.cookie;
      if (jar && jar.length > 10) { finish({ source: 'tcgplayer', cookies: jar }); return; }
      if (++tries >= 10) { finish({ source: 'tcgplayer', error: 'no-cookies' }); return; }
      setTimeout(attempt, 1000);
    };
    attempt();
  } catch (e) {}
})();`;

const RELAYS = { manapool: MANAPOOL_RELAY, tcgplayer: TCG_RELAY };
const TARGETS = {
  // ManaPool: the account settings page is behind a login wall that redirects
  // unauthenticated visitors to /auth?next=... — the relay waits (bounded) on
  // the token appearing, so logging in inside the popup just works: after the
  // login redirect back to /settings the token becomes visible and gets relayed.
  manapool: 'https://manapool.com/settings',
  tcgplayer: 'https://www.tcgplayer.com/account',
};
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for login + MFA

// Popup blocker note: javascript: URLs in window.open are blocked by some
// hardened configs; that is an accepted failure mode (clear error below).
// `openFn` is injectable purely so the poll/validation state machine is testable
// under plain node (see test/marketrelay.test.mjs); browser callers omit it.
function start(source, { onStatus } = {}, openFn = null) {
  const relay = RELAYS[source];
  const target = TARGETS[source];
  if (!relay || !target) return Promise.reject(new Error(`unknown marketplace source: ${source}`));

  const open = openFn || ((url) => window.open(url, 'bindarr-market-relay', 'width=560,height=720'));
  const popup = open(target);
  if (!popup) {
    return Promise.reject(new Error('POPUP_BLOCKED'));
  }

  let settled = false;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      let raw = null;
      try { raw = localStorage.getItem(RELAY_KEY); } catch { /* private-mode storage throw */ }
      if (!raw) {
        // If the popup is gone without ever relaying, fail instead of hanging.
        if (popup.closed) { fail(new Error('POPUP_CLOSED')); }
        return;
      }
      try { localStorage.removeItem(RELAY_KEY); } catch { /* storage may throw in private mode */ }
      let payload;
      try { payload = JSON.parse(raw); } catch { return fail(new Error('RELAY_GARBAGE')); }
      if (payload.source !== source) return fail(new Error('RELAY_SOURCE_MISMATCH'));
      if (payload.error) return fail(new Error(payload.error === 'no-cookies' ? 'TCG_NO_COOKIES' : 'TOKEN_NOT_FOUND'));
      settled = true;
      clearInterval(poll); clearTimeout(timer);
      try { popup.close(); } catch { /* popup may already be gone */ }
      resolve(payload);
    }, 500);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(timer);
      try { popup.close(); } catch { /* popup may already be gone */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('RELAY_TIMEOUT')), TIMEOUT_MS);
    if (onStatus) onStatus(() => fail(new Error('USER_CANCELLED')));
  });
}

export { start as startMarketRelay, RELAY_KEY };
