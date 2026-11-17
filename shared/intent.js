/**
 * IrisIntent (v7) — deterministic command understanding, shared by the browser
 * (window.AkonIntent) and Node (require('../shared/intent')).
 *
 * Why shared: transport commands (pause/next/volume) are executed locally with zero
 * network, and the backend re-parses the same text with the same code so the two can
 * never drift. The browser uses `type` for local actions; the backend uses the full
 * structured object (`intent`, `entities`, `preferences`, `references`, `confidence`).
 *
 * BACKWARD COMPATIBILITY: `type` keeps every v4-v6 value
 *   pause | resume | next | previous | mute | unmute | reject |
 *   volume_up | volume_down | volume_set | select_option | play_song | unknown
 * v7 adds `restart` and `clarify` (old callers ignore unknown types) and keeps the
 * existing fields (`query`, `implicit`, `value`, `step`, `index`). Anything that needs
 * server-side resolution (track, album, playlist, artist, discovery, lyrics) keeps
 * `type: 'play_song'` so v6 frontends remain functional, and carries the precise
 * taxonomy in `intent`.
 *
 * TAXONOMY (`intent`):
 *   PLAY_TRACK, PLAY_ALBUM, PLAY_PLAYLIST, PLAY_ARTIST, PLAY_CONTEXT,
 *   SEARCH_TRACK, SEARCH_ALBUM, SEARCH_PLAYLIST, SEARCH_ARTIST,
 *   DISCOVER_BY_MOOD, DISCOVER_BY_GENRE, DISCOVER_BY_ACTIVITY,
 *   DISCOVER_BY_LANGUAGE, DISCOVER_BY_ERA, DISCOVER_SIMILAR,
 *   IDENTIFY_BY_LYRICS, REFINE_CURRENT_DISCOVERY, CLARIFY_REQUEST,
 *   PAUSE, RESUME, NEXT_TRACK, PREVIOUS_TRACK, RESTART_TRACK,
 *   SET_VOLUME, INCREASE_VOLUME, DECREASE_VOLUME, MUTE, UNMUTE,
 *   SELECT_OPTION, REJECT, UNKNOWN
 *
 * DESIGN RULES
 *  - Never turn a structured command into a song search by accident ("volume max").
 *  - A play verb always wins ("play Volume Maxx" is a song).
 *  - Never invent structure: low confidence -> clarify instead of acting.
 *  - Lexicons are data; matching is token-window based, not a pile of regexes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AkonIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ normalisation

  function norm(s) {
    return String(s || '')
      // Spoken/misheard spellings of "R&B" collapse to one stable token pair.
      .replace(/\br\s*&\s*b\b/gi, ' r b ')
      .replace(/\b(?:rnb|r'n'b|randb|r and b)\b/gi, ' r b ')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9\u0900-\u097f%\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Politeness / carrier words at the edges only (never mid-sentence).
  function stripPoliteness(t) {
    let prev;
    do {
      prev = t;
      t = t
        .replace(/^(hey|hi|ok|okay|yo|arre|arey|acha|accha)\s+/, '')
        .replace(/^(please|pls|plz|kindly)\s+/, '')
        .replace(/^(can|could|would|will) you (please )?/, '')
        .replace(/\s+(please|pls|plz|now|right now|for me|yaar|na)$/, '');
    } while (t !== prev);
    return t.trim();
  }

  const OBJ = '(?: (?:the |this |that |my |ye |yeh |wo |woh )?(?:song|music|track|gaana|gana|it|playback|one|audio))?';
  const re = (body) => new RegExp('^(?:' + body + ')' + OBJ + '$');

  // ------------------------------------------------------------------ control intents

  const PAUSE = re(
    'pause|stop|stop playing|stop it|hold on|hold|halt|freeze|quiet|silence|shut up|' +
      'ruko|ruk jao|ruk ja|rok do|roko|band karo|band kar do|band kar|bas karo|bas|chup|chup karo|pause karo|pause kar do'
  );
  const PAUSE_HI = /^(gaana|gana|music|song) (band karo|band kar do|rok do|roko|pause karo|pause kar do|stop karo)$/;

  // Checked BEFORE resume: "start again" is a restart, not a resume.
  const RESTART = re(
    'restart|start again|start over|start this again|start this song again|start the song again|start it again|' +
      'start from the beginning|start from the start|from the beginning|from start|from the top|replay|' +
      'play that again|play it again|play this again|play the song again|' +
      'phir se|phir se chalao|phir se bajao|dobara|dobara chalao|dobara bajao|shuru se'
  );

  const RESUME = re(
    'resume|continue|unpause|keep playing|carry on|play|play again|start|go on|' +
      'chalu karo|chalu kar do|chalao|wapas chalao|play karo|play kar do|resume karo'
  );

  const NEXT = re(
    'next|skip|skip this|skip it|skip that|next one|next please|play next|play the next|go next|go to next|go to the next|' +
      'next song please|change|change it|change the song|change song|another|another one|another song|one more|something else|' +
      'different song|different one|different track|' +
      'agla|agla gaana|agla gana|agla song|next gaana|next wala|dusra gaana|doosra gaana|gaana badlo|song badlo|badlo'
  );

  const PREVIOUS = re(
    'previous|prev|back|go back|last|play previous|play the previous|previous one|play the last|go to previous|go to the previous|' +
      'pichla|pichla gaana|pichla gana|pichhla|pichhla gaana|peeche|piche|wapas'
  );

  const REJECT = /^(no|nope|not (this|that)( one)?|wrong( one| song)?|thats wrong|that is wrong|not that song|galat|galat gaana|ye nahi|yeh nahi|nahi ye|other one|the other one)$/;

  const MUTE = /^(mute|mute it|mute the (music|song|volume)|awaaz band karo|awaz band karo)$/;
  const UNMUTE = /^(unmute|unmute it|unmute the (music|song|volume))$/;

  // ------------------------------------------------------------------ volume

  // Applied to a normalised COPY for volume parsing only, so "play volume maxx"
  // and "volume maxx" (a real song) are never rewritten.
  function volumeNumbers(t) {
    return t.replace(/\b(hundred|onehundred|maximum|max|full|poora|puri|pura)\b/g, '100');
  }

  const VOLUME_SET =
    /\b(?:set|change|make|put|rakho|karo|kar do|kar)\s+(?:the\s+)?(?:volume|awaaz|awaz|sound)\s+(?:to|at|on|ko|pe|par)?\s*(\d{1,3})(?:\s*(?:%|percent))?\b|\b(?:volume|awaaz|awaz|sound)\s+(?:ko\s+|to\s+|at\s+|on\s+)?(\d{1,3})(?:\s*(?:%|percent))?\b|\b(?:volume|awaaz|awaz)\s+(\d{1,3})\s+(?:pe|par|percent)\b/;

  const VOLUME_UP =
    /\b(volume up|volume badhao|volume badha|volume thoda badha|thoda volume badha|volume thoda badhao|volume tez|awaaz badhao|awaaz badha do|awaaz tez|awaz badhao|awaz tez|sound badhao|sound thoda badha|turn (?:it |the volume |the music |this )?up|louder|make it louder|increase (?:the )?volume|raise (?:the )?volume|volume increase|pump it up|crank it up|thoda (?:tez|loud|zor se)|zyada awaaz|awaaz zyada)\b/;

  const VOLUME_DOWN =
    /\b(volume down|volume kam|volume kam karo|volume kam kar do|volume thoda kam|thoda volume kam|awaaz kam karo|awaaz kam kar do|awaaz dheemi|awaaz dheere|awaz kam karo|sound kam|sound thoda kam|turn (?:it |the volume |the music |this )?down|quieter|make it quieter|softer|lower (?:the )?volume|decrease (?:the )?volume|reduce (?:the )?volume|volume decrease|volume dheere|thoda (?:dheere|kam|slow)|awaaz kam|awaaz dheere)\b/;

  const BIG_STEP = /\b(a lot|lot|much|way|bahut|zyada|more more)\b/;

  // Bare "maximum" with nothing else is genuinely ambiguous ("Maximum" is a song).
  const AMBIGUOUS_MAX = /^(max|maximum|full|pura|poora)$/;

  // ------------------------------------------------------------------ option selection

  const ORDINALS = {
    one: 0, '1': 0, first: 0, pehla: 0, pehli: 0, pehle: 0, pahla: 0,
    two: 1, '2': 1, second: 1, dusra: 1, doosra: 1, dusri: 1, doosri: 1, dusre: 1,
    three: 2, '3': 2, third: 2, teesra: 2, tisra: 2, teesri: 2, tisri: 2
  };
  const SELECT = /^(?:play |choose |pick |select )?(?:the )?(?:option |number |choice |no )?(one|two|three|1|2|3|first|second|third|pehla|pehli|pehle|pahla|dusra|doosra|dusri|doosri|dusre|teesra|tisra|teesri|tisri)(?: one| wala| vala| waala| option| song| gaana)?$/;

  // ------------------------------------------------------------------ play / search verbs

  const PLAY_PREFIX =
    /^(?:play|put on|start playing|throw on|queue up|queue|i want to hear|i wanna hear|i want to listen to|i wanna listen to|let me hear|lets hear|lets listen to|play me|give me|i want|i need|mujhe|mujhko|chahiye|bajao|chalao|lagao|sunao)\s+(.+)$/;

  const SEARCH_PREFIX = /^(?:search for|search|look up|look for|find)\s+(.+)$/;

  const PLAY_SUFFIX =
    /^(.+?)\s+(?:bajao|baja do|bajado|baja|chalao|chala do|chalado|lagao|laga do|lagado|sunao|suna do|play karo|play kar do|play kar|chalu karo|de do)$/;

  const LYRIC_HINT =
    /\b(song|one|track|gaana|gana) (that|which|jo|jisme|jismein|jis mein) |\blyrics?\b|\bthat goes\b|\b(song|track|gaana) (with|where|jisme) (?:the )?(lyrics?|line|words?|hook|part)\b/;

  // "play X on" ("put something romantic on") — verb sandwich.
  const PUT_ON = /^(?:put|throw|stick)\s+(.+?)\s+on$/;

  // ------------------------------------------------------------------ discovery lexicon
  //
  // Terms are normalized phrases. Matching is token-window based (longest first).
  // `label` is used to build Spotify search queries — never the raw utterance.

  const LEXICON = {
    mood: {
      romantic: {
        label: 'Romantic',
        terms: ['romantic', 'romance', 'pyaar', 'pyar', 'ishq', 'mohabbat', 'valentine',
          'date night', 'romantic vibe', 'romantic vibes', 'romantic songs', 'love songs']
      },
      sad: {
        label: 'Sad',
        terms: ['sad', 'emotional', 'heartbreak', 'heartbroken', 'breakup', 'broken heart', 'dukhi',
          'dard', 'sad vibe', 'sad vibes', 'breakup songs']
      },
      happy: {
        label: 'Happy',
        terms: ['happy', 'feel good', 'feelgood', 'khush', 'joyful', 'good mood', 'happy vibe', 'happy vibes']
      },
      chill: {
        label: 'Chill',
        terms: ['chill', 'relax', 'relaxing', 'relaxed', 'calm', 'peaceful', 'mellow',
          'sukoon', 'chill vibe', 'chill vibes']
      },
      energetic: {
        label: 'Energetic',
        terms: ['energetic', 'high energy', 'hype', 'pump up', 'pumped up', 'banger', 'bangers']
      },
      dreamy: {
        label: 'Dreamy',
        terms: ['dreamy', 'ethereal', 'dreamy vibe', 'dreamy vibes']
      },
      nostalgic: {
        label: 'Nostalgic',
        terms: ['nostalgic', 'nostalgia', 'yaadein', 'throwback', 'purani yaadein']
      },
      latenight: {
        label: 'Late Night',
        terms: ['late night', 'latenight', 'midnight', 'late night drive', '3 am', '2 am']
      },
      devotional: {
        label: 'Devotional',
        terms: ['devotional', 'bhakti', 'bhajan', 'spiritual', 'prayer']
      },
      angry: { label: 'Angry', terms: ['angry', 'rage', 'aggressive', 'gussa'] },
      motivational: { label: 'Motivational', terms: ['motivational', 'motivation', 'inspirational', 'hustle'] }
    },
    genre: {
      bollywood: { label: 'Bollywood', terms: ['bollywood', 'hindi film', 'filmi', 'hindi songs', 'desi', 'bollywood songs'] },
      punjabi: { label: 'Punjabi', terms: ['punjabi', 'bhangra', 'punjabi songs'] },
      hiphop: { label: 'Hip-Hop', terms: ['hip hop', 'hiphop', 'rap', 'desi hip hop', 'drill', 'trap'] },
      rnb: { label: 'R&B', terms: ['r b'] },
      indie: { label: 'Indie', terms: ['indie', 'indie pop', 'indie rock'] },
      pop: { label: 'Pop', terms: ['pop', 'pop music', 'top 40'] },
      rock: { label: 'Rock', terms: ['rock', 'classic rock', 'alternative rock', 'punk'] },
      edm: { label: 'EDM', terms: ['edm', 'electronic', 'house', 'techno', 'dubstep', 'trance'] },
      lofi: { label: 'Lo-Fi', terms: ['lo fi', 'lofi', 'chillhop'] },
      classical: { label: 'Classical', terms: ['classical', 'carnatic', 'hindustani'] },
      jazz: { label: 'Jazz', terms: ['jazz', 'blues', 'soul'] },
      metal: { label: 'Metal', terms: ['metal', 'heavy metal'] },
      country: { label: 'Country', terms: ['country'] },
      folk: { label: 'Folk', terms: ['folk', 'sufi'] },
      ghazal: { label: 'Ghazal', terms: ['ghazal', 'ghazals'] },
      qawwali: { label: 'Qawwali', terms: ['qawwali', 'qawali'] },
      kpop: { label: 'K-Pop', terms: ['k pop', 'kpop'] }
    },
    activity: {
      workout: { label: 'Workout', terms: ['gym', 'workout', 'work out', 'exercise', 'running', 'training', 'kasrat', 'lifting'] },
      study: { label: 'Study', terms: ['study', 'studying', 'focus', 'concentration', 'concentrate', 'coding', 'office', 'padhai', 'exam'] },
      drive: { label: 'Drive', terms: ['long drive', 'road trip', 'night drive', 'driving', 'drive'] },
      party: { label: 'Party', terms: ['party', 'parties', 'club', 'celebration', 'shaadi', 'baraat', 'dance party'] },
      sleep: { label: 'Sleep', terms: ['sleep', 'sleeping', 'sleepy', 'bedtime', 'lullaby', 'sona'] },
      cooking: { label: 'Cooking', terms: ['cooking', 'kitchen', 'dinner music'] }
    },
    language: {
      hindi: { label: 'Hindi', terms: ['hindi', 'hindi mein', 'hindi me'] },
      english: { label: 'English', terms: ['english', 'english songs', 'western'] },
      punjabi: { label: 'Punjabi', terms: ['punjabi'] },
      tamil: { label: 'Tamil', terms: ['tamil', 'kollywood'] },
      telugu: { label: 'Telugu', terms: ['telugu', 'tollywood'] },
      bengali: { label: 'Bengali', terms: ['bengali', 'bangla'] },
      marathi: { label: 'Marathi', terms: ['marathi'] },
      malayalam: { label: 'Malayalam', terms: ['malayalam', 'mallu'] },
      kannada: { label: 'Kannada', terms: ['kannada', 'sandalwood'] },
      urdu: { label: 'Urdu', terms: ['urdu'] },
      korean: { label: 'Korean', terms: ['korean'] },
      spanish: { label: 'Spanish', terms: ['spanish'] }
    },
    era: {
      old: { label: 'Old School', terms: ['old school', 'oldschool', 'old is gold', 'retro', 'classic', 'classics', 'purane', 'purana', 'old'] },
      '60s': { label: '60s', terms: ['60s', '1960s', 'sixties'] },
      '70s': { label: '70s', terms: ['70s', '1970s', 'seventies'] },
      '80s': { label: '80s', terms: ['80s', '1980s', 'eighties'] },
      '90s': { label: '90s', terms: ['90s', '1990s', 'nineties'] },
      '2000s': { label: '2000s', terms: ['2000s', 'noughties'] },
      '2010s': { label: '2010s', terms: ['2010s'] },
      '2020s': { label: '2020s', terms: ['2020s'] },
      latest: { label: 'Latest', terms: ['latest', 'newest', 'recent', 'fresh', 'naya', 'nayi', 'naye'] }
    },
    energy: {
      slow: { label: 'Slow', terms: ['slower', 'slow', 'dheere', 'dheema', 'dheemi'] },
      upbeat: { label: 'Upbeat', terms: ['upbeat', 'up tempo', 'uptempo', 'faster'] }
    }
  };

  const DIMENSIONS = ['mood', 'genre', 'activity', 'language', 'era', 'energy'];

  // term -> { dim, canon, label }; longest phrases win in matching.
  const TERM_INDEX = (function () {
    const index = {};
    for (const dim of DIMENSIONS) {
      for (const canon of Object.keys(LEXICON[dim])) {
        const def = LEXICON[dim][canon];
        for (const term of def.terms) {
          const key = term.trim();
          if (!index[key]) index[key] = { dim: dim, canon: canon, label: def.label };
        }
      }
    }
    return index;
  })();

  const MAX_TERM_TOKENS = 3;

  // Presence words that turn "something romantic" / "sad song" into a discovery
  // request. They stay OUT of RESIDUAL_FILLERS, so "Love Song" (no lexicon term)
  // is still resolved as a title through the normal track pipeline.
  const MARKERS = new Set([
    'something', 'anything', 'some', 'any', 'music', 'song', 'songs', 'track', 'tracks',
    'playlist', 'playlists', 'mix', 'gaana', 'gaane', 'gana', 'geet', 'kuch', 'koi'
  ]);

  // Removed from the RESIDUAL to decide whether the utterance is purely a vibe
  // request. Deliberately does NOT include song/music/gaana: "Love Song" is a title.
  const RESIDUAL_FILLERS = new Set([
    'play', 'bajao', 'baja', 'chalao', 'chala', 'lagao', 'laga', 'sunao', 'suna', 'put', 'throw',
    'on', 'some', 'any', 'something', 'anything', 'a', 'an', 'the', 'for', 'me', 'please', 'now',
    'my', 'ye', 'yeh', 'wo', 'woh', 'that', 'this', 'is', 'it', 'of', 'to', 'in', 'wala', 'vala',
    'wali', 'vali', 'ka', 'ki', 'ke', 'se', 'kuch', 'koi', 'ek', 'thoda', 'thodi', 'zyada',
    'more', 'aur', 'and', 'type', 'kinda', 'kind', 'style', 'vibes', 'vibe', 'karo', 'kar', 'do',
    'de', 'na', 'yaar', 'lassi', 'but', 'bhi', 'please'
  ]);

  function tokenize(text) {
    const n = norm(text);
    return n ? n.split(' ') : [];
  }

  /**
   * parsePreferences(text) -> {
   *   preferences: { mood?, genre?, activity?, language?, era?, energy? },
   *   labels: { mood: 'Romantic', ... },
   *   terms: matched phrases,
   *   residual: tokens left after removing matched terms and function words,
   *   marker: true when a "something/some/music/songs/..." word was present
   * }
   */
  function parsePreferences(text) {
    const tokens = tokenize(text);
    const preferences = {};
    const labels = {};
    const matched = [];
    const used = new Array(tokens.length).fill(false);

    // Greedy longest-window match so "old school" beats "old", "lo fi" beats nothing.
    for (let size = MAX_TERM_TOKENS; size >= 1; size--) {
      for (let i = 0; i + size <= tokens.length; i++) {
        if (used[i]) continue;
        let free = true;
        for (let k = 0; k < size; k++) if (used[i + k]) free = false;
        if (!free) continue;
        const phrase = tokens.slice(i, i + size).join(' ');
        const hit = TERM_INDEX[phrase];
        if (!hit) continue;
        // One canonical value per dimension: the first (longest) match wins.
        if (preferences[hit.dim] === undefined) {
          preferences[hit.dim] = hit.canon;
          labels[hit.dim] = hit.label;
        }
        used[i] = true;
        for (let k = 1; k < size; k++) used[i + k] = true;
        matched.push(phrase);
      }
    }

    let marker = false;
    const residual = [];
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      if (MARKERS.has(tokens[i])) marker = true;
      if (RESIDUAL_FILLERS.has(tokens[i])) continue;
      residual.push(tokens[i]);
    }

    return { preferences: preferences, labels: labels, terms: matched, residual: residual, marker: marker, tokens: tokens };
  }

  function hasPreferences(preferences) {
    return Object.keys(preferences).length > 0;
  }

  /**
   * Is this utterance a music DISCOVERY request (mood/genre/...), not a title?
   * A bare mood word ("play sad") counts; a title containing one ("Love Song")
   * does not, because "song" stays in the residual.
   */
  function isDiscovery(pref) {
    if (!hasPreferences(pref.preferences)) return false;
    const dims = Object.keys(pref.preferences);
    if (pref.marker) return true;
    if (dims.length >= 2) return true;
    // A genre/language/activity/era/energy word is rarely a title on its own.
    if (dims.some(function (d) { return d !== 'mood'; })) return true;
    // Pure mood word with nothing else ("play sad", "something romantic"): residual empty.
    return pref.residual.length === 0;
  }

  function discoveryIntentFor(preferences) {
    const order = ['mood', 'genre', 'activity', 'language', 'era'];
    for (const dim of order) {
      if (!preferences[dim]) continue;
      if (dim === 'mood') return 'DISCOVER_BY_MOOD';
      if (dim === 'genre') return 'DISCOVER_BY_GENRE';
      if (dim === 'activity') return 'DISCOVER_BY_ACTIVITY';
      if (dim === 'language') return 'DISCOVER_BY_LANGUAGE';
      if (dim === 'era') return 'DISCOVER_BY_ERA';
    }
    return 'DISCOVER_BY_MOOD';
  }

  // ------------------------------------------------------------------ small helpers

  function cleanPhrase(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:the|a|an)\s+/, '')
      .trim();
  }

  function out(fields) {
    const base = { type: 'unknown', intent: 'UNKNOWN', confidence: 0.3, entities: {}, preferences: {}, references: [] };
    return Object.assign(base, fields);
  }

  function control(t) {
    if (PAUSE.test(t) || PAUSE_HI.test(t)) return { type: 'pause', intent: 'PAUSE', confidence: 0.99 };
    if (RESTART.test(t)) return { type: 'restart', intent: 'RESTART_TRACK', confidence: 0.98 };
    if (NEXT.test(t)) return { type: 'next', intent: 'NEXT_TRACK', confidence: 0.97 };
    if (PREVIOUS.test(t)) return { type: 'previous', intent: 'PREVIOUS_TRACK', confidence: 0.97 };
    if (RESUME.test(t)) return { type: 'resume', intent: 'RESUME', confidence: 0.96 };
    if (REJECT.test(t)) return { type: 'reject', intent: 'REJECT', confidence: 0.95 };
    if (MUTE.test(t)) return { type: 'mute', intent: 'MUTE', confidence: 0.98 };
    if (UNMUTE.test(t)) return { type: 'unmute', intent: 'UNMUTE', confidence: 0.98 };
    return null;
  }

  function volume(t) {
    const v = volumeNumbers(t);
    let m;
    if ((m = v.match(VOLUME_SET))) {
      const n = parseInt(m[1] || m[2] || m[3], 10);
      if (!Number.isNaN(n)) {
        return { type: 'volume_set', intent: 'SET_VOLUME', value: Math.max(0, Math.min(100, n)), confidence: 0.98 };
      }
    }
    // Bare "max/full": unambiguous volume only when paired with a volume noun.
    if (/\b(volume|awaaz|awaz|sound)\s+(100|max|maximum|full)\b|\b(100|max|full)\s+(volume|awaaz|awaz)\b/.test(v)) {
      return { type: 'volume_set', intent: 'SET_VOLUME', value: 100, confidence: 0.97 };
    }
    const step = BIG_STEP.test(t) ? 30 : 15;
    if (VOLUME_UP.test(t)) return { type: 'volume_up', intent: 'INCREASE_VOLUME', step: step, confidence: 0.95 };
    if (VOLUME_DOWN.test(t)) return { type: 'volume_down', intent: 'DECREASE_VOLUME', step: step, confidence: 0.95 };
    return null;
  }

  function clarify(question, partial) {
    return out(Object.assign({
      type: 'clarify',
      intent: 'CLARIFY_REQUEST',
      question: question,
      confidence: 0.35
    }, partial || {}));
  }

  // ------------------------------------------------------------------ extraction

  /**
   * extractIntent(text) -> structured intent (see file header).
   * Never throws; unknown input returns { type: 'unknown' }.
   */
  function extractIntent(text) {
    const t = stripPoliteness(norm(text));
    if (!t) return out({ type: 'unknown' });

    // 1. Option selection ("option two", "dusra wala").
    const sel = t.match(SELECT);
    if (sel) {
      return out({
        type: 'select_option',
        intent: 'SELECT_OPTION',
        index: ORDINALS[sel[1]],
        fallbackQuery: t.replace(/^play /, ''),
        confidence: 0.97
      });
    }

    // 2. Transport / mute / reject.
    //    Exception: "play another romantic song" is a discovery refinement, not "next".
    const prefAll = parsePreferences(t);
    const wantsMore = /\b(another|one more|something else|different)\b/.test(t);
    if (wantsMore && isDiscovery(prefAll)) {
      return discoveryResult(t, prefAll, { refine: true, confidence: 0.88 });
    }

    const ctl = control(t);
    if (ctl) return out(ctl);

    // 3. Explicit volume commands, checked BEFORE any play/implicit song reading.
    //    ("set volume to maximum" must never be a song search.)
    if (AMBIGUOUS_MAX.test(t)) {
      return clarify('Did you mean "volume max", or a song called Maximum?');
    }
    const vol = volume(t);
    if (vol) return out(vol);

    // 4. Play / search verbs.
    let rest = null;
    let search = false;
    let pre = t.match(PLAY_PREFIX);
    if (pre) {
      rest = stripPoliteness(pre[1]);
    } else if ((pre = t.match(SEARCH_PREFIX))) {
      rest = stripPoliteness(pre[1]);
      search = true;
    } else if ((pre = t.match(PUT_ON))) {
      rest = stripPoliteness(pre[1]);
    }

    if (rest !== null) {
      // "play music", "play something" (no preferences) -> resume, not a song search.
      if (!search && /^(some |any )?(music|songs?|something|anything|kuch bhi|koi gaana|koi bhi gaana|kuch|koi)$/.test(rest)) {
        return out({ type: 'resume', intent: 'RESUME', confidence: 0.9 });
      }

      // Transport after a play verb: "play next", "play the previous one".
      const inner = rest.replace(/^the\s+/, '');
      const ctlRest = control(inner);
      if (ctlRest && ctlRest.type !== 'reject') return out(ctlRest);

      // "play a romantic hindi song" etc.
      const pref = parsePreferences(rest);
      if (!search && isDiscovery(pref)) {
        return discoveryResult(rest, pref, { confidence: 0.9 });
      }

      const structured = structural(rest, t, { search: search });
      if (structured) return structured;

      if (search) {
        return out({
          type: 'play_song',
          intent: 'SEARCH_TRACK',
          query: cleanPhrase(rest),
          implicit: false,
          confidence: 0.85
        });
      }

      // Lyric fragments ("play the song that goes ...").
      if (LYRIC_HINT.test(rest)) {
        return out({
          type: 'play_song',
          intent: 'IDENTIFY_BY_LYRICS',
          query: rest,
          implicit: false,
          confidence: 0.8
        });
      }

      return trackResult(rest, false);
    }

    // 5. "<title> bajao" / "chalao" (Hindi verb at the end).
    const suf = t.match(PLAY_SUFFIX);
    if (suf) {
      const phrase = stripPoliteness(suf[1]);
      const pref = parsePreferences(phrase);
      if (isDiscovery(pref)) return discoveryResult(phrase, pref, { confidence: 0.88 });
      const structured = structural(phrase, t, { search: false });
      if (structured) return structured;
      if (LYRIC_HINT.test(phrase)) {
        return out({
          type: 'play_song',
          intent: 'IDENTIFY_BY_LYRICS',
          query: phrase,
          implicit: false,
          confidence: 0.8
        });
      }
      return trackResult(phrase, false);
    }

    // 6. No verb: pure discovery/refinement or an implicit song guess.
    const pref = parsePreferences(t);
    if (isDiscovery(pref)) {
      const refine = pref.residual.length === 0;
      return discoveryResult(t, pref, { refine: refine, confidence: 0.82 });
    }

    // Context-only references: "the album", "that song", "in hindi" with no other words.
    const ref = contextReference(t, pref);
    if (ref) return ref;

    // Lyric hint without a verb ("song that goes ...").
    if (LYRIC_HINT.test(t)) {
      return out({
        type: 'play_song',
        intent: 'IDENTIFY_BY_LYRICS',
        query: t,
        implicit: false,
        confidence: 0.75
      });
    }

    return trackResult(t, true);
  }

  function discoveryResult(text, pref, opts) {
    const preferences = pref.preferences;
    const confidence = opts.confidence || 0.85;
    return out({
      type: 'play_song',
      intent: opts.refine ? 'REFINE_CURRENT_DISCOVERY' : discoveryIntentFor(preferences),
      query: cleanPhrase(text),
      implicit: false,
      preferences: preferences,
      labels: pref.labels,
      references: opts.refine ? ['currentDiscovery'] : [],
      refine: !!opts.refine,
      confidence: confidence
    });
  }

  function trackResult(phrase, implicit) {
    const cleaned = cleanPhrase(phrase);
    // "it", "that", "this" alone: only meaningful with context — the backend decides.
    if (/^(it|that|this|that one|this one|the song|that song|this song|the track|that track)$/.test(cleaned)) {
      return out({
        type: 'play_song',
        intent: 'PLAY_CONTEXT',
        query: cleaned,
        implicit: implicit,
        references: ['currentTrack'],
        confidence: 0.6
      });
    }
    // "his latest song", "her new track": artist comes from context.
    const pron = cleaned.match(/^(his|her|their|uska|uski|unki)\s+(latest|newest|new|recent)?\s*(song|track|gaana|gana|album)?$/);
    if (pron) {
      return out({
        type: 'play_song',
        intent: pron[3] === 'album' ? 'PLAY_ALBUM' : 'PLAY_ARTIST',
        query: cleaned,
        implicit: false,
        entities: { artistRef: pron[1], latest: true },
        references: ['currentArtist'],
        confidence: 0.7
      });
    }
    return out({
      type: 'play_song',
      intent: implicit ? 'PLAY_TRACK' : 'PLAY_TRACK',
      query: cleaned,
      implicit: implicit,
      confidence: implicit ? 0.55 : 0.85
    });
  }

  /**
   * Album / playlist / artist / similarity structures. Returns null if the phrase
   * is a plain track request.
   */
  function structural(rest, full, opts) {
    const search = !!(opts && opts.search);
    const phrase = cleanPhrase(rest);

    // ---- similarity: "something like The Weeknd", "similar to Drake", "jaisa Arijit"
    const sim = phrase.match(/^(?:something\s+|some\s+|songs?\s+|music\s+)?(?:like|similar to|sounds like|same as|jaisa|jaise)\s+(.+)$/);
    if (sim) {
      let target = sim[1].trim();
      // "X but slower" -> keep "slower" as an energy preference, not part of the artist.
      const butIdx = target.search(/\s+but\s+/);
      let preferences = {};
      if (butIdx > 0) {
        const tail = parsePreferences(target.slice(butIdx));
        preferences = tail.preferences;
        target = target.slice(0, butIdx).trim();
      }
      if (!target) return null;
      return out({
        type: 'play_song',
        intent: 'DISCOVER_SIMILAR',
        query: target,
        implicit: false,
        entities: { similarTo: target },
        preferences: preferences,
        confidence: 0.85
      });
    }

    // ---- playlist: "my workout playlist", "playlist chill vibes", "the playlist"
    const plMatches = [
      /^(?:the\s+|my\s+)?playlist(?:\s+(?:called|named)\s+(.+))?$/,
      /^(?:my\s+)?(.+?)\s+playlist$/,
      /^playlist\s+(.+)$/
    ];
    for (const p of plMatches) {
      const m = phrase.match(p);
      if (!m) continue;
      const title = (m[1] || '').trim();
      if (!title) {
        return out({
          type: 'play_song',
          intent: search ? 'SEARCH_PLAYLIST' : 'PLAY_CONTEXT',
          query: 'playlist',
          implicit: false,
          entities: { collection: 'playlist' },
          references: search ? [] : ['currentPlaylist'],
          confidence: 0.7
        });
      }
      return out({
        type: 'play_song',
        intent: search ? 'SEARCH_PLAYLIST' : 'PLAY_PLAYLIST',
        query: title,
        implicit: false,
        entities: { collection: 'playlist', title: title },
        confidence: 0.85
      });
    }

    // ---- album: "latest album by X", "X's latest album", "play After Hours album"
    const albumPatterns = [
      { re: /^(?:the\s+)?(?:latest|newest|new)\s+album(?:\s+(?:by|of|from)\s+(.+))?$/, artist: 1, latest: true },
      { re: /^(.+?)'s?\s+(?:latest|newest|new)\s+album$/, artist: 1, latest: true },
      { re: /^album\s+(?:by|of|from)\s+(.+)$/, artist: 1, latest: true },
      { re: /^album\s+(?:called\s+|named\s+)?(.+?)(?:\s+by\s+(.+))?$/, title: 1, artist: 2 },
      { re: /^(.+?)\s+album(?:\s+by\s+(.+))?$/, title: 1, artist: 2 }
    ];
    for (const p of albumPatterns) {
      const m = phrase.match(p.re);
      if (!m) continue;
      const title = p.title ? (m[p.title] || '').trim() : '';
      const artist = p.artist ? (m[p.artist] || '').trim() : '';
      if (!title && !artist) {
        return out({
          type: 'play_song',
          intent: search ? 'SEARCH_ALBUM' : 'PLAY_CONTEXT',
          query: 'album',
          implicit: false,
          entities: { collection: 'album', latest: !!p.latest },
          references: search ? [] : ['currentAlbum'],
          confidence: 0.7
        });
      }
      return out({
        type: 'play_song',
        intent: search ? 'SEARCH_ALBUM' : 'PLAY_ALBUM',
        query: title || artist,
        implicit: false,
        entities: { collection: 'album', title: title || null, artist: artist || null, latest: !!p.latest },
        confidence: 0.87
      });
    }

    // ---- artist: "songs by Arijit", "Arijit ke gaane", "Arijit Singh songs"
    const artistPatterns = [
      /^(?:songs?|tracks?|music|gaane|gana|gaana|geet)\s+(?:by|of|from)\s+(.+)$/,
      /^(.+?)\s+(?:ke|ka|ki)\s+(?:gaane|gana|gaana|song|songs|music)$/,
      /^(.+?)\s+songs?$/,
      /^artist\s+(.+)$/
    ];
    for (const p of artistPatterns) {
      const m = phrase.match(p);
      if (m && m[1] && m[1].trim()) {
        return out({
          type: 'play_song',
          intent: search ? 'SEARCH_ARTIST' : 'PLAY_ARTIST',
          query: m[1].trim(),
          implicit: false,
          entities: { artist: m[1].trim() },
          confidence: 0.85
        });
      }
    }

    // ---- context-only references tied to a collection noun
    const ref = contextReference(phrase, null);
    if (ref && !search) return ref;

    return null;
  }

  function contextReference(t, pref) {
    if (/^(?:the\s+)?(?:album|albums)$/.test(t)) {
      return out({
        type: 'play_song',
        intent: 'PLAY_CONTEXT',
        query: t,
        implicit: false,
        entities: { collection: 'album' },
        references: ['currentAlbum'],
        confidence: 0.75
      });
    }
    if (/^(?:the\s+)?(?:playlist|playlists)$/.test(t)) {
      return out({
        type: 'play_song',
        intent: 'PLAY_CONTEXT',
        query: t,
        implicit: false,
        entities: { collection: 'playlist' },
        references: ['currentPlaylist'],
        confidence: 0.75
      });
    }
    if (/\b(?:song|track|gaana|gana)\s+(?:i|we)\s+(?:was|were|just)\s+(?:listening|hearing|playing|played)\b/.test(t) ||
        /\b(?:last|previous)\s+(?:song|track)\b/.test(t) ||
        /^(?:play\s+)?(?:that|the)\s+(?:song|track|one)$/.test(t)) {
      return out({
        type: 'play_song',
        intent: 'PLAY_CONTEXT',
        query: t,
        implicit: false,
        references: ['lastTrack'],
        confidence: 0.72
      });
    }
    if (/^(?:something\s+)?similar$/.test(t) || /^something\s+similar$/.test(t)) {
      return out({
        type: 'play_song',
        intent: 'REFINE_CURRENT_DISCOVERY',
        query: t,
        implicit: false,
        references: ['currentDiscovery'],
        refine: true,
        confidence: 0.7
      });
    }
    if (pref && pref.residual.length === 0 && hasPreferences(pref.preferences)) {
      return discoveryResult(t, pref, { refine: true, confidence: 0.8 });
    }
    return null;
  }

  return {
    extractIntent: extractIntent,
    normalizeCommand: function (s) { return stripPoliteness(norm(s)); },
    parsePreferences: parsePreferences,
    LEXICON: LEXICON,
    // Exposed for tests and for the backend assistant.
    _internal: { isDiscovery: isDiscovery, TERM_INDEX: TERM_INDEX }
  };
});
