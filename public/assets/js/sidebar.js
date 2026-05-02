(function () {
  var workspace = [
    { href: '/',                              dot: true,  label: 'Overview'    },
    { href: '/market-intel.html',             icon: '📈', label: 'Markets'     },
    { href: '/crypto.html',                   icon: '₿',  label: 'Crypto'      },
    { href: '/market-intel.html#macro-indicators', icon: '🧭', label: 'Macro'  },
    { href: '/market-intel.html#news',        icon: '📰', label: 'News'        },
    { href: '/on-chain.html',                 icon: '🔗', label: 'On-Chain'    },
  ];
  var tools = [
    { href: '/market-intel.html#screeners',   icon: '📊', label: 'Screener'    },
    { href: '/crypto.html#sentiment',         icon: '🧠', label: 'Sentiment'   },
    { href: '/traditional.html',              icon: '🏦', label: 'Traditional' },
    { href: '/earthwatch.html',               icon: '🌍', label: 'Earth Watch' },
  ];

  function isActive(href) {
    var path = href.split('#')[0];
    var cur  = location.pathname;
    if (path === '/') return cur === '/';
    return cur === path || cur.startsWith(path);
  }

  function item(o) {
    var cls = 'cmd-nav-item' + (isActive(o.href) ? ' active' : '');
    var inner = o.dot
      ? '<span class="cmd-nav-dot"></span> ' + o.label
      : o.icon + ' ' + o.label;
    return '<a class="' + cls + '" href="' + o.href + '">' + inner + '</a>';
  }

  function build() {
    var el = document.querySelector('.cmd-sidebar');
    if (!el) return;
    el.innerHTML =
      '<a class="cmd-brand" href="/">'
      + '<div class="cmd-brand-mark">M</div>'
      + '<div class="cmd-brand-text"><h1>Market Command</h1><span>Live dashboard system</span></div>'
      + '</a>'
      + '<div class="cmd-nav-label">Workspace</div>'
      + workspace.map(item).join('')
      + '<div class="cmd-nav-label">Tools</div>'
      + tools.map(item).join('')
      + '<a class="cmd-sidebar-card" href="https://trading-strategy-production-1b41.up.railway.app/" target="_blank" rel="noopener">'
      + '<strong>🧠 Decision Engine ↗</strong>'
      + '<p>Trading framework, strategy rules, entry &amp; exit conditions.</p>'
      + '</a>';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
