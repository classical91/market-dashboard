(function () {
  "use strict";

  /* The tracked accounts are no longer hard-coded here. They come from
     /api/x/accounts, which reads the persistent registry, so adding or
     deleting one takes effect without a redeploy. Sections are derived from
     the categories the API returns, in the order it returns them. */
  function groupAccounts(accounts) {
    var order = [];
    var byCategory = {};
    (accounts || []).forEach(function (account) {
      var category = account.category || "Other";
      if (!byCategory[category]) {
        byCategory[category] = [];
        order.push(category);
      }
      byCategory[category].push(account);
    });
    return order.map(function (category) {
      return { label: category, accounts: byCategory[category] };
    });
  }

  // Bumped to :v2 to drop selections saved under the old default, where an
  // unset mode meant "first account" — devices that had never explicitly
  // chosen were stuck on a single handle's 8 posts.
  var localModeKey = "xIntelligence:lastMode:v2";
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

  function readLastMode() {
    try { return localStorage.getItem(localModeKey) || ""; } catch (err) { return ""; }
  }

  function writeLastMode(mode) {
    try { localStorage.setItem(localModeKey, mode); } catch (err) {}
  }

  /* Manage Accounts is not rendered here: it lives in the panel, outside this
     list, because the list collapses on mobile and add/remove has to stay
     reachable while it is folded away. */
  function renderList(root, groups, activeMode, activeHandle, handlers) {
    root.innerHTML = "";

    var allCard = document.createElement("button");
    allCard.type = "button";
    allCard.className = "x-account-card x-account-card--all" + (activeMode === ALL_MODE ? " active" : "");
    allCard.innerHTML = '<span class="x-account-handle">&#127760; All Accounts</span>';
    allCard.addEventListener("click", handlers.onSelectAll);
    root.appendChild(allCard);

    if (!groups.length) {
      var empty = document.createElement("div");
      empty.className = "x-account-group-title";
      empty.textContent = handlers.loaded ? "No accounts assigned." : "Loading accounts\u2026";
      root.appendChild(empty);
      return;
    }

    groups.forEach(function (group) {
      var heading = document.createElement("div");
      heading.className = "x-account-group-title";
      heading.textContent = group.label;
      root.appendChild(heading);

      group.accounts.forEach(function (account) {
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

    function visiblePostCount() {
      var posts = state.feedData.posts || [];
      if (state.mode === ALL_MODE) return posts.length;
      return posts.filter(function (p) { return p.handle === state.handle; }).length;
    }

    // Reads e.g. "Accounts · All Accounts (147)" — the count makes it obvious
    // that a single handle is a much smaller slice than the full feed.
    function syncPanelLabel() {
      if (!panelToggleLabel) return;
      var selection = state.mode === ALL_MODE ? "All Accounts" : "@" + state.handle;
      panelToggleLabel.textContent =
        "Accounts · " + selection + (state.loaded ? " (" + visiblePostCount() + ")" : "");
    }

    if (panelToggle && panel) {
      panelToggle.addEventListener("click", function () {
        setPanelOpen(panel.classList.contains("is-collapsed"));
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
      if (!templateMenu) return;
      templateMenu.innerHTML = "";
      state.templates.forEach(function (template) {
        var option = document.createElement("button");
        option.type = "button";
        option.className = "x-template-option" + (template.id === state.templateId ? " active" : "");
        option.innerHTML = '<span class="x-template-option-name"></span><span class="x-template-option-count"></span>';
        option.firstChild.textContent = template.name;
        option.lastChild.textContent = (template.memberships || []).length + " accounts";
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

    function renderPane() {
      syncPanelLabel();
      if (!state.loaded) {
        renderPostCards(pane, [], "Loading latest posts…");
        return;
      }
      if (state.mode === ALL_MODE) {
        renderPostCards(
          pane,
          state.feedData.posts,
          state.transport.ok ? "No posts found yet." : "Couldn't load posts."
        );
        renderFeedError(pane, state.feedData.failedFeeds);
        renderStaleNotice(pane, state.feedData.staleFeeds);
        renderFeedStatus(pane, computeStatus(state, null));
        return;
      }
      var handlePosts = state.feedData.posts.filter(function (p) { return p.handle === state.handle; });
      var failed = (state.feedData.failedFeeds || []).some(function (a) { return a.handle === state.handle; });
      var stale = (state.feedData.staleFeeds || []).filter(function (a) { return a.handle === state.handle; });
      renderPostCards(
        pane,
        handlePosts,
        failed || !state.transport.ok
          ? "Couldn't load current posts for @" + state.handle + " right now."
          : "No recent posts found for @" + state.handle + "."
      );
      renderStaleNotice(pane, stale);
      renderFeedStatus(pane, computeStatus(state, state.handle));
    }

    function refreshList() {
      renderList(listRoot, groupAccounts(accountsOf(state.feedData)), state.mode, state.handle, {
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
      // renderPostCards clears the pane on refresh, so reinsert this node each
      // time instead of maintaining a separate side column.
      pane.insertBefore(liveRoot, pane.firstChild ? pane.firstChild.nextSibling : null);
    }

    function openManager() {
      window.XAccountsAdmin.open({
        onChange: function (accounts, change) {
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
        templates: [{ id: "markets", name: "Crypto & Stocks", description: "Crypto, stocks, macro and technical analysis", accent: "market", memberships: [] }],
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
