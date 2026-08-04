<div align="center">

<img src="frontend/public/logo.svg" width="120" height="120" alt="" />

# Bindarr

**Scan, value, organize, and locate your Pokémon & Magic: The Gathering cards — self-hosted.**

Identify physical cards with your phone's camera, track real-time market valuations, map every card to its binder/box slot, view rich analytics, and export your database for external trackers.

[![CI](https://img.shields.io/github/actions/workflow/status/thenotoriousJeremy/bindarr/docker-build.yml?branch=main&label=CI&logo=github)](https://github.com/thenotoriousJeremy/bindarr/actions/workflows/docker-build.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-bindarr-2496ED?logo=docker&logoColor=white)](https://github.com/thenotoriousJeremy/bindarr/pkgs/container/bindarr)
[![License: MIT](https://img.shields.io/github/license/thenotoriousJeremy/bindarr?color=blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/thenotoriousJeremy/bindarr?style=flat&logo=github)](https://github.com/thenotoriousJeremy/bindarr/stargazers)
[![Issues](https://img.shields.io/github/issues/thenotoriousJeremy/bindarr)](https://github.com/thenotoriousJeremy/bindarr/issues)
[![Last commit](https://img.shields.io/github/last-commit/thenotoriousJeremy/bindarr)](https://github.com/thenotoriousJeremy/bindarr/commits/main)

**[Live Demo](https://thenotoriousjeremy.github.io/bindarr/)** · [Download & Run](#download--run-easiest) · [Run with Docker](#docker-deployment) · [Quick Start (Dev)](#quick-start-development) · [Features](#features) · [How Scanning Works](#card-scanning--match-data) · [Report a Bug](https://github.com/thenotoriousJeremy/bindarr/issues/new)

</div>

---

## Demo

https://github.com/user-attachments/assets/4ee6c23f-a024-499b-9fc3-3d144c42ba61

---

## Live Demo

Try it in your browser, no install: **[thenotoriousjeremy.github.io/bindarr](https://thenotoriousjeremy.github.io/bindarr/)**

The demo runs the real frontend against baked-in sample data (no backend) so you can click through the dashboard, collection, storage, and decks. It's read-only: edits are accepted but not saved ("Demo mode: changes are not saved."), and camera scanning is disabled (it needs a server). For the full app, [download and run it](#download--run-easiest).

---

## Table of Contents

- [Live Demo](#live-demo)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Download & Run (easiest)](#download--run-easiest)
- [Run with Docker](#docker-deployment)
- [Quick Start (Development)](#quick-start-development)
- [First-Time Sign In](#first-time-sign-in)
- [Deck Checkout & Check-In](#deck-checkout--check-in)
- [Card Scanning & Match Data](#card-scanning--match-data)
- [Backup, Restore & Recovery](#backup-restore--recovery)
- [Project Structure](#project-structure)
- [Translating Bindarr](#translating-bindarr)
- [License](#license)

---

## Features

- **Phone-Camera Image Identification**: Point your phone at a card and the server identifies it from the image — no typing. The pipeline auto-crops/deskews the card (OpenCV), recalls candidates with **CLIP** image embeddings, and confirms the exact card with **ORB** feature matching + RANSAC homography verification. Enter the **MTG set code** you're feeding and matching is scoped to that set (~300 cards) for exact-printing accuracy at one-tap speed. Works for both **Magic** (Scryfall) and **Pokémon** (Pokémon TCG API), with automatic game detection.
- **Confidence Gating & Manual Pick**: Every scan is gated on match confidence — ORB inlier count when geometric verification ran, otherwise CLIP cosine similarity. Above the gate the card auto-fills; below it the top candidates are shown for a one-tap manual pick.
- **Interactive Dashboard & Metrics**: Track total collection value, net worth trends (24H / 7D / 30D), average card value, holo print rates, energy type distributions (pie chart), rarity distributions, and set completion milestones.
- ** Real-world Location Coordinator**: Assign physical coordinate mappings to your cards so you can locate them instantly:
  - **Binders**: Maps by Binder Name, Page Number, and Slot (1-9). Features a double-page book view with 3D page-flip animations and multi-card slot stacking.
  - **Storage Boxes**: Maps by Box Name, Row ID/Letter, and Divider Section.
- **Deck Checkout & Check-In**: Reserve the physical cards for a deck and find them fast. Checking a deck out "for play" opens a locator that groups every card by **container → page → slot** and highlights each one in its compartment grid; while checked out, those cards are greyed and badged **In Play** in Storage. Checking the deck back in reverses the flow, guiding each card back to its slot. Select-all by page, container, or the whole deck.
- **Manual Search & Bulk Add**: Search by name, set, or collector number across both games. Browse an entire set with paging (30–250 per page) and a real match count, with set-code autocomplete over every known set. Cards you already own are badged with their quantity so a set browse doesn't invite duplicates. Long-press or **Select** to multi-select — shift-click grabs everything in between — then add the whole selection in one action.
- **Rapid Add**: Pin a set, type a collector number, press Enter. The card goes straight in and the field stays focused for the next one, with a running receipt and per-card undo. Entering a set plus a number opens Quick Add directly, since that identifies exactly one card.
- **Universal Database Exports**: One-click downloads of your complete database in CSV (TCGplayer format compatible) or JSON.
- **Multi-User Auth**: Session-token authentication (opaque random tokens stored in a server-side `sessions` table, sent as a `Bearer` header) with admin controls for managing users and roles.
- **100% Self-Hostable & Portable**: Single-container Docker build with a local SQLite database that mounts to a persistent volume.
- **CI/CD Automation**: GitHub Actions workflow to auto-build and publish the container image to GitHub Container Registry (GHCR).

---

##  Tech Stack

- **Frontend**: React, Vite, Recharts, Lucide React, Canvas Confetti
- **Backend**: Node.js, Express, SQLite (`sqlite3` module), Axios, Helmet, express-rate-limit
- **Card image ID**: `@huggingface/transformers` (CLIP embeddings via ONNX), `opencv-wasm` (ORB + homography), `sharp` (image processing)
- **Card data**: Pokémon TCG API (Pokémon), Scryfall (Magic)
- **Deployment**: Docker, Docker Compose, GitHub Actions

---

## Download & Run (easiest)

No Docker, no clone, no build. Every release ships a self-contained server you download, unzip, and double-click. Grab the file for your OS from the **[latest release](https://github.com/thenotoriousJeremy/bindarr/releases/latest)**:

| OS | Download | Run |
|----|----------|-----|
| **Windows** | `Bindarr-Server-windows-x64.zip` | Unzip, double-click **`bindarr-server.exe`** |
| **Linux** | `Bindarr-Server-linux-x64.tar.gz` | `tar xzf` it, then `chmod +x bindarr-server && ./bindarr-server` |
| **macOS** (Apple Silicon) | `Bindarr-Server-macos-arm64.tar.gz` | `tar xzf` it, then `chmod +x bindarr-server && ./bindarr-server` |

Then open **`http://localhost:3001`**.

The bundle is a Node Single Executable App with the backend, frontend, and dependencies inside. Your data (a SQLite file) is created next to the binary on first run.

**First login:** on first startup a default `admin` account is created and its password is printed **once** to the console window. To pin a known password instead, copy `app/backend/.env.example` to `app/backend/.env` and set `DEFAULT_ADMIN_PASSWORD=` before first run. See [First-Time Sign In](#first-time-sign-in).

> [!NOTE]
> **Scanning out of the box:** set-scoped Magic matching works immediately (it builds a set's index on demand the first time you scan it). Code-free matching and Pokémon/Magic game auto-detection need the pre-built embedding databases, which are **not** bundled (they're large). Build them once into `app/backend/data/` — see [Card Scanning & Match Data](#card-scanning--match-data).

> [!TIP]
> **Phones:** grab **`Bindarr-Android.apk`** from the same release and install it (allow "install from unknown sources"). iOS is distributed via TestFlight. The mobile apps talk to a Bindarr server, so run one of the options above (or Docker) and point the app at it.

> [!TIP]
> **Reaching it from another device?** `http://localhost:3001` scans cards fine, but `http://<your-ip>:3001` from a phone or laptop cannot — browsers only allow camera access over HTTPS. Add `HTTPS_PORT=3443` to `app/backend/.env` and the same app is also served at `https://<your-ip>:3443`, with a self-signed certificate to click past once. Details in [Two ports, one app](#two-ports-one-app-pick-the-one-that-matches-your-setup).

Prefer containers, or running as a background service? Use [Docker](#docker-deployment). Want to hack on the code? See [Quick Start (Development)](#quick-start-development).

---

## Quick Start (Development)

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### Installation
1. Clone this repository.
2. Install dependencies for the root, frontend, and backend packages:
   ```bash
   npm run install:all
   ```

### Running the App
Start both the React development server and the Express API server concurrently:
```bash
npm run dev
```
- **Frontend client**: `https://localhost:5173` (Runs over local HTTPS to allow camera access)
- **Backend API server**: `http://localhost:3001`

> [!IMPORTANT]
> **Mobile Camera HTTPS Requirement**: Modern mobile browsers (Safari, Chrome, Firefox) restrict video camera access (`getUserMedia`) to **Secure Contexts (HTTPS)** only. 
> 
> To test on your mobile phone:
> 1. Connect your phone and computer to the same Wi-Fi network.
> 2. Open **`https://<your-computer-ip>:5173`** in your mobile browser.
> 3. Your browser will display a warning because the local developer SSL certificate is self-signed. Tap **Advanced** (or *Show Details*) and select **Proceed/Trust** (e.g. *Proceed to 192.168.x.x (unsafe)*). The app will load, and the camera will initialize successfully!

#### Alternative: Chrome Developer Flags (HTTP)
If you prefer not to use self-signed HTTPS in development:
1. Open Google Chrome on your phone.
2. Navigate to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
3. Enable the flag and enter your computer's IP: `http://<your-computer-ip>:5173` (and port `3001` for container testing).
4. Relaunch Chrome. The browser will treat this address as secure, allowing camera access.


---

## First-Time Sign In

On its **first startup**, Bindarr creates a default administrator account and prints the credentials to the server console (the terminal running `npm run dev` / `npm start`, the console window of the downloaded `bindarr-server` binary, or `docker compose logs`).

Look for these lines in the startup logs:
```text
Created default admin user. ID: 1
  username: admin
  password: <generated-password>
Log in and change this password immediately via Settings.
```

- **Username**: `admin`
- **Password**:
  - If you set the `DEFAULT_ADMIN_PASSWORD` environment variable before first startup, that value is used.
  - Otherwise a random password is generated and printed **once** in the logs above. Copy it before clearing your terminal.

> [!IMPORTANT]
> The password is only printed on the run that creates the account (when the database is first initialized). If you miss it and did not set `DEFAULT_ADMIN_PASSWORD`, delete the SQLite database file so it is recreated on the next startup, or set `DEFAULT_ADMIN_PASSWORD` and recreate the database.

After logging in, open **Settings** and change the password. Additional users can self-register from the login screen (they are created with the `member` role); an `admin` can manage users and roles from the **Admin** panel.

---

## Deck Checkout & Check-In

Decks let you reserve the physical cards you need for a game and locate them fast. Checkout and check-in **never move your cards** in the database — a card's stored slot is both where you grab it and where it returns. The only thing that changes is the deck's checked-out status, which drives the greying in Storage.

### Checking out (grab cards for play)
1. Open the **Decks** tab, select a deck, and click **Checkout**.
2. The app verifies you own enough copies (copies already committed to other checked-out decks are excluded). If you're short, it lists what's missing and stops.
3. A **locator** opens, grouped by where each card lives:
   - **Container → Page** (e.g. `binder → Page 5`). Each located page renders its compartment grid with the cards you need highlighted in green.
   - **Unassigned Pile** for cards not yet filed into a container (no grid).
4. Tick each card as you pull it. Progress shows `N of M pulled`. Use **Select all** at the page, container, or whole-deck level to check off groups at once.

While a deck is checked out, its cards show **greyed with an "In Play" badge** in the Storage view, so you can see which slots are empty at a glance. If you pull only some copies of a stack, the badge reads `1/2 Out`.

### Checking in (put cards back)
1. Click **Return** on a checked-out deck.
2. The same locator opens in reverse — **Return to Storage** — showing where each card goes back (container → page → slot, highlighted in the grid).
3. Tick cards as you re-file them; the same select-all controls apply.

---

## Docker Deployment

Prefer containers, or want it running as a restart-on-boot background service? Bindarr also ships as a single container (multi-stage build, serves the compiled frontend from the Node server) published to GitHub Container Registry. **No clone or build needed** — copy the compose file below and run.

### Run with the prebuilt image (copy-paste)

1. Create a `docker-compose.yml`:
   ```yaml
   services:
     bindarr:
       image: ghcr.io/thenotoriousjeremy/bindarr:latest
       container_name: bindarr
       restart: unless-stopped
       ports:
         - "3001:3001"   # HTTP  — point a reverse proxy here
         - "3443:3443"   # HTTPS — use this directly when you have no proxy (needed for card scanning)
       environment:
         # All optional. Uncomment and set as needed.
         # - HTTPS_PORT=3443             # already the image default; set to "" to serve plain HTTP only
         # - SSL_CERT_PATH=              # your own cert (e.g. /app/database/certs/fullchain.pem); omit for auto self-signed
         # - SSL_KEY_PATH=               # its private key
         # - POKEMON_TCG_API_KEY=        # free key from dev.pokemontcg.io raises rate limits
         # - PUBLIC_BASE_URL=            # external URL behind a proxy, e.g. https://cards.example.com. Share links + auto-allowed as a CORS origin (proxied logins work with just this)
         # - DEFAULT_ADMIN_PASSWORD=     # pin the initial admin password (else it's auto-generated in the logs)
         # - ALLOW_REGISTRATION=         # "true" to allow open self-registration; default is invite-only
         # - TRUST_PROXY=                # "1" when behind a TLS-terminating reverse proxy
       volumes:
         - bindarr-data:/app/database

   volumes:
     bindarr-data:
   ```

2. Start it:
   ```bash
   docker compose up -d
   ```

3. Open `http://localhost:3001`. Grab the auto-generated admin password from the logs (`docker compose logs | grep password`) — see [First-Time Sign In](#first-time-sign-in). All data persists in the `bindarr-data` volume.

> [!TIP]
> Update to the newest image any time with `docker compose pull && docker compose up -d`. Your data in the volume is untouched.

### Two ports, one app: pick the one that matches your setup

The container serves the **same Bindarr, same database, same everything** on both ports. They are not two modes or two instances — only the transport differs, and you can hit both at once from different devices.

| Port | Serves | Use it when |
| --- | --- | --- |
| `3001` | plain HTTP | **You have a reverse proxy.** Point Caddy / Nginx Proxy Manager / Traefik / Tailscale Serve at this port and let it terminate TLS. Also fine for `http://localhost:3001` on the machine running the container. |
| `3443` | HTTPS (self-signed by default) | **You have no reverse proxy** and want to reach Bindarr from a phone or another computer — including **card scanning**, which browsers only allow over HTTPS. |

You do not need both published. Publishing only the one you use is fine:

- **With a reverse proxy** — publish `3001`, drop the `3443` line, set `TRUST_PROXY=1`, and use the proxy's `https://` address for everything. Scanning works there because the proxy's certificate is a real one. (Leaving `3443` published costs nothing; it just goes unused.)
- **Without a reverse proxy** — publish both. Use `https://<server-ip>:3443` from phones and other machines, and `http://localhost:3001` on the host itself if you prefer. Everything except the camera also works fine over plain HTTP from anywhere.

#### Why scanning needs the HTTPS port

Browsers only hand out the camera in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). `http://<server-ip>:3001` is not one, so the scanner refuses to open the camera and shows no permission prompt to accept, because the browser never asks. `http://localhost:3001` is the one exception browsers make, which is why scanning works on the host but not from your phone.

#### The self-signed certificate warning

Generated on first start into the data volume (`/app/database/ssl`), not baked into the image. On first visit to `https://<server-ip>:3443` your browser warns that the issuer is unknown — expected, since nobody vouches for a certificate your own server made:

- Tap **Advanced** -> **Proceed** (iOS Safari: **Show Details** -> **Visit this website**). The camera works from then on.
- The same certificate is reused on every later start, so each device only accepts it once.
- Already have a real certificate (Let's Encrypt, your own CA)? Mount it and set `SSL_CERT_PATH` + `SSL_KEY_PATH` — no warning at all.

> [!NOTE]
> While the certificate is self-signed, Bindarr deliberately does not send `Strict-Transport-Security`. That header pins your browser to HTTPS for the host, which makes an untrusted certificate impossible to click past and upgrades `http://…:3001` to HTTPS too — locking you out of both ports. Setting `TRUST_PROXY` (real proxy in front) or `SSL_CERT_PATH` (real certificate) turns it back on.

### Building from source instead

Prefer to build locally? Clone the repo — its [`docker-compose.yml`](docker-compose.yml) uses `build:` instead of `image:` — then run `docker compose up -d`.

### Image tags

| Tag | Points at |
| --- | --- |
| `latest` | the newest release — use this unless you have a reason not to |
| `1.5`, `1.5.1` | a specific release; pin these if you want to control upgrades |
| `edge` | the newest `main` commit, including unreleased work |
| `sha-<short>` | one exact commit |

### Environment variables (`.env`)
You can configure Bindarr by passing these environment variables in your container configuration:
- `PORT` (Default: `3001`) - The port the server runs on.
- `DB_PATH` (Default: `/app/database/bindarr.db`) - Location of the SQLite database.
- `POKEMON_TCG_API_KEY` (Optional) - Your free API key from the [Pokémon TCG developer portal](https://dev.pokemontcg.io/). While Bindarr works without one, a key raises the rate limit from 1,000 requests/day (and 30/minute) to 20,000/day. Note: `pokemontcg.io` now redirects to Scrydex, the team's paid successor API. The free v2 API Bindarr uses is still live and keys are still issued at `dev.pokemontcg.io`; Bindarr does not use Scrydex.
- `DEFAULT_ADMIN_PASSWORD` (Optional) - Sets a known password for the auto-created `admin` account on first startup. If unset, a random password is generated and printed once to the server logs (see [First-Time Sign In](#first-time-sign-in)).
- `PUBLIC_BASE_URL` (Optional) - Externally-reachable URL when running behind a reverse proxy, e.g. `https://cards.example.com`. Used to build collection share links, and its origin is automatically added to the CORS allow-list, so setting this alone is enough for logins through the proxy. Also editable from the Admin panel. (`localhost` and private-LAN origins are always allowed regardless. To whitelist *additional* public origins, set `CORS_ORIGIN` to a comma-separated list.)
- `ALLOW_REGISTRATION` (Optional) - Set to `true` to allow open self-registration from the login screen. Default (unset) is **invite-only**: only an admin creates accounts via the Admin panel, and the Sign Up option is hidden.
- `TRUST_PROXY` (Optional) - Set to the number of proxy hops (usually `1`) when running behind a reverse proxy that terminates TLS, so `req.ip` and the rate limiters use the real client IP from `X-Forwarded-For`. Leave unset when the app is directly exposed. Note: mobile camera access requires HTTPS, so a TLS-terminating proxy in front of the app is the expected production setup.
- `SCAN_WORKERS` (Default: `min(4, cores-1)`) - Number of worker threads that parallelize set-scoped scan verification. Each worker holds its own opencv-wasm instance (~128 MB RAM), so lower this on memory-constrained hosts; set `0` to disable parallelism and verify inline on the main thread.

### Health check
The server exposes `GET /api/health` (no auth). It returns `200 {"status":"ok"}` when the app and database are reachable, `503` otherwise. The Docker image already wires this into a `HEALTHCHECK`.

---

## Card Scanning & Match Data

Identification is **image-only** — your photo is matched against precomputed visual features, no OCR. Reference data lives in `backend/data/` (gitignored — large and regenerable; not shipped in the repo).

### How identification works

Every scan runs the same pipeline server-side (`backend/src/scanMatch.js`):

1. **Detect & rectify the card.** OpenCV (`opencv-wasm`) runs Canny edge detection + contour analysis on the frame and scores candidate regions by `size × card-aspect-fit × centrality` (a whole card is a ~0.71 portrait rectangle, which rejects internal blocks like the art window or type line). The winner is either perspective-warped flat from a clean 4-point quad (removes tilt/skew) or cropped from its bounding box. If nothing card-like is found, it falls back to a centered crop of the on-screen guide box.
2. **Recall (CLIP).** The rectified image is embedded with a **CLIP** model (`@huggingface/transformers`, ONNX) and compared by cosine similarity against the embedding database to pull the ~250 visually-nearest candidates. This narrows tens of thousands of cards to a shortlist fast, but similar-looking cards/printings can rank close.
3. **Verify (ORB + homography).** For each candidate, **ORB** binary descriptors are matched to the query with a brute-force Hamming matcher and Lowe's ratio test (0.75), then a **RANSAC homography** (5px reprojection threshold) is fit between the matched keypoints. The number of geometric **inliers** is the decisive score: only the true printing produces many spatially-consistent matches, so ranking by inliers resolves the exact card rather than a look-alike. If a game's ORB DB isn't built, it ranks on CLIP similarity alone.
4. **Game auto-detection.** It verifies the game you're scanning in first; if the best match is weak (< 25 inliers) it also runs the other game and keeps whichever scores higher, so scanning in the wrong mode still works.
5. **Confidence gate (client).** The top result auto-fills when it clears the gate (≥ 12 ORB inliers, or ≥ 0.55 CLIP cosine similarity when ORB didn't run); below that, the candidate list is shown for a one-tap manual pick.

There are two ways to supply the reference features:

**Set-scoped MTG (recommended, no pre-build).** Enter the set code of the box you're scanning. The first scan of a new set builds that set's ORB index on demand from Scryfall (~1 min, cached under `backend/data/sets/`); every subsequent scan matches within just that set (ORB inliers against every printing, no global CLIP recall needed) for exact-printing accuracy. Nothing to run ahead of time. The per-printing ORB verify is fanned out across a warmed worker-thread pool (`SCAN_WORKERS`, see below), so large sets stay fast without any loss of accuracy — the result is identical to single-threaded ranking.

**Global / code-free matching (optional, heavy pre-build).** To identify cards without giving a set code (and to power game auto-detection), precompute the full CLIP embedding + ORB databases:

```bash
cd backend
# CLIP embeddings (recall) — per game
node --max-old-space-size=2048 scripts/build-card-embeddings.mjs --game mtg
node --max-old-space-size=2048 scripts/build-card-embeddings.mjs --game pokemon
# ORB features (geometric verification) — per game
node scripts/build-card-orb.mjs --game mtg
node scripts/build-card-orb.mjs --game pokemon
```

These download every card image and are **heavy**: several hours of CPU + downloads and ~1.6 GB on disk. Both scripts checkpoint and support `--resume`. A `POKEMON_TCG_API_KEY` (see below) is recommended for the Pokémon build. Without these DBs, set-scoped MTG matching still works (it builds on demand); only code-free matching and game auto-detection need the pre-built data.

> [!NOTE]
> The endpoints backing this are `POST /api/scan-match` (identify an uploaded card image) and `POST /api/prepare-set` (build/verify a set's index). The backend has no auto-reload — restart it after changing backend code so new routes/data load.

---

## Backup, Restore & Recovery

> **Renamed in v1.5.0.** The database file is now `bindarr.db`; it was `pokemon_cards.db`, left over from when the project was Pokémon-only. Upgrades migrate automatically: on first start the old file is renamed (along with its `-wal`/`-shm` sidecars) if no `bindarr.db` exists yet. Nothing to do by hand, and no data is touched if both files are present. If you pinned `DB_PATH` to the old filename it keeps working unchanged — update it when convenient. Existing `pokemon_cards.*.bak` backups still list and restore normally.

**Backup.** All state lives in the single SQLite file (the `bindarr-data` volume in Docker, or `DB_PATH` locally). Two options:
- **File-level:** copy the DB file while the container is stopped, e.g. `docker run --rm -v bindarr-data:/data -v "$PWD":/backup alpine cp /data/bindarr.db /backup/`. (The app runs in WAL mode; stop the container first so the `-wal`/`-shm` files are checkpointed.)
- **Per-user data:** each user can also export their own collection from the app as CSV or JSON (Collection → Export). This is portable to other trackers but does not include other users or app settings.

**Restore.** Stop the container, drop the backed-up `bindarr.db` into the volume, start again. Or use the in-app Import (CSV/JSON) to restore a single user's collection.

**Lost admin password.** The initial `admin` password is printed once, on the run that first creates the database. If you lose it and did not set `DEFAULT_ADMIN_PASSWORD`, either set that variable and recreate the database, or delete the DB file so a fresh admin is generated on next startup. There is no self-service password reset.

---

## Project Structure

```text
/bindarr
  ├── backend/
  │     ├── src/
  │     │     ├── db.js              # SQLite schema, migrations & DB connection
  │     │     ├── server.js          # Express app: middleware, routes, /api/health
  │     │     ├── tcgApi.js          # Pokémon TCG API proxy, cache & price updates
  │     │     ├── scryfallApi.js     # Scryfall (Magic) proxy, cache & price updates
  │     │     ├── embedMatch.js      # CLIP embedding recall (image -> candidate cards)
  │     │     ├── scanMatch.js       # Auto-crop/deskew + CLIP recall + ORB verify orchestration
  │     │     ├── setIndex.js        # Lazy per-set ORB index for set-scoped matching
  │     │     ├── middleware/
  │     │     │     └── auth.js       # Session-token auth, admin guard, rate limiters
  │     │     ├── routes/            # auth, admin, collection (+scan-match/prepare-set), sets, decks, shared
  │     │     └── utils/             # compartmentSort (filing engine), priceHelpers, authHelpers
  │     ├── scripts/                 # build-card-embeddings.mjs, build-card-orb.mjs, cardSources.js
  │     ├── data/                    # Precomputed embeddings/ORB/per-set indexes (gitignored)
  │     ├── test/                    # Framework-free tests: unit + e2e/ runner (npm test)
  │     └── package.json
  ├── frontend/
  │     ├── src/
  │     │     ├── components/        # Dashboard, CameraScanner, CardSearch, LocationManager,
  │     │     │                      #   CollectionList, AdminPanel, Settings, DeckBuilder,
  │     │     │                      #   SharedCollection, PriceHistoryChart, CardInspectorModal
  │     │     ├── utils/             # sorting, pricing, translation & printing helpers
  │     │     ├── App.jsx            # Routing tab controller + fetch/auth interceptor
  │     │     ├── index.css          # Core premium dark styling
  │     │     └── main.jsx
  │     ├── .eslintrc.cjs
  │     ├── package.json
  │     └── vite.config.js
  ├── Dockerfile                     # Multi-stage build, runs as non-root, HEALTHCHECK
  ├── docker-compose.yml
  ├── .dockerignore
  └── .github/
        └── workflows/
              └── docker-build.yml   # verify (backend tests) -> build & push to GHCR
```

---

## Translating Bindarr

**Bindarr is English-only right now, and translators are wanted.** People collect
cards in every language; there is no reason the app should only speak one. If you
are fluent in another language, this is the single most useful thing you can
contribute, and it does not require knowing how to code.

The interface is translated by the community, and a translation is a single JSON
file - no account, no tooling, no programming. Copy
[`frontend/src/locales/en.json`](frontend/src/locales/en.json), translate the text
on the right of each `:`, and open a pull request. Partial files are welcome:
anything untranslated falls back to English key by key, and the new language shows
up in Settings the moment it merges. You do not have to finish a language to be
useful, and you do not have to be the one who finishes it.

Full instructions, including the rules for `{placeholders}` and plurals, are in
**[docs/TRANSLATING.md](docs/TRANSLATING.md)**.

Note that this is the language of the *app*. The language a card was printed in is
recorded per card and is a separate setting, so an app in German and a binder full
of Japanese cards is a perfectly normal combination.

---

## License

Released under the [MIT License](LICENSE).
