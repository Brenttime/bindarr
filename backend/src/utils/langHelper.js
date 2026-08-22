const { translateLorcanaName, LORCANA_TRANSLATIONS } = require('./lorcanaHelper');
const { translatePokemonName, POKEMON_TRANSLATIONS } = require('./pokemonHelper');
const { toCode } = require('./languages');

const POKEMON_JP_TO_EN = {};
for (const [en, langs] of Object.entries(POKEMON_TRANSLATIONS)) {
  if (langs.ja) POKEMON_JP_TO_EN[langs.ja] = en;
}

const JP_EN_PREFIX = {
  'わるい': 'Dark ',
  'やさしい': 'Light ',
  'ひかる': 'Shining ',
  'かがやく': 'Radiant ',
  'ヒスイ ': 'Hisuian ',
  'ヒスイ': 'Hisuian ',
  'ガラル ': 'Galarian ',
  'ガラル': 'Galarian ',
  'アローラ ': 'Alolan ',
  'アローラ': 'Alolan ',
  'パルデア ': 'Paldean ',
  'パルデア': 'Paldean ',
  'マチスの': "Lt. Surge's ",
  'ロケット団の': "Rocket's ",
  'タケシの': "Brock's ",
  'カスミの': "Misty's ",
  'ナツメの': "Sabrina's ",
  'エリカの': "Erika's ",
  'キョウの': "Koga's ",
  'カツラの': "Blaine's ",
  'サカキの': "Giovanni's "
};

const getCardDisplayName = (englishName, language, printedName, game) => {
  if (printedName) return printedName;
  if (!englishName) return '';
  const code = toCode(language);
  if (!code || code === 'en') return englishName;

  // Lorcana translation check
  if (game === 'lorcana' || englishName.includes(' - ') || (LORCANA_TRANSLATIONS.characters && LORCANA_TRANSLATIONS.characters[englishName])) {
    const translated = translateLorcanaName(englishName, language);
    if (translated !== englishName) return translated;
  }

  // Pokemon translation check
  const pkmTranslated = translatePokemonName(englishName, language);
  if (pkmTranslated && pkmTranslated !== englishName) return pkmTranslated;

  return englishName;
};

const translateJapaneseName = (rawJpName) => {
  let jp = String(rawJpName || '').replace(/[^\u3000-㿿぀-ゟ゠-ヿ＀-￯一-龯]/g, '').trim();
  if (!jp) return '';

  let prefix = '';
  for (const [jpPrefix, en] of Object.entries(JP_EN_PREFIX)) {
    if (jp.startsWith(jpPrefix)) {
      prefix = en;
      jp = jp.slice(jpPrefix.length).trim();
      break;
    }
  }

  if (POKEMON_JP_TO_EN[jp]) return prefix + POKEMON_JP_TO_EN[jp];
  const foundKey = Object.keys(POKEMON_JP_TO_EN).find(k => jp.includes(k) || k.includes(jp));
  if (foundKey) return prefix + POKEMON_JP_TO_EN[foundKey];

  return '';
};

module.exports = {
  getCardDisplayName,
  translateJapaneseName,
  translatePokemonName,
  translateLorcanaName,
  POKEMON_TRANSLATIONS,
  POKEMON_JP_TO_EN
};
