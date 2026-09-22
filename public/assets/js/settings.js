/* AppSettings — theme + reporter preferences, loaded in <head> of every page.

   Also required directly by the Node tests, which is why the storage and
   document access below is guarded: the reporter prompt library is plain
   data manipulation and is worth testing without a browser. */
(function () {
  'use strict';

  /* Storage reads are wrapped because localStorage is not always there to be
     read: Safari private browsing throws on write, embedded webviews can
     disable it outright, and under Node there is no localStorage at all.
     The in-memory fallback keeps a page (or a test) working for the session
     instead of throwing on first access. */
  var memoryStore = {};

  function hasLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage !== null;
    } catch (err) {
      return false;
    }
  }

  function storeGet(key) {
    if (hasLocalStorage()) {
      try {
        var value = localStorage.getItem(key);
        if (value !== null) return value;
      } catch (err) {}
    }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function storeSet(key, value) {
    memoryStore[key] = String(value);
    if (hasLocalStorage()) {
      try {
        localStorage.setItem(key, String(value));
      } catch (err) {}
    }
  }

  var THEMES = {
    dark: {
      label: 'Dark',
      swatch: ['#070a12', '#4da3ff'],
      vars: {
        '--bg': '#070a12', '--panel': '#0f1524', '--panel-2': '#121b2e', '--panel-3': '#17223a',
        '--surface': '#0f1524', '--surface2': '#121b2e',
        '--border': 'rgba(255,255,255,0.08)', '--border-hover': 'rgba(255,255,255,0.16)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.4)',
        '--text': '#edf3ff', '--soft': '#aab7cf', '--muted': '#8492aa', '--dim': '#566070',
        '--blue': '#4da3ff', '--blue-bg': 'rgba(77,163,255,0.12)',
        '--purple': '#9b7bff', '--purple-bg': 'rgba(155,123,255,0.12)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.12)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.12)', '--yellow': '#f5c542',
        '--coral': '#ff4d6d', '--coral-bg': 'rgba(255,77,109,0.12)',
        '--red': '#ff4d6d', '--red-bg': 'rgba(255,77,109,0.12)',
        '--accent': '#4da3ff', '--accent-bg': 'rgba(77,163,255,0.12)',
      },
      body: 'radial-gradient(circle at top left, rgba(77,163,255,0.16), transparent 32%), radial-gradient(circle at top right, rgba(155,123,255,0.13), transparent 34%), linear-gradient(135deg, #050711, #08101e 45%, #050711)',
    },
    midnight: {
      label: 'Midnight',
      swatch: ['#000000', '#5badff'],
      vars: {
        '--bg': '#000000', '--panel': '#080810', '--panel-2': '#0d0d18', '--panel-3': '#12121f',
        '--surface': '#080810', '--surface2': '#0d0d18',
        '--border': 'rgba(255,255,255,0.07)', '--border-hover': 'rgba(255,255,255,0.13)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.65)',
        '--text': '#f0f4ff', '--soft': '#9aaac4', '--muted': '#6a7890', '--dim': '#485060',
        '--blue': '#5badff', '--blue-bg': 'rgba(91,173,255,0.1)',
        '--purple': '#a98bff', '--purple-bg': 'rgba(169,139,255,0.1)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.1)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.1)', '--yellow': '#f5c542',
        '--coral': '#ff4d6d', '--coral-bg': 'rgba(255,77,109,0.1)',
        '--red': '#ff4d6d', '--red-bg': 'rgba(255,77,109,0.1)',
        '--accent': '#5badff', '--accent-bg': 'rgba(91,173,255,0.1)',
      },
      body: 'radial-gradient(circle at top left, rgba(91,173,255,0.09), transparent 28%), linear-gradient(135deg, #000000, #04040e 55%, #000000)',
    },
    dusk: {
      label: 'Dusk',
      swatch: ['#0c0914', '#a98bff'],
      vars: {
        '--bg': '#0c0914', '--panel': '#130e22', '--panel-2': '#18122e', '--panel-3': '#1e1638',
        '--surface': '#130e22', '--surface2': '#18122e',
        '--border': 'rgba(155,123,255,0.14)', '--border-hover': 'rgba(155,123,255,0.26)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#f2eeff', '--soft': '#b4a4d4', '--muted': '#8878ac', '--dim': '#5c5078',
        '--blue': '#a98bff', '--blue-bg': 'rgba(169,139,255,0.12)',
        '--purple': '#c97bff', '--purple-bg': 'rgba(201,123,255,0.12)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.1)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.1)', '--yellow': '#f5c542',
        '--coral': '#ff4d6d', '--coral-bg': 'rgba(255,77,109,0.1)',
        '--red': '#ff4d6d', '--red-bg': 'rgba(255,77,109,0.1)',
        '--accent': '#a98bff', '--accent-bg': 'rgba(169,139,255,0.12)',
      },
      body: 'radial-gradient(circle at top left, rgba(169,139,255,0.2), transparent 35%), radial-gradient(circle at bottom right, rgba(201,123,255,0.12), transparent 35%), linear-gradient(135deg, #07050e, #0c0918 50%, #07050e)',
    },
    ocean: {
      label: 'Ocean',
      swatch: ['#071820', '#22d3ee'],
      vars: {
        '--bg': '#071820', '--panel': '#0c2530', '--panel-2': '#123240', '--panel-3': '#173e4e',
        '--surface': '#0c2530', '--surface2': '#123240',
        '--border': 'rgba(34,211,238,0.14)', '--border-hover': 'rgba(34,211,238,0.28)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#e8fbff', '--soft': '#a8d8e0', '--muted': '#6f9aa6', '--dim': '#4a6e78',
        '--blue': '#22d3ee', '--blue-bg': 'rgba(34,211,238,0.12)',
        '--purple': '#38bdf8', '--purple-bg': 'rgba(56,189,248,0.12)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.12)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.1)', '--yellow': '#f5c542',
        '--coral': '#ff6b6b', '--coral-bg': 'rgba(255,107,107,0.1)',
        '--red': '#ff6b6b', '--red-bg': 'rgba(255,107,107,0.1)',
        '--accent': '#22d3ee', '--accent-bg': 'rgba(34,211,238,0.12)',
      },
      body: 'radial-gradient(circle at top left, rgba(34,211,238,0.16), transparent 32%), linear-gradient(135deg, #020c10, #071c24 45%, #020c10)',
    },
    sunset: {
      label: 'Sunset',
      swatch: ['#180d08', '#ff8a3d'],
      vars: {
        '--bg': '#180d08', '--panel': '#231208', '--panel-2': '#2c170b', '--panel-3': '#361c0e',
        '--surface': '#231208', '--surface2': '#2c170b',
        '--border': 'rgba(255,138,61,0.16)', '--border-hover': 'rgba(255,138,61,0.3)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#fff2e8', '--soft': '#e0b89a', '--muted': '#a67c5c', '--dim': '#70503a',
        '--blue': '#ff8a3d', '--blue-bg': 'rgba(255,138,61,0.12)',
        '--purple': '#ff6b6b', '--purple-bg': 'rgba(255,107,107,0.12)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.1)',
        '--amber': '#ffcf5c', '--amber-bg': 'rgba(255,207,92,0.12)', '--yellow': '#ffcf5c',
        '--coral': '#ff5c5c', '--coral-bg': 'rgba(255,92,92,0.12)',
        '--red': '#ff5c5c', '--red-bg': 'rgba(255,92,92,0.12)',
        '--accent': '#ff8a3d', '--accent-bg': 'rgba(255,138,61,0.12)',
      },
      body: 'radial-gradient(circle at top right, rgba(255,138,61,0.18), transparent 34%), linear-gradient(135deg, #0d0603, #1c0f08 50%, #0d0603)',
    },
    forest: {
      label: 'Forest',
      swatch: ['#07130d', '#3ddc84'],
      vars: {
        '--bg': '#07130d', '--panel': '#0d1e15', '--panel-2': '#13291b', '--panel-3': '#193422',
        '--surface': '#0d1e15', '--surface2': '#13291b',
        '--border': 'rgba(61,220,132,0.14)', '--border-hover': 'rgba(61,220,132,0.28)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#e9fff2', '--soft': '#9fd8b6', '--muted': '#679c7e', '--dim': '#456e56',
        '--blue': '#3ddc84', '--blue-bg': 'rgba(61,220,132,0.12)',
        '--purple': '#9b7bff', '--purple-bg': 'rgba(155,123,255,0.1)',
        '--green': '#3ddc84', '--teal': '#3ddc84', '--teal-bg': 'rgba(61,220,132,0.12)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.1)', '--yellow': '#f5c542',
        '--coral': '#ff5d6c', '--coral-bg': 'rgba(255,93,108,0.1)',
        '--red': '#ff5d6c', '--red-bg': 'rgba(255,93,108,0.1)',
        '--accent': '#3ddc84', '--accent-bg': 'rgba(61,220,132,0.12)',
      },
      body: 'radial-gradient(circle at top left, rgba(61,220,132,0.16), transparent 32%), linear-gradient(135deg, #03110b, #06180f 45%, #03110b)',
    },
    rose: {
      label: 'Rose',
      swatch: ['#1a0712', '#ff5fa2'],
      vars: {
        '--bg': '#1a0712', '--panel': '#260c1b', '--panel-2': '#301024', '--panel-3': '#3b142d',
        '--surface': '#260c1b', '--surface2': '#301024',
        '--border': 'rgba(255,95,162,0.15)', '--border-hover': 'rgba(255,95,162,0.3)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#ffeef7', '--soft': '#dba6c2', '--muted': '#a06f8c', '--dim': '#6e4b5e',
        '--blue': '#ff5fa2', '--blue-bg': 'rgba(255,95,162,0.12)',
        '--purple': '#c96bff', '--purple-bg': 'rgba(201,107,255,0.12)',
        '--green': '#00e396', '--teal': '#00e396', '--teal-bg': 'rgba(0,227,150,0.1)',
        '--amber': '#f5c542', '--amber-bg': 'rgba(245,197,66,0.1)', '--yellow': '#f5c542',
        '--coral': '#ff4d6d', '--coral-bg': 'rgba(255,77,109,0.1)',
        '--red': '#ff4d6d', '--red-bg': 'rgba(255,77,109,0.1)',
        '--accent': '#ff5fa2', '--accent-bg': 'rgba(255,95,162,0.12)',
      },
      body: 'radial-gradient(circle at top right, rgba(255,95,162,0.18), transparent 34%), linear-gradient(135deg, #0f0409, #190711 50%, #0f0409)',
    },
    terminal: {
      label: 'Terminal',
      swatch: ['#000000', '#00ff41'],
      vars: {
        '--bg': '#000000', '--panel': '#0a0a0a', '--panel-2': '#0f0f0f', '--panel-3': '#141414',
        '--surface': '#0a0a0a', '--surface2': '#0f0f0f',
        '--border': 'rgba(0,255,65,0.15)', '--border-hover': 'rgba(0,255,65,0.35)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.8)',
        '--text': '#00ff41', '--soft': '#00cc33', '--muted': '#009922', '--dim': '#006614',
        '--blue': '#00ff41', '--blue-bg': 'rgba(0,255,65,0.1)',
        '--purple': '#00ff41', '--purple-bg': 'rgba(0,255,65,0.1)',
        '--green': '#00ff41', '--teal': '#00ff41', '--teal-bg': 'rgba(0,255,65,0.12)',
        '--amber': '#ffcc00', '--amber-bg': 'rgba(255,204,0,0.1)', '--yellow': '#ffcc00',
        '--coral': '#ff3333', '--coral-bg': 'rgba(255,51,51,0.1)',
        '--red': '#ff3333', '--red-bg': 'rgba(255,51,51,0.1)',
        '--accent': '#00ff41', '--accent-bg': 'rgba(0,255,65,0.12)',
      },
      body: 'linear-gradient(180deg, #000000, #000000)',
    },
    minimal: {
      label: 'Minimal',
      swatch: ['#1c1c1e', '#d4a843'],
      vars: {
        '--bg': '#1c1c1e', '--panel': '#242426', '--panel-2': '#2c2c2e', '--panel-3': '#323234',
        '--surface': '#242426', '--surface2': '#2c2c2e',
        '--border': 'rgba(255,255,255,0.1)', '--border-hover': 'rgba(212,168,67,0.4)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.5)',
        '--text': '#ffffff', '--soft': '#ebebf5', '--muted': '#aeaeb2', '--dim': '#636366',
        '--blue': '#d4a843', '--blue-bg': 'rgba(212,168,67,0.12)',
        '--purple': '#d4a843', '--purple-bg': 'rgba(212,168,67,0.12)',
        '--green': '#30d158', '--teal': '#30d158', '--teal-bg': 'rgba(48,209,88,0.12)',
        '--amber': '#d4a843', '--amber-bg': 'rgba(212,168,67,0.12)', '--yellow': '#d4a843',
        '--coral': '#ff453a', '--coral-bg': 'rgba(255,69,58,0.12)',
        '--red': '#ff453a', '--red-bg': 'rgba(255,69,58,0.12)',
        '--accent': '#d4a843', '--accent-bg': 'rgba(212,168,67,0.12)',
      },
      body: 'linear-gradient(160deg, #1c1c1e 0%, #18181a 100%)',
    },
    light: {
      label: 'Light',
      swatch: ['#eef2f9', '#1a7aff'],
      vars: {
        '--bg': '#eef2f9', '--panel': '#ffffff', '--panel-2': '#f6f8fd', '--panel-3': '#edf1f8',
        '--surface': '#ffffff', '--surface2': '#f4f6fb',
        '--border': 'rgba(0,0,0,0.09)', '--border-hover': 'rgba(0,0,0,0.17)',
        '--shadow': '0 12px 40px rgba(0,0,0,0.1)',
        '--text': '#0c1222', '--soft': '#374860', '--muted': '#627896', '--dim': '#96a8c0',
        '--blue': '#1a7aff', '--blue-bg': 'rgba(26,122,255,0.09)',
        '--purple': '#7b4bff', '--purple-bg': 'rgba(123,75,255,0.09)',
        '--green': '#00a86b', '--teal': '#00a86b', '--teal-bg': 'rgba(0,168,107,0.09)',
        '--amber': '#c89000', '--amber-bg': 'rgba(200,144,0,0.1)', '--yellow': '#c89000',
        '--coral': '#e0294a', '--coral-bg': 'rgba(224,41,74,0.09)',
        '--red': '#e0294a', '--red-bg': 'rgba(224,41,74,0.09)',
        '--accent': '#1a7aff', '--accent-bg': 'rgba(26,122,255,0.09)',
      },
      body: 'linear-gradient(135deg, #e4ecf6, #eef2fa 50%, #e0eaf6)',
    },
  };

  var DEFAULT_REPORTER_PROMPTS = {
    geopolitics:
`{date}
TOP 10 GEOPOLITICAL DEVELOPMENTS BRIEF (LAST 24-48 HOURS)

Search for current, verified geopolitical developments and produce a globally balanced TOP 10 report.

Rules:
- Output exactly 10 stories.
- Prioritize conflicts, diplomacy, sanctions, defense, trade restrictions, energy security, and shipping disruptions.
- Use a bold numbered heading and 2-3 short hyphen bullets per story.
- Separate confirmed facts from analysis and do not make market calls.
- Avoid duplicating the same event from multiple sources.`,
    crypto:
`{date}
TOP 10 EMERGING / TRENDING CRYPTO TOKENS

Find 10 crypto tokens that are trending or starting to emerge right now. Keep this lightweight: use recent web results and market/news mentions, but do not perform a deep risk audit.

Rules:
- Output exactly 10 tokens.
- Prefer tokens with recent momentum, fresh listings, rising volume, social buzz, or a clear narrative.
- Avoid obvious mega-caps unless there is a fresh reason they are trending.
- Use simple hyphen bullets only.
- Keep each item short: heading plus 2-3 bullets.
- Do not give financial advice or buy/sell instructions.

Format each item:
**#[N] [TOKEN NAME] ([TICKER]) - [CHAIN / CATEGORY]**
- Why it is trending
- Main catalyst or signal
- Quick caution if relevant`,
    economics:
`{date}
TOP 10 GLOBAL ECONOMIC DEVELOPMENTS BRIEF

Search for current and verified economic events, indicators, policy moves, market data, or macro developments from the last 24-48 hours and produce a TOP 10 report.

Rules:
- Output exactly 10 items.
- Cover a globally balanced mix across major economies.
- Use simple hyphen bullets only.
- Keep each item short and structured.
- Include data plus actual vs. expected where relevant.
- If uncertain of a specific data point, omit it rather than approximate.`,
    markets:
`{date}
Create a TOP 10 global markets news brief from the past 24-48 hours.

Coverage should include a mix of stocks, indices, forex, commodities, bonds, rates, macro, and central banks.

Rules:
- Output exactly 10 stories.
- Include title, why it matters, assets affected, and sentiment.
- Keep each story short.
- No long paragraphs.
- Use hyphen bullets only.`,
  };

  /* Accent — a colour laid over whichever theme is active. Each option
     points at the theme's own variable rather than a fixed hex, so every
     theme keeps supplying a value tuned for its own background and accent
     text stays readable on light, terminal and the dark palettes alike. */
  var ACCENTS = {
    theme:  { label: 'Theme',  color: '',              bg: '' },
    blue:   { label: 'Blue',   color: 'var(--blue)',   bg: 'var(--blue-bg)' },
    purple: { label: 'Purple', color: 'var(--purple)', bg: 'var(--purple-bg)' },
    teal:   { label: 'Teal',   color: 'var(--teal)',   bg: 'var(--teal-bg)' },
    amber:  { label: 'Amber',  color: 'var(--amber)',  bg: 'var(--amber-bg)' },
    coral:  { label: 'Coral',  color: 'var(--coral)',  bg: 'var(--coral-bg)' },
  };

  /* ── Reporter prompt library ─────────────────────────────

     A prompt is a named, editable block of text bound to one reporter desk.
     Every desk ships with a built-in prompt that can be retitled, rewritten
     and reset but never deleted, so there is always something to generate
     with; on top of that the user can add, rename, duplicate and delete as
     many prompts as they like and pick which one each desk actually uses.

     The four desks are fixed because the server stores reports under exactly
     those keys — a new prompt targets an existing desk rather than creating
     a fifth one.

     Everything below is pure: each function takes a library and returns a new
     one. Persistence lives in the AppSettings wrappers at the bottom, which
     is what lets the Node tests exercise the rules directly. */

  var REPORTER_SECTIONS = ['geopolitics', 'economics', 'markets', 'crypto'];

  var REPORTER_DESK_LABELS = {
    geopolitics: 'Geopolitics',
    economics: 'Economics',
    markets: 'Stocks / Markets',
    crypto: 'Crypto / Emerging Markets',
  };

  var DEFAULT_REPORTER_TITLES = {
    geopolitics: 'Geopolitics Top 10',
    economics: 'Economics Top 10',
    markets: 'Markets Top 10',
    crypto: 'Emerging Markets',
  };

  /* The refresh choices the settings page offers, in hours. The value is
     sent to the API as ttlHours, which the reporter turns into a whole-day
     cooldown between generations of the same desk. */
  var REPORTER_FREQUENCIES = [24, 48];

  var PROMPT_LIBRARY_KEY = 'reporterPrompts:v1';
  var LEGACY_PROMPT_PREFIX = 'reporterPrompt:';
  var MAX_TITLE_LEN = 80;
  /* Matches the server's own cap in services/reporter.js, so a prompt that
     saves here is never silently truncated at generation time. */
  var MAX_PROMPT_LEN = 12000;

  function normalizeReporterSection(section) {
    return REPORTER_SECTIONS.indexOf(section) !== -1 ? section : 'crypto';
  }

  function builtinPromptId(section) {
    return 'desk:' + section;
  }

  function cleanPromptTitle(title, fallback) {
    var value = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN);
    return value || fallback || 'Untitled prompt';
  }

  function cleanPromptText(text) {
    return String(text == null ? '' : text).trim().slice(0, MAX_PROMPT_LEN);
  }

  function newPromptId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function builtinPrompt(section) {
    return {
      id: builtinPromptId(section),
      title: DEFAULT_REPORTER_TITLES[section],
      section: section,
      text: DEFAULT_REPORTER_PROMPTS[section],
      builtin: true,
    };
  }

  function findPrompt(library, id) {
    var wanted = String(id || '');
    for (var i = 0; i < library.prompts.length; i += 1) {
      if (library.prompts[i].id === wanted) return library.prompts[i];
    }
    return null;
  }

  function cloneLibrary(library) {
    var active = {};
    REPORTER_SECTIONS.forEach(function (section) {
      active[section] = library.active[section];
    });
    return {
      version: 1,
      prompts: library.prompts.map(function (prompt) {
        return {
          id: prompt.id,
          title: prompt.title,
          section: prompt.section,
          text: prompt.text,
          builtin: prompt.builtin,
        };
      }),
      active: active,
    };
  }

  /**
   * A fresh library: one built-in prompt per desk, each of them active.
   * `legacy` carries the old per-section overrides so a browser that saved
   * prompts before the library existed keeps its edits.
   */
  function createPromptLibrary(legacy) {
    var overrides = legacy || {};
    var library = { version: 1, prompts: [], active: {} };
    REPORTER_SECTIONS.forEach(function (section) {
      var prompt = builtinPrompt(section);
      var carried = cleanPromptText(overrides[section]);
      if (carried) prompt.text = carried;
      library.prompts.push(prompt);
      library.active[section] = prompt.id;
    });
    return library;
  }

  /**
   * Repair anything read back from storage. Built-ins are rebuilt from the
   * shipped defaults and only their stored title/text are adopted, so a
   * corrupt or hand-edited entry can never leave a desk without a prompt.
   */
  function normalizePromptLibrary(raw) {
    if (!raw || typeof raw !== 'object') return createPromptLibrary(null);
    var incoming = Array.isArray(raw.prompts) ? raw.prompts : [];
    var prompts = [];
    var seen = {};

    REPORTER_SECTIONS.forEach(function (section) {
      var prompt = builtinPrompt(section);
      var stored = incoming.filter(function (item) {
        return item && item.id === prompt.id;
      })[0];
      if (stored) {
        prompt.title = cleanPromptTitle(stored.title, prompt.title);
        var text = cleanPromptText(stored.text);
        if (text) prompt.text = text;
      }
      seen[prompt.id] = true;
      prompts.push(prompt);
    });

    incoming.forEach(function (stored) {
      if (!stored || typeof stored !== 'object') return;
      var id = String(stored.id || '');
      if (!id || seen[id] || id.indexOf('desk:') === 0) return;
      var text = cleanPromptText(stored.text);
      if (!text) return;
      seen[id] = true;
      prompts.push({
        id: id,
        title: cleanPromptTitle(stored.title, 'Untitled prompt'),
        section: normalizeReporterSection(stored.section),
        text: text,
        builtin: false,
      });
    });

    var storedActive = raw.active && typeof raw.active === 'object' ? raw.active : {};
    var active = {};
    REPORTER_SECTIONS.forEach(function (section) {
      var wanted = String(storedActive[section] || '');
      var match = prompts.filter(function (prompt) {
        return prompt.id === wanted && prompt.section === section;
      })[0];
      active[section] = match ? match.id : builtinPromptId(section);
    });

    return { version: 1, prompts: prompts, active: active };
  }

  function addPrompt(library, input) {
    var next = cloneLibrary(library);
    var section = normalizeReporterSection(input && input.section);
    var prompt = {
      id: newPromptId(),
      title: cleanPromptTitle(input && input.title, 'New prompt'),
      section: section,
      text: cleanPromptText(input && input.text) || DEFAULT_REPORTER_PROMPTS[section],
      builtin: false,
    };
    next.prompts.push(prompt);
    return { library: next, id: prompt.id };
  }

  function updatePrompt(library, id, patch) {
    var next = cloneLibrary(library);
    var prompt = findPrompt(next, id);
    if (!prompt) return next;
    var changes = patch || {};
    if (changes.title !== undefined) prompt.title = cleanPromptTitle(changes.title, prompt.title);
    if (changes.text !== undefined) {
      /* An emptied prompt is a reset, not a desk that generates nothing. */
      prompt.text = cleanPromptText(changes.text) || DEFAULT_REPORTER_PROMPTS[prompt.section];
    }
    /* A built-in belongs to its desk; only custom prompts can be moved. */
    if (changes.section !== undefined && !prompt.builtin) {
      var section = normalizeReporterSection(changes.section);
      if (section !== prompt.section) {
        if (next.active[prompt.section] === prompt.id) {
          next.active[prompt.section] = builtinPromptId(prompt.section);
        }
        prompt.section = section;
      }
    }
    return next;
  }

  function removePrompt(library, id) {
    var next = cloneLibrary(library);
    var prompt = findPrompt(next, id);
    /* The desk defaults are the floor: deleting one would leave a desk with
       nothing to generate from. They reset instead. */
    if (!prompt || prompt.builtin) return next;
    next.prompts = next.prompts.filter(function (item) {
      return item.id !== prompt.id;
    });
    REPORTER_SECTIONS.forEach(function (section) {
      if (next.active[section] === prompt.id) next.active[section] = builtinPromptId(section);
    });
    return next;
  }

  function duplicatePrompt(library, id) {
    var source = findPrompt(library, id);
    if (!source) return { library: cloneLibrary(library), id: null };
    return addPrompt(library, {
      title: cleanPromptTitle(source.title + ' copy', 'New prompt'),
      section: source.section,
      text: source.text,
    });
  }

  /** Make `id` the prompt its own desk generates with. */
  function setActivePrompt(library, id) {
    var next = cloneLibrary(library);
    var prompt = findPrompt(next, id);
    if (!prompt) return next;
    next.active[prompt.section] = prompt.id;
    return next;
  }

  function resetPrompt(library, id) {
    var next = cloneLibrary(library);
    var prompt = findPrompt(next, id);
    if (!prompt) return next;
    prompt.text = DEFAULT_REPORTER_PROMPTS[prompt.section];
    if (prompt.builtin) prompt.title = DEFAULT_REPORTER_TITLES[prompt.section];
    return next;
  }

  function activePrompt(library, section) {
    var target = normalizeReporterSection(section);
    return findPrompt(library, library.active[target]) || findPrompt(library, builtinPromptId(target));
  }

  function promptTextFor(library, section) {
    var prompt = activePrompt(library, section);
    return prompt ? prompt.text : DEFAULT_REPORTER_PROMPTS[normalizeReporterSection(section)];
  }

  /**
   * What the reporter page sends with a generation request.
   *
   * The server carries its own, longer prompt for each desk, so an untouched
   * desk default deliberately sends nothing and lets the server's version
   * run. Only a prompt the user actually authored overrides it.
   */
  function promptOverrideFor(library, section) {
    var prompt = activePrompt(library, section);
    if (!prompt) return '';
    if (prompt.builtin && prompt.text === DEFAULT_REPORTER_PROMPTS[prompt.section]) return '';
    return prompt.text;
  }

  var ReporterPrompts = {
    SECTIONS: REPORTER_SECTIONS,
    DESK_LABELS: REPORTER_DESK_LABELS,
    DEFAULT_TITLES: DEFAULT_REPORTER_TITLES,
    DEFAULT_TEXT: DEFAULT_REPORTER_PROMPTS,
    MAX_TITLE_LEN: MAX_TITLE_LEN,
    MAX_PROMPT_LEN: MAX_PROMPT_LEN,
    builtinId: builtinPromptId,
    create: createPromptLibrary,
    normalize: normalizePromptLibrary,
    find: findPrompt,
    add: addPrompt,
    update: updatePrompt,
    remove: removePrompt,
    duplicate: duplicatePrompt,
    setActive: setActivePrompt,
    reset: resetPrompt,
    activePrompt: activePrompt,
    textFor: promptTextFor,
    overrideFor: promptOverrideFor,
  };

  function readPromptLibrary() {
    var raw = null;
    try {
      raw = JSON.parse(storeGet(PROMPT_LIBRARY_KEY) || 'null');
    } catch (err) {
      raw = null;
    }
    if (raw) return normalizePromptLibrary(raw);
    /* First run on a browser that saved prompts under the old per-section
       keys — carry those edits in rather than dropping them. */
    var legacy = {};
    REPORTER_SECTIONS.forEach(function (section) {
      var value = storeGet(LEGACY_PROMPT_PREFIX + section);
      if (value) legacy[section] = value;
    });
    return createPromptLibrary(legacy);
  }

  function writePromptLibrary(library) {
    var normalized = normalizePromptLibrary(library);
    storeSet(PROMPT_LIBRARY_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function getAccent() {
    var name = storeGet('accent');
    return ACCENTS[name] ? name : 'theme';
  }

  /* Re-applied after every applyTheme(), which rewrites --accent from the
     theme's own vars and would otherwise wipe the override. Going back to
     'theme' has to restore those vars explicitly — clearing the attribute
     alone would leave the previous accent's colour on --accent. */
  function applyAccent(name) {
    var accent = ACCENTS[name] ? name : 'theme';
    var root = document.documentElement;
    if (accent === 'theme') {
      var vars = (THEMES[getTheme()] || THEMES.dark).vars;
      root.style.setProperty('--accent', vars['--accent']);
      root.style.setProperty('--accent-bg', vars['--accent-bg']);
      root.removeAttribute('data-accent');
    } else {
      root.style.setProperty('--accent', ACCENTS[accent].color);
      root.style.setProperty('--accent-bg', ACCENTS[accent].bg);
      root.setAttribute('data-accent', accent);
    }
    storeSet('accent', accent);
  }

  function applyTheme(name) {
    var theme = THEMES[name] || THEMES.dark;
    var root = document.documentElement;
    var vars = theme.vars;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        root.style.setProperty(k, vars[k]);
      }
    }
    root.setAttribute('data-theme', name);
    var bg = theme.body;
    if (bg) {
      if (document.body) {
        document.body.style.background = bg;
      } else {
        document.addEventListener('DOMContentLoaded', function () {
          document.body.style.background = bg;
        });
      }
    }
    storeSet('theme', name);
    applyAccent(getAccent());
  }

  function getTheme() {
    return storeGet('theme') || 'dark';
  }

  /* Apply immediately so there's no flash */
  if (typeof document !== 'undefined') applyTheme(getTheme());

  var AppSettings = {
    THEMES: THEMES,
    ACCENTS: ACCENTS,
    DEFAULT_REPORTER_PROMPTS: DEFAULT_REPORTER_PROMPTS,
    REPORTER_SECTIONS: REPORTER_SECTIONS,
    REPORTER_DESK_LABELS: REPORTER_DESK_LABELS,
    DEFAULT_REPORTER_TITLES: DEFAULT_REPORTER_TITLES,
    REPORTER_FREQUENCIES: REPORTER_FREQUENCIES,
    ReporterPrompts: ReporterPrompts,
    applyTheme: applyTheme,
    getTheme: getTheme,
    applyAccent: applyAccent,
    getAccent: getAccent,
    getFrequency: function () {
      var hours = parseInt(storeGet('reporterFreqHours') || '24', 10);
      return REPORTER_FREQUENCIES.indexOf(hours) === -1 ? 24 : hours;
    },
    setFrequency: function (h) {
      var hours = parseInt(h, 10);
      storeSet('reporterFreqHours', String(REPORTER_FREQUENCIES.indexOf(hours) === -1 ? 24 : hours));
    },

    /* ── Prompt library ─────────────────────────────────────
       Each of these reads the stored library, applies one pure change and
       writes the result back, returning the saved library so a caller can
       re-render from exactly what was persisted. */
    getReporterPromptLibrary: function () {
      return readPromptLibrary();
    },
    saveReporterPromptLibrary: function (library) {
      return writePromptLibrary(library);
    },
    addReporterPrompt: function (input) {
      var result = addPrompt(readPromptLibrary(), input);
      return { library: writePromptLibrary(result.library), id: result.id };
    },
    updateReporterPrompt: function (id, patch) {
      return writePromptLibrary(updatePrompt(readPromptLibrary(), id, patch));
    },
    removeReporterPrompt: function (id) {
      return writePromptLibrary(removePrompt(readPromptLibrary(), id));
    },
    duplicateReporterPrompt: function (id) {
      var result = duplicatePrompt(readPromptLibrary(), id);
      return { library: writePromptLibrary(result.library), id: result.id };
    },
    useReporterPrompt: function (id) {
      return writePromptLibrary(setActivePrompt(readPromptLibrary(), id));
    },
    resetReporterPromptById: function (id) {
      return writePromptLibrary(resetPrompt(readPromptLibrary(), id));
    },

    /* ── Per-desk accessors ─────────────────────────────────
       The shape the reporter page has always used. They now read through
       whichever prompt the desk is set to generate with. */
    getReporterPrompt: function (section) {
      return promptTextFor(readPromptLibrary(), section);
    },
    getReporterPromptOverride: function (section) {
      return promptOverrideFor(readPromptLibrary(), section);
    },
    setReporterPrompt: function (section, prompt) {
      var library = readPromptLibrary();
      var prompt_ = activePrompt(library, section);
      return writePromptLibrary(updatePrompt(library, prompt_ && prompt_.id, { text: prompt }));
    },
    resetReporterPrompt: function (section) {
      var library = readPromptLibrary();
      var prompt_ = activePrompt(library, section);
      return writePromptLibrary(resetPrompt(library, prompt_ && prompt_.id));
    },
  };

  if (typeof module === 'object' && module.exports) module.exports = AppSettings;
  if (typeof window !== 'undefined') window.AppSettings = AppSettings;
})();
