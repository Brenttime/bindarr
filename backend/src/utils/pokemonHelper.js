const POKEMON_TRANSLATIONS = require('../../../shared/pokemonTranslations.json');
const { toCode } = require('./languages');

const PREFIXES = {
  ja: {
    'Mega ': 'M',
    'M ': 'M',
    'Dark ': 'わるい',
    'Light ': 'やさしい',
    'Shining ': 'ひかる',
    'Radiant ': 'かがやく',
    'Hisuian ': 'ヒスイ ',
    'Galarian ': 'ガラル ',
    'Alolan ': 'アローラ ',
    'Paldean ': 'パルデア ',
    "Lt. Surge's ": 'マチスの',
    "Surge's ": 'マチスの',
    "Rocket's ": 'ロケット団の',
    "Team Rocket's ": 'ロケット団の',
    "Brock's ": 'タケシの',
    "Misty's ": 'カスミの',
    "Sabrina's ": 'ナツメの',
    "Erika's ": 'エリカの',
    "Koga's ": 'キョウの',
    "Blaine's ": 'カツラの',
    "Giovanni's ": 'サカキの'
  },
  de: {
    'Dark ': 'Dunkles ',
    'Light ': 'Helles ',
    'Shining ': 'Schimmerndes ',
    'Radiant ': 'Strahlendes ',
    'Hisuian ': 'Hisui-',
    'Galarian ': 'Galar-',
    'Alolan ': 'Alola-',
    'Paldean ': 'Paldea-'
  },
  fr: {
    'Dark ': '',
    'Light ': '',
    'Shining ': '',
    'Radiant ': '',
    'Hisuian ': ' de Hisui',
    'Galarian ': ' de Galar',
    'Alolan ': " d'Alola",
    'Paldean ': ' de Paldea'
  }
};

const SUFFIX_PATTERNS = [
  /^(.*?)( ex)$/i,
  /^(.*?)( EX)$/i,
  /^(.*?)( GX)$/i,
  /^(.*?)( VMAX)$/i,
  /^(.*?)( VSTAR)$/i,
  /^(.*?)( V-UNION)$/i,
  /^(.*?)( V)$/i,
  /^(.*?)( BREAK)$/i,
  /^(.*?)( Prime)$/i,
  /^(.*?)( LV\.X)$/i,
  /^(.*?)( Lv\.X)$/i,
  /^(.*?)( Tag Team)$/i,
  /^(.*?)( Prism Star)$/i,
  /^(.*?)( ◇)$/i,
  /^(.*?)( ★)$/i,
  /^(.*?)( Star)$/i,
  /^(.*?)( δ Delta Species)$/i,
  /^(.*?)( δ)$/i,
  /^(.*?)(-EX)$/i,
  /^(.*?)(-ex)$/i,
  /^(.*?)(-GX)$/i,
];

function translatePokemonName(name, language) {
  if (!name) return '';
  const langCode = toCode(language);
  if (!langCode || langCode === 'en') return name;

  // Direct hit in dictionary
  if (POKEMON_TRANSLATIONS[name]?.[langCode]) {
    return POKEMON_TRANSLATIONS[name][langCode];
  }

  // Check suffix
  let base = name;
  let suffix = '';
  for (const pattern of SUFFIX_PATTERNS) {
    const match = name.match(pattern);
    if (match) {
      base = match[1];
      suffix = match[2];
      break;
    }
  }

  // Check prefix
  let prefixKey = '';
  const candidatePrefixes = [
    'Mega ', 'M ', 'Dark ', 'Light ', 'Shining ', 'Radiant ',
    'Hisuian ', 'Galarian ', 'Alolan ', 'Paldean ',
    "Lt. Surge's ", "Surge's ", "Rocket's ", "Team Rocket's ",
    "Brock's ", "Misty's ", "Sabrina's ", "Erika's ", "Koga's ", "Blaine's ", "Giovanni's "
  ];
  for (const enPre of candidatePrefixes) {
    if (base.startsWith(enPre)) {
      prefixKey = enPre;
      base = base.slice(enPre.length);
      break;
    }
  }

  const translatedBase = POKEMON_TRANSLATIONS[base]?.[langCode];
  if (!translatedBase) {
    return name;
  }

  let finalPrefix = (PREFIXES[langCode] && PREFIXES[langCode][prefixKey] !== undefined) ? PREFIXES[langCode][prefixKey] : prefixKey;
  let finalSuffix = suffix;

  if (langCode === 'ja') {
    const cleanSuff = finalSuffix.trim() ? (finalSuffix.startsWith('-') ? finalSuffix.slice(1) : finalSuffix.trim()) : '';
    return `${finalPrefix}${translatedBase}${cleanSuff ? ' ' + cleanSuff : ''}`;
  }

  if (langCode === 'fr') {
    if (prefixKey === 'Dark ') finalSuffix = ` obscur${finalSuffix}`;
    else if (prefixKey === 'Light ') finalSuffix = ` lumineux${finalSuffix}`;
    else if (prefixKey === 'Shining ') finalSuffix = ` brillant${finalSuffix}`;
    else if (prefixKey === 'Radiant ') finalSuffix = ` Radieux${finalSuffix}`;
    else if (['Hisuian ', 'Galarian ', 'Alolan ', 'Paldean '].includes(prefixKey)) {
      finalSuffix = `${PREFIXES.fr[prefixKey]}${finalSuffix}`;
      finalPrefix = '';
    }
    return `${finalPrefix}${translatedBase}${finalSuffix}`;
  }

  return `${finalPrefix}${translatedBase}${finalSuffix}`;
}

module.exports = {
  translatePokemonName,
  POKEMON_TRANSLATIONS
};
