// Fetch a card by id from the provider that minted the id.
//
// Every card id in this app starts with `mtg-` (Scryfall's own uuid, namespaced
// to make it unmistakable), so there is exactly one provider and the id is the
// whole answer.
const scryfallApi = require('../scryfallApi');
const languages = require('./languages');

// Fill in a row that was cached from a partial source before it is relied on.
// Never throws — hydration is an improvement, and failing it must not block
// adding a card.
async function hydrate(id) {
  // No thin rows remain: Scryfall caches complete cards.
}

// Fetch a card from Scryfall. Returns null when it does not have it.
async function getCardById(id) {
  return await scryfallApi.getCardById(id);
}

// The same card as printed in `language`, or null when there is no such printing.
//
// A copy's language is not always the printing that was picked. Quick Add lets the
// language be changed after a card is chosen, and a camera scan is answered by
// whichever catalog exists (English, on most installs) whatever language is being
// scanned. Both leave the collection row pointing at the ENGLISH printing, so a card
// filed as Japanese still shows its English name everywhere: printed_name belongs to
// the printing, not to the copy.
//
// Null means keep the card you had. That covers a card never printed in the language
// asked for (Japanese has no Alpha) — callers must degrade, not fail, because the
// language the user picked is still what they own.
async function printingInLanguage(card, language) {
  if (!card) return null;
  if (languages.toName(card.language) === languages.toName(language)) return null;
  const set = String(card.set_id || '').replace(/^mtg-/, '');
  return await scryfallApi.getPrintingInLang(set, card.number, language).catch(() => null);
}

module.exports = { hydrate, getCardById, printingInLanguage };
