/* AppSettings — theme + reporter preferences, loaded in <head> of every page */
(function () {
  'use strict';

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

  function reporterPromptKey(section) {
    return 'reporterPrompt:' + (DEFAULT_REPORTER_PROMPTS[section] ? section : 'crypto');
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
    localStorage.setItem('theme', name);
  }

  function getTheme() {
    return localStorage.getItem('theme') || 'dark';
  }

  /* Apply immediately so there's no flash */
  applyTheme(getTheme());

  window.AppSettings = {
    THEMES: THEMES,
    DEFAULT_REPORTER_PROMPTS: DEFAULT_REPORTER_PROMPTS,
    applyTheme: applyTheme,
    getTheme: getTheme,
    getFrequency: function () {
      return parseInt(localStorage.getItem('reporterFreqHours') || '24', 10);
    },
    setFrequency: function (h) {
      localStorage.setItem('reporterFreqHours', String(h));
    },
    getReporterPrompt: function (section) {
      var key = reporterPromptKey(section);
      return localStorage.getItem(key) || DEFAULT_REPORTER_PROMPTS[section] || DEFAULT_REPORTER_PROMPTS.crypto;
    },
    getReporterPromptOverride: function (section) {
      return localStorage.getItem(reporterPromptKey(section)) || '';
    },
    setReporterPrompt: function (section, prompt) {
      localStorage.setItem(reporterPromptKey(section), String(prompt || '').trim());
    },
    resetReporterPrompt: function (section) {
      localStorage.removeItem(reporterPromptKey(section));
    },
  };
})();
