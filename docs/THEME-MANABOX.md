# ManaBox theme

Scrybox ships an opt-in skin modeled on the ManaBox mobile app: graphite
surfaces, a single orange accent, flat list-first panels, a left sidebar on
desktop and a bottom tab bar on phones.

- Code: `frontend/src/theme-manabox.css` (imported from `frontend/src/main.jsx`)
- Turn it on: Settings -> Preferences -> Theme -> "ManaBox", or add `?theme=manabox` to any URL
  (works for share links too, e.g. `/share/<token>?theme=manabox`)
- Design reference: the static concept in `scrybox-design-demos/redesigns/manabox/index.html`
- Guard test: `frontend/src/utils/themeManabox.test.js` (runs in `npm test`)

## What makes it ManaBox

| Element            | Default (dark)                 | ManaBox                                          |
|--------------------|--------------------------------|--------------------------------------------------|
| Surfaces           | frosted glass, blur, glow      | flat `#1f2329` cards on `#121417`, no blur       |
| Accent             | red gradient                   | one orange `#ff7a1a` (hover `#ffa45c`)           |
| Primary button     | red gradient + lift on hover   | solid orange, dark ink text, no lift             |
| Desktop navigation | top tab bar inside the header  | sticky 232px left sidebar (logo, tabs, user)     |
| Phone navigation   | pinned bottom bar              | opaque bottom tab bar, orange active label       |
| Dashboard lists    | bordered mini cards            | edge-to-edge rows with hairline dividers         |
| Net worth tile     | green accent                   | warm orange-brown "hero" gradient                |
| Set progress       | gradient fill                  | flat green bar on graphite track                 |
| Segmented controls | glass track                    | ManaBox segmented pill (`.sub-nav-tabs`)         |
| Deck grid          | glass tile, 170px art, boxed stats | concept deck card: 120px art fading into card, BUILDING/READY chip on the art, thin green bar (blue when in play) |
| Deck editor header | plain glass header             | concept hero: commander art_crop fills the header, dark bottom fade, title/stats/verbs on top (`.deck-editor-header-art`, hidden in other themes) |
| Lists overview     | grid of glass cards            | one card of rows: accent icon chip, name, value + card count on the right |
| Toast              | green pill                     | graphite card, subtle border                     |

Semantic colors keep their meaning: green = owned/complete/gain,
red = missing/loss, blue = info/reserved, amber = money.

## The contract (why nothing broke)

The theme is style-only. It does not change behavior, markup, or data, and
future edits have to keep it that way.

1. Every selector is scoped. Each rule starts with `:root[data-theme="manabox"]`,
   so dark, light, and LCARS render exactly as they did before. The guard test fails
   on any unscoped selector.
2. It never hides app content. There is no `display: none`, `visibility: hidden`,
   or `opacity: 0` on application elements. Features, counts, and stats
   (for example "14 cards still missing from your collection", "Export 14 missing",
   the per-row "+1 missing from collection" notes, and the grid-view missing chips)
   come from JSX and keep rendering. The guard test fails if the file contains a
   hiding declaration.
3. The DOM is shared. The desktop sidebar is the existing `<header class="app-header">`
   re-laid out with CSS grid. No component has a ManaBox-specific branch, so every
   new feature appears in this theme automatically.
4. Hook classes. Decks and lists carry style-only hook classes (`deck-tile*`,
   `list-tile*`) so the theme can reach elements that use inline styles. Keep
   them when you edit those components; the theme targets nothing else there.
5. Precedence: re-map tokens first, override classes second, and use `!important`
   only where a component sets inline styles (currently the dashboard rows and the
   Recharts tooltip).

## Verified (2026-09-22, live collection, production build)

- All six tabs render without error boundaries: Dashboard, Add Cards, Collection,
  Deck Builder, Lists, Settings.
- Deck "Radical Ninjas" (23/100): header shows "14 cards still missing", the
  "Export 14 missing" button is present, and 14 missing notes (list view) and
  14 missing chips (grid view) are all visible.
- Desktop at 1280px: 232px sidebar, and main content fills the rest.
- Phone at 390px: the bottom bar fits inside the viewport, and the net-worth value
  stays inside its card.
- Known issue carried over from dark: the dashboard charts are a few pixels wider
  than a 390px viewport. This is not caused by the theme.

## How to maintain it

### When you add a new component
- Use the shared classes (`glass-panel`, `btn btn-primary|secondary|danger`,
  `input-control`, `select-control`, `sub-nav-tabs`) and the CSS variables
  (`--bg-secondary`, `--text-secondary`, `--accent-red`, `--success`, ...).
  The component then picks up ManaBox, light, and LCARS automatically.
- Avoid hard-coded colors in inline styles (`rgba(255,255,255,0.02)`, `#fff`).
  If you need one, add a token in `index.css` `:root` and re-map it here.
- If a component needs a ManaBox-specific tweak, give it a class and add a scoped
  rule under the matching section of `theme-manabox.css` (panels, buttons, inputs,
  nav, dashboard, collection, decks, misc).

### When you change the palette
Edit only the `--mb-*` variables at the top of `theme-manabox.css`. Everything
else reads from them.

### When you add a theme option
Add the `<option>` in `Settings.jsx` and a `theme.<name>` key in every
`frontend/src/locales/*.json` file (`npm run check:locales` enforces this).

### Before merging UI work
1. Run `npm test`, `npm run lint`, and `npm run build` in `frontend/`.
2. Open the app with `?theme=manabox` and check these at 1280px and 390px:
   - Dashboard: the four stat tiles, top valuable, recent, and set progress.
   - Collection: list and gallery.
   - A deck that is still building: missing count, Export N missing, and per-card
     missing notes and chips.
   - Lists, Settings, and one modal (card inspector).
3. Switch back to Dark once and confirm it is unchanged.

## Future ideas (not built)

- Floating scan button (FAB) on desktop that jumps to Add Cards -> Scan.
- Bulk-select action bar docked at the bottom (ManaBox style) for Collection
  select mode.
- Card inspector as a bottom sheet on phones instead of a centered modal.
- Short phone tab labels (Home / Add / Cards / Decks / Lists / More) through
  optional `nav.*Short` locale keys.
- Fix the dashboard chart overflow at 390px, which affects every theme.
