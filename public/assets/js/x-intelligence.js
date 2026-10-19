(function () {
  "use strict";

  /* The tracked accounts are no longer hard-coded here. They come from
     /api/x/accounts, which reads the persistent registry, so adding or
     deleting one takes effect without a redeploy.

     The list is flat, in the order the selected template lists its handles.
     It used to be grouped under headings taken from each template's sections;
     templates have no sections now, so the template itself is the only filter
     and its order is the only order. */

  // Bumped to :v2 to drop selections saved under the old default, where an
  // unset mode meant "first account" — devices that had never explicitly
  // chosen were stuck on a single handle's 8 posts.
  var localModeKey = "xIntelligence:lastMode:v2";
  var localRailKey = "xIntelligence:railCollapsed:v1";
  var localKey = "xIntelligence:lastHandle";
  // Bumped to :v4 for the timestamped schema. The v3 entries it replaces had
  // no saved-at time, so a browser could show them indefinitely with nothing
  // to say how old they were — they cannot be repaired in place, only
  // stranded, which is what the new key does. v3 is dropped on sight to
  // reclaim the space rather than leaving it to linger.
  var localFeedKey = "xIntelligence:feedCache:v5";
  var localTemplateKey = "xIntelligence:lastTemplate:v1";
  var legacyFeedKeys = ["xIntelligence:feedCache:v3"];
  var FEED_CACHE_TTL_MS = 45 * 60 * 1000;
  var ALL_MODE = "all";

  var renderPostCards = window.XPosts.renderPostCards;
  var renderFeedError = window.XPosts.renderFeedError;
  var renderStaleNotice = window.XPosts.renderStaleNotice;
  var renderFeedStatus = window.XPosts.renderFeedStatus;
  // Shared with the Node tests, so the page and the tests agree on what
  // the reader is told about freshness.
  var relativeTime = window.XFreshness.formatRelativeTime;
  var decideRefresh = window.XFreshness.decideRefresh;
  var computeStatus = window.XFreshness.describeStatus;

  /* Every card gets a Broadcast button, wired by x-broadcast.js. Guarded on
     the module being present so the page still renders if that script fails
     to load — a post you cannot broadcast beats a feed that does not draw. */
  // The argument order is deliberately flipped here: the renderer hands back
  // (post, button), and bindBroadcastButton takes the button first to match
  // bindCopyLinkButton next to it. Passing the function straight through is
  // what broke the button the first time.
  var cardOptions = window.XBroadcast
    ? {
      onBroadcast: function (post, button) {
        window.XBroadcast.bindBroadcastButton(button, post);
      },
      onFarmclaw: function (post, button) {
        window.XBroadcast.bindFarmclawButton(button, post);
      },
    }
    : null;

  /* Card state that belongs to this page session rather than the feed: posts
     the reader expanded, and which posts are NEW for the template on screen.
     Both survive re-renders; neither changes what the server reported. */
  var FeedView = window.XFeedView;
  var expandedPosts = {};
  var newPostKeys = {};
  cardOptions = cardOptions || {};
  cardOptions.keyOf = FeedView.postKey;
  cardOptions.expanded = expandedPosts;
  cardOptions.isNew = function (post) { return !!newPostKeys[FeedView.postKey(post)]; };

  function store() {
    try { return window.localStorage; } catch (err) { return null; }
  }

  function showPosts(root, posts, emptyText) {
    renderPostCards(root, posts, emptyText, cardOptions);
  }

  function dropLegacyCaches() {
    legacyFeedKeys.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (err) {}
    });
  }

  /* Returns the cached payload together with when it was saved and whether
     that has expired. The age travels with the data so nothing downstream can
     present it without knowing how old it is. */
  function templateCacheKey(templateId) {
    return localFeedKey + ":" + encodeURIComponent(templateId || "markets");
  }

  function readCachedFeed(templateId) {
    try {
      var parsed = JSON.parse(localStorage.getItem(templateCacheKey(templateId)) || "null");
      if (!parsed || !parsed.payload || !Array.isArray(parsed.payload.posts)) return null;
      var savedAt = Number(parsed.savedAt);
      if (!isFinite(savedAt) || savedAt <= 0) return null;
      return {
        payload: parsed.payload,
        savedAt: savedAt,
        savedAtIso: new Date(savedAt).toISOString(),
        expired: Date.now() - savedAt > FEED_CACHE_TTL_MS,
      };
    } catch (err) {
      return null;
    }
  }

  function writeCachedFeed(templateId, payload) {
    try {
      localStorage.setItem(templateCacheKey(templateId), JSON.stringify({ savedAt: Date.now(), payload: payload }));
    } catch (err) {}
  }

  function readLastTemplate() {
    try { return localStorage.getItem(localTemplateKey) || ""; } catch (err) { return ""; }
  }

  function writeLastTemplate(templateId) {
    try { localStorage.setItem(localTemplateKey, templateId); } catch (err) {}
  }

  function accountsOf(feedData) {
    return ((feedData && feedData.accounts) || []).map(function (account) {
      return { handle: account.handle, label: account.label, category: account.category };
    });
  }

  function readLastHandle() {
    try { return localStorage.getItem(localKey) || ""; } catch (err) { return ""; }
  }

  function writeLastHandle(handle) {
    try { localStorage.setItem(localKey, handle); } catch (err) {}
  }

  function readRailCollapsed() {
    try { return localStorage.getItem(localRailKey) === "1"; } catch (err) { return false; }
  }

  function writeRailCollapsed(collapsed) {
    try { localStorage.setItem(localRailKey, collapsed ? "1" : "0"); } catch (err) {}
  }

  function readLastMode() {
    try { return localStorage.getItem(localModeKey) || ""; } catch (err) { return ""; }
  }

  function writeLastMode(mode) {
    try { localStorage.setItem(localModeKey, mode); } catch (err) {}
  }

  /* Manage Accounts is not rendered here: it lives in the panel, outside this
     list, because the list collapses on mobile and add/remove has to stay
     reachable while it is folded away. */
  function renderList(root, accounts, activeMode, activeHandle, handlers) {
    root.innerHTML = "";

    var allCard = document.createElement("button");
    allCard.type = "button";
    allCard.className = "x-account-card x-account-card--all" + (activeMode === ALL_MODE ? " active" : "");
    allCard.innerHTML = '<span class="x-account-handle">&#127760; All Accounts</span>';
    allCard.addEventListener("click", handlers.onSelectAll);
    root.appendChild(allCard);

    if (!accounts.length) {
      var empty = document.createElement("div");
      empty.className = "x-account-empty";
      empty.textContent = handlers.loaded ? "No accounts in this theme." : "Loading accounts\u2026";
      root.appendChild(empty);
      return;
    }

    accounts.forEach(function (account) {
      var handle = account.handle;
      var card = document.createElement("button");
      card.type = "button";
      card.className = "x-account-card" + (activeMode !== ALL_MODE && handle === activeHandle ? " active" : "");
      card.innerHTML =
        '<span class="x-account-handle">@' + handle + "</span>" +
        '<a class="x-account-open" href="https://x.com/' + handle + '" target="_blank" rel="noopener">Open &#8599;</a>';
      card.addEventListener("click", function (e) {
        if (e.target && e.target.classList.contains("x-account-open")) return;
        handlers.onSelect(handle);
      });
      root.appendChild(card);
    });
  }

  /* Resolves to {ok:true, data} or {ok:false, reason}. It must never turn a
     failure into an empty-but-successful feed: that is what made an outage
     indistinguishable from "no posts today", and left last week's posts on
     screen looking current. */
  function loadAccountsFeed(templateId) {
    return fetch("/api/x/accounts?template=" + encodeURIComponent(templateId || "markets"), { headers: { Accept: "application/json" } }).then(
      function (res) {
        if (!res.ok) {
          return { ok: false, reason: "The dashboard server returned " + res.status };
        }
        return res.json().then(
          function (data) {
            if (!data || !Array.isArray(data.posts) || !Array.isArray(data.accounts)) {
              return { ok: false, reason: "The feed response was malformed" };
            }
            return { ok: true, data: data };
          },
          function () {
            return { ok: false, reason: "The feed response could not be parsed" };
          }
        );
      },
      function () {
        return { ok: false, reason: "Couldn't reach the dashboard server" };
      }
    );
  }

  function loadTemplates() {
    return fetch("/api/x/templates", { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("Could not load X templates");
      return res.json();
    });
  }

  function start(templatePayload) {
    var listRoot = document.getElementById("xAccountList");
    var pane = document.getElementById("xTimelinePane");
    var paneLabel = document.getElementById("xTimelineLabel");
    var paneLink = document.getElementById("xTimelineLink");
    var panel = document.getElementById("xAccountPanel");
    var panelToggle = document.getElementById("xAccountToggle");
    var panelToggleLabel = document.getElementById("xAccountToggleLabel");
    var templateTrigger = document.getElementById("xTemplateTrigger");
    var templateTriggerLabel = document.getElementById("xTemplateTriggerLabel");
    var templateMenu = document.getElementById("xTemplateMenu");
    var templateDescription = document.getElementById("xTemplateDescription");
    if (!listRoot || !pane) return;

    // Mobile only (CSS hides the toggle above 980px): the account list starts
    // collapsed so the page opens on the posts, and folds itself away again
    // once a selection is made.
    function setPanelOpen(open) {
      if (!panel) return;
      if (open) panel.classList.remove("is-collapsed");
      else panel.classList.add("is-collapsed");
      if (panelToggle) panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function visibleAccountCount() {
      if (state.mode === ALL_MODE) return accountsOf(state.feedData).length;
      return state.handle ? 1 : 0;
    }

    // Reads e.g. "Accounts · All Accounts (13)". This is an account selector,
    // so its count describes the selected theme's accounts, not its posts.
    function syncPanelLabel() {
      if (!panelToggleLabel) return;
      var selection = state.mode === ALL_MODE ? "All Accounts" : "@" + state.handle;
      panelToggleLabel.textContent =
        "Accounts · " + selection + (state.loaded ? " (" + visibleAccountCount() + ")" : "");
    }

    if (panelToggle && panel) {
      panelToggle.addEventListener("click", function () {
        setPanelOpen(panel.classList.contains("is-collapsed"));
      });
    }

    // Desktop only (CSS hides the rail toggle at 980px and below): folds the
    // account panel into a narrow rail so the feed widens to three columns.
    var split = panel ? panel.parentNode : null;
    var railToggle = document.getElementById("xAccountRailToggle");
    function setRailCollapsed(collapsed) {
      if (!split || !railToggle) return;
      split.classList.toggle("is-rail-collapsed", collapsed);
      railToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = collapsed ? "Expand accounts" : "Collapse accounts";
      railToggle.setAttribute("aria-label", label);
      railToggle.title = label;
      railToggle.firstElementChild.innerHTML = collapsed ? "&#171;" : "&#187;";
    }
    if (railToggle) {
      setRailCollapsed(readRailCollapsed());
      railToggle.addEventListener("click", function () {
        var collapsed = !split.classList.contains("is-rail-collapsed");
        setRailCollapsed(collapsed);
        writeRailCollapsed(collapsed);
      });
    }

    // Static markup rather than part of the list render: the list is hidden
    // whenever the panel is collapsed, which on mobile is its default state.
    var manageButton = document.getElementById("xManageAccounts");
    if (manageButton) manageButton.addEventListener("click", openManager);

    var liveRoot = document.getElementById("xLiveReference");
    var templates = (templatePayload && templatePayload.templates) || [];
    var defaultTemplateId = (templatePayload && templatePayload.defaultTemplateId) || "markets";
    var queryTemplate = "";
    try { queryTemplate = new URL(window.location.href).searchParams.get("template") || ""; } catch (err) {}
    var rememberedTemplate = readLastTemplate();
    var initialTemplateId = [queryTemplate, rememberedTemplate, defaultTemplateId].find(function (id) {
      return templates.some(function (template) { return template.id === id; });
    }) || defaultTemplateId;
    var lastMode = readLastMode();
    dropLegacyCaches();
    var cached = readCachedFeed(initialTemplateId);
    var seedAccounts = accountsOf(cached ? cached.payload : null);
    var lastHandle = readLastHandle();
    var validLast = seedAccounts.some(function (a) { return a.handle === lastHandle; });
    var state = {
      // Default to the full feed; a single account only shows its own posts.
      mode: lastMode === "account" ? "account" : ALL_MODE,
      // May be "" until the first payload names the tracked accounts.
      handle: validLast ? lastHandle : (seedAccounts[0] ? seedAccounts[0].handle : ""),
      feedData: cached ? cached.payload : { posts: [], accounts: [], failedFeeds: [] },
      // Set while what is on screen came out of the browser cache rather than
      // this page load's fetch; cleared as soon as the server answers.
      cache: cached,
      transport: { ok: true },
      loaded: !!cached,
      templates: templates,
      templateId: initialTemplateId,
      filters: FeedView.readFilters(store(), initialTemplateId),
      view: FeedView.readView(store()),
    };

    function activeTemplate() {
      return state.templates.find(function (template) { return template.id === state.templateId; }) || state.templates[0] || {
        id: state.templateId, name: state.templateId, description: "", accent: "market",
      };
    }

    function setTemplateMenuOpen(open) {
      if (!templateMenu || !templateTrigger) return;
      templateMenu.hidden = !open;
      templateTrigger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function renderTemplateSwitcher() {
      var current = activeTemplate();
      if (templateTriggerLabel) templateTriggerLabel.textContent = current.name;
      if (templateDescription) templateDescription.textContent = current.description || "Curated X intelligence workspace";
      document.body.setAttribute("data-x-accent", current.accent || "market");
      if (window.XIntelligencePatterns) window.XIntelligencePatterns.apply(document.body, current);
      if (!templateMenu) return;
      templateMenu.innerHTML = "";
      state.templates.forEach(function (template) {
        var option = document.createElement("button");
        option.type = "button";
        option.className = "x-template-option" + (template.id === state.templateId ? " active" : "");
        option.innerHTML = '<span class="x-template-option-name"></span><span class="x-template-option-count"></span>';
        option.firstChild.textContent = template.name;
        option.lastChild.textContent = (template.handles || []).length + " accounts";
        option.addEventListener("click", function () { selectTemplate(template.id); });
        templateMenu.appendChild(option);
      });
      var divider = document.createElement("div");
      divider.className = "x-template-menu-divider";
      templateMenu.appendChild(divider);
      [["+ New Template", true], ["Manage Templates", false]].forEach(function (entry) {
        var action = document.createElement("button");
        action.type = "button";
        action.className = "x-template-menu-action";
        action.textContent = entry[0];
        action.addEventListener("click", function () {
          setTemplateMenuOpen(false);
          openTemplateManager(entry[1]);
        });
        templateMenu.appendChild(action);
      });
    }

    function openTemplateManager(createNew) {
      window.XTemplatesAdmin.open({
        activeTemplateId: state.templateId,
        createNew: createNew,
        onChange: function (nextTemplates, selectedId) {
          state.templates = nextTemplates || state.templates;
          renderTemplateSwitcher();
          if (selectedId && selectedId !== state.templateId && state.templates.some(function (template) { return template.id === selectedId; })) {
            selectTemplate(selectedId);
          } else if (!state.templates.some(function (template) { return template.id === state.templateId; })) {
            selectTemplate(defaultTemplateId);
          } else {
            refresh();
          }
        },
      });
    }

    function selectTemplate(templateId) {
      if (!state.templates.some(function (template) { return template.id === templateId; })) return;
      state.templateId = templateId;
      writeLastTemplate(templateId);
      try {
        var url = new URL(window.location.href);
        url.searchParams.set("template", templateId);
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      } catch (err) {}
      var nextCache = readCachedFeed(templateId);
      state.cache = nextCache;
      state.feedData = nextCache ? nextCache.payload : { posts: [], accounts: [], failedFeeds: [], staleFeeds: [] };
      state.loaded = !!nextCache;
      state.mode = ALL_MODE;
      state.transport = { ok: true };
      state.serverOutage = null;
      // Time and media filters are remembered per template; the search box
      // carries over, since it is what the reader is looking for right now.
      var query = state.filters.query;
      state.filters = FeedView.readFilters(store(), templateId);
      state.filters.query = query;
      markNewPosts(templateId, state.feedData.posts, false);
      selectAll();
      renderTemplateSwitcher();
      refresh();
    }

    if (templateTrigger && templateMenu) {
      templateTrigger.addEventListener("click", function (event) {
        event.stopPropagation();
        setTemplateMenuOpen(templateMenu.hidden);
      });
      document.addEventListener("click", function (event) {
        if (!event.target.closest || !event.target.closest("#xTemplateSwitcher")) setTemplateMenuOpen(false);
      });
    }

    /* Re-rendering replaces every card, which can jump the page. The reader's
       place is put back afterwards, so a refresh or a filter change does not
       throw them to the top of the feed. */
    function renderPane() {
      var x = window.pageXOffset;
      var y = window.pageYOffset;
      renderPaneContent();
      syncToolbar();
      layoutMasonry();
      scheduleMasonry();
      if (window.pageYOffset !== y || window.pageXOffset !== x) window.scrollTo(x, y);
    }

    /* Order-preserving masonry for the multi-column views. Each card spans as
       many 4px grid rows as it is tall, and the grid's ordinary (sparse,
       never `dense`) auto-placement does the rest: a card always lands at or
       below the top of the card before it, so the newest-first order still
       reads top to bottom, and DOM, tab and screen-reader order are
       untouched. Without JavaScript, or in Focus view, the grid falls back to
       plain rows of top-aligned cards. */
    var MASONRY_ROW_PX = 4;
    var masonryFrame = 0;

    function layoutMasonry() {
      var grid = pane.querySelector(".x-post-grid");
      if (!grid) return;
      var cards = grid.querySelectorAll(".x-post-card");
      grid.classList.remove("is-masonry");
      var columns = window.getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      var on = state.view !== "focus" && columns > 1 && cards.length > 1;
      if (!on) {
        Array.prototype.forEach.call(cards, function (card) { card.style.gridRowEnd = ""; });
        return;
      }
      var gap = parseFloat(window.getComputedStyle(grid).rowGap) || 0;
      grid.classList.add("is-masonry");
      // Every read before any write, so the browser lays out once.
      var heights = Array.prototype.map.call(cards, function (card) { return card.getBoundingClientRect().height; });
      Array.prototype.forEach.call(cards, function (card, i) {
        card.style.gridRowEnd = "span " + Math.max(1, Math.ceil((heights[i] + gap) / MASONRY_ROW_PX));
      });
    }

    // After the renderer's own post-layout pass (which may hide Read more).
    function scheduleMasonry() {
      if (!window.requestAnimationFrame) return;
      if (masonryFrame) window.cancelAnimationFrame(masonryFrame);
      masonryFrame = window.requestAnimationFrame(function () {
        masonryFrame = 0;
        layoutMasonry();
      });
    }

    pane.addEventListener("click", function (event) {
      if (event.target.closest && event.target.closest(".x-post-expand")) scheduleMasonry();
    });
    // A dead image is removed from its card, which shortens it.
    pane.addEventListener("error", scheduleMasonry, true);
    if (window.ResizeObserver) {
      var lastWidth = 0;
      new window.ResizeObserver(function (entries) {
        var width = Math.round(entries[0].contentRect.width);
        if (width === lastWidth) return;
        lastWidth = width;
        scheduleMasonry();
      }).observe(pane);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMasonry);

    var FILTERED_EMPTY = "No loaded posts match these filters.";

    // The posts on screen after the toolbar's filters. `shownCount` and
    // `loadedCount` feed the summary line.
    function applyFilters(posts) {
      var shown = FeedView.filterPosts(posts, state.filters);
      state.loadedCount = posts.length;
      state.shownCount = shown.length;
      return shown;
    }

    function renderPaneContent() {
      syncPanelLabel();
      state.loadedCount = 0;
      state.shownCount = 0;
      if (!state.loaded) {
        showPosts(pane, [], "Loading latest posts…");
        return;
      }
      if (state.mode === ALL_MODE) {
        // A theme with no accounts in it yet is the normal state of a newly
        // installed one, not a failed fetch. Saying "no posts" there reads as
        // an outage and hides the one thing that would fix it.
        // The server-resolved account list, not the template's own membership
        // count: it is what the feed actually ran against, so it stays right
        // when a membership points at an account that no longer exists.
        var unpopulated = state.transport.ok && !(state.feedData.accounts || []).length;
        var shownAll = applyFilters(state.feedData.posts);
        showPosts(
          pane,
          shownAll,
          state.feedData.posts.length && !shownAll.length
            ? FILTERED_EMPTY
            : unpopulated
              ? "No accounts in this theme yet \u2014 add some from Manage Accounts."
              : state.transport.ok ? "No posts found yet." : "Couldn't load posts."
        );
        renderFeedError(pane, state.feedData.failedFeeds);
        renderStaleNotice(pane, state.feedData.staleFeeds);
        renderFeedStatus(pane, computeStatus(state, null));
        return;
      }
      var handlePosts = state.feedData.posts.filter(function (p) { return p.handle === state.handle; });
      var failed = (state.feedData.failedFeeds || []).some(function (a) { return a.handle === state.handle; });
      var stale = (state.feedData.staleFeeds || []).filter(function (a) { return a.handle === state.handle; });
      var shownHandle = applyFilters(handlePosts);
      showPosts(
        pane,
        shownHandle,
        handlePosts.length && !shownHandle.length
          ? FILTERED_EMPTY
          : failed || !state.transport.ok
          ? "Couldn't load current posts for @" + state.handle + " right now."
          : "No recent posts found for @" + state.handle + "."
      );
      renderStaleNotice(pane, stale);
      renderFeedStatus(pane, computeStatus(state, state.handle));
    }

    function refreshList() {
      renderList(listRoot, accountsOf(state.feedData), state.mode, state.handle, {
        loaded: state.loaded,
        onSelectAll: selectAll,
        onSelect: selectHandle,
      });
    }

    /* The Live X Reference is what X itself currently shows, next to what our
       ingestion captured. Rendered only in single-account mode, and pointed at
       the newly selected handle on every switch rather than re-injecting the
       widget script. */
    function renderLiveReference() {
      if (!liveRoot) return;
      if (state.mode === ALL_MODE || !state.handle) {
        liveRoot.hidden = true;
        liveRoot.innerHTML = "";
        liveRoot.removeAttribute("data-handle");
        return;
      }
      liveRoot.hidden = false;
      var meta = window.XFreshness.accountMeta(state.feedData, state.handle) || {};
      window.XLiveReference.render(liveRoot, state.handle, meta);
      // Keep the live X timeline in the same reading flow as the freshness
      // banner: LIVE first, X's timeline second, captured post cards after it.
      // showPosts clears the pane on refresh, so reinsert this node each
      // time instead of maintaining a separate side column.
      pane.insertBefore(liveRoot, pane.firstChild ? pane.firstChild.nextSibling : null);
    }

    /* The panel is scoped to the theme on screen, so the active template goes
       with it. Without it the panel edited the global tracked list blind and
       every add landed in the default theme, whichever filter was selected. */
    function openManager() {
      window.XAccountsAdmin.open({
        template: activeTemplate(),
        onChange: function (accounts, change) {
          // Membership may have changed, so the switcher's per-theme counts
          // and this page's copy of the template are both stale.
          if (change && change.template) {
            state.templates = state.templates.map(function (template) {
              return template.id === change.template.id ? change.template : template;
            });
            renderTemplateSwitcher();
          }
          // The selected account may have just been deleted; fall back to the
          // full feed rather than leaving a selection nothing can fill.
          var stillTracked = (accounts || []).some(function (a) { return a.handle === state.handle; });
          if (!stillTracked) {
            state.handle = accounts && accounts[0] ? accounts[0].handle : "";
            if (state.mode !== ALL_MODE) selectAll();
          }
          if (change) refresh();
        },
      });
    }

    function selectAll() {
      state.mode = ALL_MODE;
      writeLastMode(ALL_MODE);
      if (paneLabel) paneLabel.textContent = "All Accounts";
      if (paneLink) paneLink.href = "https://x.com/";
      setPanelOpen(false);
      renderPane();
      refreshList();
      renderLiveReference();
    }

    function selectHandle(handle) {
      state.mode = "account";
      state.handle = handle;
      writeLastMode("account");
      writeLastHandle(handle);
      if (paneLabel) paneLabel.textContent = "@" + handle;
      if (paneLink) paneLink.href = "https://x.com/" + handle;
      setPanelOpen(false);
      renderPane();
      refreshList();
      renderLiveReference();
    }

    /* ── New-post awareness ──────────────────────────────────────────────
       "New" means a post identifier this device had not been shown for the
       template before this page load — never "the refresh succeeded". The
       baseline is read once per template per page load, so flags stay put
       across re-renders until the reader marks them seen. A template this
       device has never shown has no baseline and flags nothing. */
    var seenBaselines = {};

    function markNewPosts(templateId, posts, authoritative) {
      var storage = store();
      if (!Object.prototype.hasOwnProperty.call(seenBaselines, templateId)) {
        seenBaselines[templateId] = FeedView.readSeen(storage, templateId);
      }
      newPostKeys = FeedView.findNewPosts(seenBaselines[templateId], posts || []);
      // Only what the server just returned is recorded as shown. Browser-cached
      // posts were recorded when they were first fetched.
      if (authoritative) {
        FeedView.writeSeen(storage, templateId, FeedView.mergeSeen(FeedView.readSeen(storage, templateId), posts || []));
      }
    }

    function markAllSeen() {
      seenBaselines[state.templateId] = FeedView.mergeSeen(FeedView.readSeen(store(), state.templateId), state.feedData.posts);
      newPostKeys = {};
      renderPane();
    }

    /* ── Toolbar ─────────────────────────────────────────────────────────── */
    var searchInput = document.getElementById("xFeedSearch");
    var accountSelect = document.getElementById("xFeedAccount");
    var timeGroup = document.getElementById("xFeedTime");
    var mediaButton = document.getElementById("xFeedMedia");
    var viewGroup = document.getElementById("xFeedView");
    var motionButton = document.getElementById("xFeedMotion");
    var resetButton = document.getElementById("xFeedReset");
    var summary = document.getElementById("xFeedSummary");
    var reducedMotionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

    function setPressed(group, attrName, value) {
      if (!group) return;
      Array.prototype.forEach.call(group.querySelectorAll("button[" + attrName + "]"), function (button) {
        button.setAttribute("aria-pressed", button.getAttribute(attrName) === value ? "true" : "false");
      });
    }

    function syncAccountSelect() {
      if (!accountSelect) return;
      var accounts = accountsOf(state.feedData);
      var wanted = state.mode === ALL_MODE ? "" : state.handle;
      var signature = accounts.map(function (a) { return a.handle; }).join(",");
      if (accountSelect.getAttribute("data-accounts") !== signature) {
        accountSelect.innerHTML = "";
        var all = document.createElement("option");
        all.value = "";
        all.textContent = "All accounts";
        accountSelect.appendChild(all);
        accounts.forEach(function (account) {
          var option = document.createElement("option");
          option.value = account.handle;
          option.textContent = "@" + account.handle;
          accountSelect.appendChild(option);
        });
        accountSelect.setAttribute("data-accounts", signature);
      }
      accountSelect.value = accounts.some(function (a) { return a.handle === wanted; }) ? wanted : "";
    }

    function renderSummary() {
      if (!summary) return;
      summary.innerHTML = "";
      if (!state.loaded) return;
      var parts = document.createElement("span");
      var filtered = state.shownCount !== state.loadedCount;
      parts.textContent = filtered
        ? "Showing " + state.shownCount + " of " + state.loadedCount + " loaded posts"
        : state.loadedCount + (state.loadedCount === 1 ? " post" : " posts");
      summary.appendChild(parts);
      var fresh = FeedView.countKeys(newPostKeys);
      if (fresh) {
        var badge = document.createElement("span");
        badge.className = "x-feed-new-count";
        badge.textContent = fresh + " new since your last visit";
        summary.appendChild(badge);
        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "x-feed-mark-seen";
        clear.textContent = "Mark seen";
        clear.addEventListener("click", markAllSeen);
        summary.appendChild(clear);
      }
    }

    function syncToolbar() {
      if (searchInput && searchInput.value !== state.filters.query) searchInput.value = state.filters.query;
      syncAccountSelect();
      setPressed(timeGroup, "data-time", state.filters.time);
      if (mediaButton) mediaButton.setAttribute("aria-pressed", state.filters.media ? "true" : "false");
      setPressed(viewGroup, "data-view", state.view);
      pane.setAttribute("data-x-view", state.view);
      if (resetButton) resetButton.disabled = FeedView.isDefaultFilters(state.filters) && state.mode === ALL_MODE;
      renderSummary();
    }

    function setFilters(patch) {
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state.filters[k] = patch[k];
      FeedView.writeFilters(store(), state.templateId, state.filters);
      renderPane();
    }

    var searchTimer = null;
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { setFilters({ query: searchInput.value }); }, 140);
      });
      searchInput.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && searchInput.value) {
          searchInput.value = "";
          setFilters({ query: "" });
        }
      });
    }
    if (accountSelect) {
      accountSelect.addEventListener("change", function () {
        if (accountSelect.value) selectHandle(accountSelect.value);
        else selectAll();
      });
    }
    if (timeGroup) {
      timeGroup.addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest("button[data-time]");
        if (button) setFilters({ time: button.getAttribute("data-time") });
      });
    }
    if (mediaButton) mediaButton.addEventListener("click", function () { setFilters({ media: !state.filters.media }); });
    if (viewGroup) {
      viewGroup.addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest("button[data-view]");
        if (!button) return;
        state.view = FeedView.normalizeView(button.getAttribute("data-view"));
        FeedView.writeView(store(), state.view);
        renderPane();
      });
    }
    if (resetButton) {
      resetButton.addEventListener("click", function () {
        state.filters = FeedView.defaultFilters();
        FeedView.writeFilters(store(), state.templateId, state.filters);
        if (state.mode !== ALL_MODE) selectAll(); else renderPane();
      });
    }

    /* Background motion: the reader's explicit choice, else the OS setting.
       Paused while the tab is hidden, when nobody can see it anyway. */
    function applyMotion() {
      var stored = null;
      try { stored = store() && store().getItem(FeedView.KEYS.motion); } catch (err) {}
      var motion = FeedView.resolveMotion(stored, !!(reducedMotionQuery && reducedMotionQuery.matches));
      document.body.setAttribute("data-x-motion", motion);
      if (motionButton) {
        motionButton.setAttribute("aria-pressed", motion === "on" ? "true" : "false");
        motionButton.textContent = "Motion: " + (motion === "on" ? "On" : "Off");
      }
    }
    if (motionButton) {
      motionButton.addEventListener("click", function () {
        FeedView.writeMotion(store(), document.body.getAttribute("data-x-motion") === "on" ? "off" : "on");
        applyMotion();
      });
    }
    if (reducedMotionQuery && reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener("change", applyMotion);
    document.addEventListener("visibilitychange", function () {
      document.body.toggleAttribute("data-x-motion-paused", document.hidden);
    });
    applyMotion();

    /* Focus view reads one post at a time: j / k step between cards without
       reaching for the mouse. The arrow keys are left to scroll the page. */
    document.addEventListener("keydown", function (event) {
      if (state.view !== "focus" || event.altKey || event.ctrlKey || event.metaKey) return;
      var tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (event.target && event.target.isContentEditable)) return;
      if (document.querySelector(".manage-overlay, .x-live-modal")) return;
      var step = event.key === "j" ? 1 : event.key === "k" ? -1 : 0;
      if (!step) return;
      var cards = Array.prototype.slice.call(pane.querySelectorAll(".x-post-card"));
      if (!cards.length) return;
      var current = cards.findIndex(function (card) { return card.contains(document.activeElement); });
      if (current < 0) {
        current = cards.findIndex(function (card) { return card.getBoundingClientRect().bottom > 80; });
        current = current < 0 ? 0 : current - (step > 0 ? 1 : 0);
      }
      var next = cards[Math.max(0, Math.min(cards.length - 1, current + step))];
      event.preventDefault();
      next.setAttribute("tabindex", "-1");
      next.focus({ preventScroll: true });
      var smooth = document.body.getAttribute("data-x-motion") === "on";
      next.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    });

    markNewPosts(state.templateId, state.feedData.posts, false);
    refreshList();
    renderTemplateSwitcher();
    if (state.mode === ALL_MODE || !state.handle) selectAll(); else selectHandle(state.handle);

    /* Re-reads the selection against the accounts the server just reported.
       An account deleted from another device disappears here too, rather than
       leaving a selected handle the feed can never fill. */
    function reconcileSelection() {
      var accounts = accountsOf(state.feedData);
      if (!accounts.length) return;
      var stillTracked = accounts.some(function (a) { return a.handle === state.handle; });
      if (stillTracked) return;
      state.handle = accounts[0].handle;
      if (state.mode !== ALL_MODE) selectAll();
    }

    function refresh() {
      return loadAccountsFeed(state.templateId).then(function (result) {
      state.loaded = true;

      if (result.ok) {
        var data = result.data;
        var payload = {
          status: data.status,
          generatedAt: data.generatedAt,
          lastCheckedAt: data.lastCheckedAt,
          mostRecentSuccessfulFetchAt: data.mostRecentSuccessfulFetchAt,
          oldestSuccessfulFetchAt: data.oldestSuccessfulFetchAt,
          newestPostAt: data.newestPostAt,
          counts: data.counts || {},
          posts: data.posts,
          accounts: data.accounts,
          failedFeeds: data.failedFeeds || [],
          staleFeeds: data.staleFeeds || [],
          template: data.template || activeTemplate(),
        };

        // The outage the server can still answer through: every provider is
        // down, so this 200 carries no posts. Replacing on it would delete
        // the last-known-good history and overwrite the stored cache with the
        // empty response — losing the data at the exact moment it is the only
        // thing left. Hold what we have and say why.
        if (decideRefresh(state.cache, payload).action === "preserve") {
          state.transport = { ok: true };
          state.serverOutage = payload;
          renderPane();
          return;
        }

        // Otherwise the server is authoritative about freshness and replaces
        // what is on screen — post count is not evidence either way.
        state.feedData = payload;
        state.transport = { ok: true };
        state.serverOutage = null;
        state.cache = null;
        writeCachedFeed(state.templateId, payload);
        markNewPosts(state.templateId, payload.posts, true);
        reconcileSelection();
        renderPane();
        refreshList();
        renderLiveReference();
        return;
      }

      // A transport failure stays a failure. Anything still on screen came
      // out of the browser cache and gets labelled as such, with its age.
      state.transport = { ok: false, reason: result.reason };
      renderPane();
      });
    }

    refresh();
  }

  function init() {
    loadTemplates().then(start).catch(function () {
      start({
        defaultTemplateId: "markets",
        templates: [{ id: "markets", name: "Crypto & Stocks", description: "Crypto, stocks, macro and technical analysis", accent: "market", handles: [] }],
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
