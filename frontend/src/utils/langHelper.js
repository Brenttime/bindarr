// The name to show for a card. A printed name from the provider always wins — it
// is what is actually on the card, in any language (Scryfall's printed_name for
// Magic, in every language). Everything else shows the English name unchanged.
export const getCardDisplayName = (englishName, language, printedName) => {
  if (printedName) return printedName;
  void language;
  return englishName;
};
