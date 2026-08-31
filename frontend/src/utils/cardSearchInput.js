// Preserve the scanner's established "SET NUMBER" and card-name shortcuts while
// still allowing explicit Scryfall syntax in the manual fallback field.
export function manualSearchFields(raw) {
  const query = String(raw ?? '').trim();
  const setAndNumber = query.match(/^([a-z0-9]{2,6})\s+#?([a-z0-9★-]+(?:\s*\/\s*[a-z0-9★-]+)?)$/i);

  if (setAndNumber && /[\d★]/.test(setAndNumber[2])) {
    return {
      set: setAndNumber[1],
      number: setAndNumber[2].replace(/\s+/g, ''),
    };
  }

  // An explicit Scryfall operator is intentional raw syntax; ordinary text is a
  // card-name search so names containing spaces continue to work as before.
  if (/(?:^|\s)[a-z][a-z0-9_-]*\s*:/i.test(query)) return { q: query };
  return { name: query };
}
