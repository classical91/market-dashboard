(function () {
  var workspace = [
    { href: '/',                                   dot: true,  label: 'Overview'    },
    { href: '/market-intel.html',                  icon: '📈', label: 'Markets'     },
    { href: '/crypto.html',                        icon: '₿',  label: 'Crypto'      },
    { href: '/market-intel.html#macro-indicators', icon: '🧭', label: 'Macro'       },
    { href: '/market-intel.html#news',             icon: '📰', label: 'News'        },
    { href: '/on-chain.html',                      icon: '🔗', label: 'On-Chain'    },
  ];
  var tools = [
    { href: '/market-intel.html#screeners', icon: '📊', label: 'Screener'    },
    { href: '/crypto.html#sentiment',       icon: '🧠', label: 'Sentiment'   },
    { href: '/traditional.html',            icon: '🏦', label: 'Traditional' },
    { href: '/earthwatch.html',             icon: '🌍', label: 'Earth Watch' },
  ];

  function isActive(href) {
    var path = href.split('#')[0];
    var cur  = location.pathname;
    if (path === '/') return cur === '/';
    return cur === path || cur.startsWith(path);
  }

  function item(o) {
    var cls   = 'cmd-nav-item' + (isActive(o.href) ? ' active' : '');
    var inner = o.dot
      ? '<span class="cmd-nav-dot"></span> ' + o.label
      : o.icon + ' ' + o.label;
    return '<a class="' + cls + '" href="' + o.href + '">' + inner + '</a>';
  }

  var navHtml =
    '<a class="cmd-brand" href="/">'
    + '<div class="cmd-brand-mark">M</div>'
    + '<div class="cmd-brand-text"><h1>Market Command</h1><span>Live dashboard system</span></div>'
    + '</a>'
    + '<div class="cmd-nav-label">Workspace</div>'
    + workspace.map(item).join('')
    + '<div class="cmd-nav-label">Tools</div>'
    + tools.map(item).join('')
    + '<a class="cmd-sidebar-card" href="https://trading-strategy-production-1b41.up.railway.app/"'
    + ' target="_blank" rel="noopener">'
    + '<strong>🧠 Decision Engine ↗</strong>'
    + '<p>Trading framework, strategy rules, entry &amp; exit conditions.</p>'
    + '</a>';

  function openDrawer() {
    var d = document.getElementById('cmd-drawer');
    var o = document.getElementById('cmd-overlay');
    if (d) d.classList.add('open');
    if (o) o.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    var d = document.getElementById('cmd-drawer');
    var o = document.getElementById('cmd-overlay');
    if (d) d.classList.remove('open');
    if (o) o.classList.remove('open');
    document.body.style.overflow = '';
  }

  function build() {
    /* Desktop sidebar */
    var sidebar = document.querySelector('.cmd-sidebar');
    if (sidebar) sidebar.innerHTML = navHtml;

    /* Mobile top bar — prepend to .cmd-main */
    var main = document.querySelector('.cmd-main');
    if (main && !document.getElementById('cmd-mobile-bar')) {
      var bar = document.createElement('div');
      bar.className = 'cmd-mobile-bar';
      bar.id = 'cmd-mobile-bar';
      bar.innerHTML =
        '<a class="cmd-mobile-brand" href="/">'
        + '<div class="cmd-mobile-brand-mark">M</div>'
        + '<span class="cmd-mobile-brand-name">Market Command</span>'
        + '</a>'
        + '<button class="cmd-hamburger" id="cmd-hamburger" aria-label="Open navigation">&#9776;</button>';
      main.insertBefore(bar, main.firstChild);
    }

    /* Dark overlay */
    if (!document.getElementById('cmd-overlay')) {
      var overlay = document.createElement('div');
      overlay.className = 'cmd-overlay';
      overlay.id = 'cmd-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', closeDrawer);
    }

    /* Slide-out drawer (same nav content as sidebar) */
    if (!document.getElementById('cmd-drawer')) {
      var drawer = document.createElement('div');
      drawer.className = 'cmd-drawer';
      drawer.id = 'cmd-drawer';
      drawer.innerHTML = navHtml;
      document.body.appendChild(drawer);
    }

    /* Hamburger toggle */
    var ham = document.getElementById('cmd-hamburger');
    if (ham) ham.addEventListener('click', openDrawer);

    /* Close on Escape */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
