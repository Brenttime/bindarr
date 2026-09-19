#!/usr/bin/env python3
"""Splice the state-aware deck-editor header into DeckBuilder.jsx.

Replaces the old fixed button row (register / export-missing / checkout /
simulator / three tool glyphs) with the header approved in the static study at
~/projects/bindarr-design-demos/redesigns/apple/deck-editor.html: one status line
that reads the deck, exactly one filled verb chosen by that status, and the
housekeeping behind a single overflow. The three card-movement verbs each render
exactly once; deck state only picks which one is filled:

    building (not out, missing > 0)  Export N missing [filled] | Check out [quiet] | Register [quiet]
    ready    (not out, missing == 0) Check out [filled]                                     | Register [quiet]
    out                             Return cards [filled]

All JSX bodies live verbatim in scripts/deck_header_assets/*.txt, byte-exact
captures of the reviewed result, so this script holds no hand-retyped markup
(transit has mangled inline JSX twice; that is the whole reason for the assets).

Idempotent: once spliced it only repairs the locale file, so a run can be
repeated safely after an abort. Point it at another checkout with the
DECK_JSX / DECK_EN environment variables to prove reproducibility.

Run from frontend/:
    python3 scripts/patch_deck_header.py
"""
import glob
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
ASSETS = os.path.join(HERE, 'deck_header_assets')

JSX = os.environ.get('DECK_JSX', 'src/components/DeckBuilder.jsx')
EN = os.environ.get('DECK_EN', 'src/locales/en.json')

# Where the old header sat, straight out of HEAD: the row that opened it and the
# last button it drew. The four lines after the Trash2 glyph are its closers.
REGION_START = "            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>"
TRASH_ANCHOR = "                  <Trash2 size={12} />"
TRASH_TAIL = ['</button>', '</div>', '</div>', '</div>']

IMPORT_PROBE = 'lucide-react'
STATE_AFTER = 'const [registeringDeck, setRegisteringDeck] = useState(false);'
CONSTS_BEFORE = 'const detailOpen'
SPLICED_PROBE = 'ref={deckMenuRef}'

KEY_ANCHOR = '"deck.registerCollectionHint":'
DASH = chr(0x2014)   # em dash, the style en.json already uses in ~110 entries

# Counted phrases are stored as .one/.other siblings and the locale's own
# Intl.PluralRules picks one (see utils/translate.js), so no `n === 1` anywhere.
NEW_KEYS = [
    ('deck.statusComplete', 'Complete ' + DASH + ' you own every card'),
    ('deck.statusMissing.one', '{count} card still missing from your collection'),
    ('deck.statusMissing.other', '{count} cards still missing from your collection'),
    ('deck.statusOut', 'Checked out for play ' + DASH + ' your copies are held'),
    ('deck.checkoutAction', 'Check out for play'),
    ('deck.checkoutHint', 'Reserve the collection copies this deck needs so you can take it to the table'),
    ('deck.returnAction', 'Return cards'),
    ('deck.returnHint', 'Give the reserved copies back to your collection'),
    ('deck.drawSimulator', 'Draw simulator'),
    ('deck.moreActions', 'More deck actions'),
    ('deck.exportDeckList', 'Export deck list'),
    ('deck.importDeckList', 'Import deck list'),
    ('deck.exportMissingCount.one', 'Export {count} missing'),
    ('deck.exportMissingCount.other', 'Export {count} missing'),
    ('deck.defaultDescription', 'Custom deck build.'),
    ('deck.checkedOutSince', 'held since {when}'),
    ('deck.deleteBlockedWhileOut', 'Return the cards before deleting this deck'),
    ('deck.deleteDeckHint', 'Delete this deck'),
    ('deck.backToDecks', 'Back to decks'),
]

# Labels the old header drew that the new one no longer draws. Retired only when
# nothing under src/ still reads the exact key, so a string another screen shares
# (or the new header itself kept, like deck.missingHint) is never taken away.
RETIRED_KEYS = [
    'deck.statusMissing',   # superseded by its .one/.other plural siblings
    'deck.exportMissing',   # replaced by deck.exportMissingCount
    'deck.deckTools',       # the glyph cluster this header replaced
]


def read(path):
    return io.open(path, encoding='utf-8').read()


def asset(name):
    return read(os.path.join(ASSETS, name))


def lines_of(block):
    out = block.split(chr(10))
    if out and out[-1] == '':
        out.pop()
    return out


def find(lines, needle, what):
    hits = [i for i, l in enumerate(lines) if needle in l]
    if len(hits) != 1:
        raise SystemExit('expected exactly one %s, found %d' % (what, len(hits)))
    return hits[0]


def splice_jsx():
    lines = read(JSX).split(chr(10))

    if any(SPLICED_PROBE in l for l in lines):
        print('jsx: header already spliced, leaving the component alone')
        return

    # 1) lucide import: swap the glyph list for the one the new header draws with.
    i = find(lines, IMPORT_PROBE, 'lucide import line')
    imp = lines_of(asset('import_line.txt'))
    if len(imp) != 1:
        raise SystemExit('import asset must be a single line')
    lines[i] = imp[0]

    # 2) header menu state + click-away effect, right below the other checkout state.
    i = find(lines, STATE_AFTER, 'registeringDeck state line')
    lines[i + 1:i + 1] = lines_of(asset('prep_state.txt'))

    # 3) the derived header consts, immediately before detailOpen.
    i = find(lines, CONSTS_BEFORE, 'detailOpen declaration')
    lines[i:i] = lines_of(asset('prep_consts.txt'))

    # 4) the header itself: row through the card-panel closer it replaced.
    if sum(1 for l in lines if l.strip() == REGION_START.strip()) != 1:
        raise SystemExit('expected exactly one header-row start anchor')
    start = next(i for i, l in enumerate(lines) if l.strip() == REGION_START.strip())
    end = find(lines, TRASH_ANCHOR, 'legacy Trash2 glyph line') + len(TRASH_TAIL)
    for off, expect in enumerate(TRASH_TAIL, 1):
        got = lines[end - len(TRASH_TAIL) + off].strip()
        if got != expect:
            raise SystemExit('legacy closers not as expected at +%d: %r' % (off, got))

    lines[start:end + 1] = lines_of(asset('header.txt'))
    io.open(JSX, 'w', encoding='utf-8').write(chr(10).join(lines))
    print('jsx: spliced the header region (row was line %d)' % (start + 1))


def patch_locale():
    text = read(EN)
    lines = text.split(chr(10))

    anchor = None
    for i, el in enumerate(lines):
        if KEY_ANCHOR in el:
            anchor = i
            break
    if anchor is None:
        raise SystemExit('locale anchor %s not found' % KEY_ANCHOR)

    js_source = read(JSX)
    inserted, already, retired = [], 0, []

    for key, value in NEW_KEYS:
        if ('"' + key + '":') in text:
            already += 1
            continue
        # Every inserted line sits mid-file, so it always carries its own comma;
        # the closing brace line keeps the file valid however many land last.
        el = '  ' + json.dumps(key) + ': ' + json.dumps(value) + ','
        lines.insert(anchor + 1, el)
        text = chr(10).join(lines)
        inserted.append(key)

    for key in RETIRED_KEYS:
        pat = '"' + key + '":'
        if pat not in text:
            continue
        quoted = "'" + key + "'"
        if quoted in js_source:
            continue
        still = False
        for root, _dirs, files in os.walk('src'):
            for fn in files:
                if fn.endswith(('.js', '.jsx', '.mjs')):
                    if quoted in read(os.path.join(root, fn)):
                        still = True
        if still:
            continue
        keep = []
        dropping = False
        for el in lines:
            st = el.strip()
            if st.startswith(pat):
                dropping = True
                if st.endswith(','):
                    dropping = False
                continue
            if dropping:
                if st.endswith(','):
                    dropping = False
                continue
            keep.append(el)
        lines = keep
        text = chr(10).join(lines)
        retired.append(key)

    json.loads(text)                      # never leave a broken locale file on disk
    io.open(EN, 'w', encoding='utf-8').write(text)
    print('en.json: added %d keys, already present %d, retired %s'
          % (len(inserted), already, retired or 'nothing'))


def main():
    splice_jsx()
    patch_locale()


if __name__ == '__main__':
    main()
