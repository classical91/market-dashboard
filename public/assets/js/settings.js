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

  function applyTheme(name) {
    var theme = THEMES[name] || THEMES.dark;
    var root = document.documentElement;
    var vars = theme.vars;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        root.style.setProperty(k, vars[k]);
      }
    }
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
    applyTheme: applyTheme,
    getTheme: getTheme,
    getFrequency: function () {
      return parseInt(localStorage.getItem('reporterFreqHours') || '24', 10);
    },
    setFrequency: function (h) {
      localStorage.setItem('reporterFreqHours', String(h));
    },
  };
})();
