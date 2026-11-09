/* X Intelligence: Developing Stories — deterministic keyword grouping of the
   posts already loaded (and already filtered) on the page.

   What this is, and what it is not:
     - It groups posts that share distinctive words (names, tickers, hashtags,
       figures) within a six-hour window, posted by at least two accounts.
     - It matches words, not meaning. A group is a scanning aid, never a
       statement that an event happened: several posts are counted as posts,
       not as sources confirming one another, and nothing here labels anything
       confirmed, verified or live.
     - It never fetches, never calls a model, and never changes the posts it
       is given. Groups hold references to the original post objects.

   Pure (storage is passed in), so the browser and the Node tests share one
   implementation. Loaded as a plain script before x-intelligence.js. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XStories = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var HOUR = 60 * 60 * 1000;

  var DEFAULTS = {
    // Every post in a group lies within this span of every other.
    windowMs: 6 * HOUR,
    // Newest posts considered. Bounds the work on a very large feed.
    maxPosts: 500,
    // A group stops growing here; bounds the per-merge consistency check.
    maxGroupSize: 24,
    // Hard ceiling on scored pairs, whatever the feed looks like.
    maxPairs: 40000,
    // Posts with fewer content words than this are too short to compare.
    minTokens: 3,
    // Two shared distinctive terms and this much overall word overlap...
    minJaccard: 0.2,
    // ...or one shared distinctive term and this much.
    strongJaccard: 0.4,
    // A term in this share of the loaded posts (and at least genericMin of
    // them), spread over more than two windows, is background, not an event.
    genericShare: 0.2,
    genericMin: 8,
  };

  var STORAGE_KEY = "xIntelligence:developingStories:v1";

  var NOTE =
    "Grouped automatically by shared keywords in the posts loaded on this page. " +
    "Labels are keywords, not headlines. Several posts in a group are not independent " +
    "confirmation — accounts often repeat or quote one another.";

  /* ── Vocabulary ────────────────────────────────────────────────────────── */

  function setOf(words) {
    var s = Object.create(null);
    words.split(/\s+/).forEach(function (w) { if (w) s[w] = true; });
    return s;
  }

  var STOPWORDS = setOf(
    "a an and are as at be been being but by can could did do does doing done for from had has have " +
    "having he her here hers him his how i if in into is it its itself just me more most my no nor not " +
    "of off on once only or other our ours out over own same she should so some such than that the their " +
    "them then there these they this those through to too under until up very was we were what when where " +
    "which while who whom why will with would you your yours yourself about above after again against all " +
    "am any because before below between both down during each few further let lets also may might must " +
    "shall us vs via per amp im ive dont doesnt didnt cant wont isnt arent wasnt thats theres whats " +
    "still yet even ever much many every another got get gets going go goes gone one two three like"
  );

  /* Words that dress a post up without saying what it is about. Includes the
     status words a label must never carry, so they cannot surface in one. */
  var FILLER = setOf(
    "breaking break just now new news report reports reported reporting say says said saying update " +
    "updates updated live watch watching thread rt according today yesterday tonight tomorrow latest " +
    "alert alerts developing confirmed confirm confirms unconfirmed verified verify official officially " +
    "source sources video photo photos look looks read here more big huge major week weeks day days time " +
    "times year years hour hours minute minutes ago soon right left way thing things people want wants " +
    "know think see seen make makes made take takes took back first last next good bad high low well " +
    "really actually exclusive urgent happening statement statements comment comments"
  );

  /* Kept as overlap words, never as distinctive terms: they appear across
     unrelated events all the time. */
  var NON_DISTINCTIVE = setOf(
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july " +
    "august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "est edt pst pdt utc gmt am pm"
  );

  /* Shared across countless unrelated stories, so a match on one of them
     alone must never make a group. The collection-level rule below catches
     a template's own background terms on top of this list. */
  var GENERIC = setOf(
    "bitcoin btc $btc crypto cryptocurrency ethereum eth $eth trump biden harris ukraine ukrainian russia " +
    "russian putin zelensky china chinese israel israeli iran gaza us usa america american americans fed " +
    "market markets stock stocks equities $spy $spx $qqq nasdaq dow sec government president " +
    "white house europe european eu uk britain elon musk ai oil gold dollar usd economy inflation " +
    "rates rate war world global x twitter"
  );

  /* ── Tokenizing ────────────────────────────────────────────────────────── */

  var URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
  var MENTION_RE = /(^|[^\w@])@\w{1,15}\b/g;
  var CASHTAG_RE = /^\$[A-Za-z][A-Za-z0-9]{0,9}$/;
  var HASHTAG_RE = /^#[A-Za-z0-9_]{2,40}$/;
  var YEAR_RE = /^(19|20)\d\d$/;

  // Plural "s" only. Anything cleverer is inconsistent ("raised" vs "raise")
  // and inconsistent stemming hurts precision more than it helps recall.
  function stem(word) {
    if (word.length > 3 && word.charAt(word.length - 1) === "s" && !/(ss|us|is)$/.test(word)) {
      return word.slice(0, -1);
    }
    return word;
  }

  function trimPunctuation(raw) {
    return raw
      .replace(/^[^A-Za-z0-9$#À-￿]+/, "")
      .replace(/[^A-Za-z0-9%À-￿]+$/, "");
  }

  /* One post's words. Returns:
       tokens     every content token (for overlap)
       strong     cashtags, hashtags and figures (distinctive on their own)
       capsMid    capitalised words found mid-sentence (proper-noun evidence)
       capsOther  capitalised words whose capital may only be positional
       surface    first written form of each token, for the label */
  function tokenize(text) {
    var out = { tokens: Object.create(null), strong: Object.create(null), capsMid: Object.create(null), capsOther: Object.create(null), surface: Object.create(null), count: 0 };
    var source = String(text === null || text === undefined ? "" : text)
      .replace(URL_RE, " ")
      .replace(MENTION_RE, "$1 ");
    var raws = source.split(/\s+/);
    var words = [];
    var sentenceStart = true;
    raws.forEach(function (raw) {
      var ends = /[.!?:;…]["')\]]*$/.test(raw) || /^[—–-]+$/.test(raw);
      var word = trimPunctuation(raw);
      if (word) words.push({ word: word, initial: sentenceStart });
      if (word || ends) sentenceStart = ends;
    });

    var letterWords = words.filter(function (w) { return /^[A-Za-z]{2,}$/.test(w.word); });
    var capsShare = letterWords.filter(function (w) { return /^[A-Z]/.test(w.word); }).length;
    var upperShare = letterWords.filter(function (w) { return /^[A-Z]{2,}$/.test(w.word); }).length;
    // Headline Title Case and ALL-CAPS posts: capitals there are style, not
    // evidence of a name, so they only count when the rest of the feed agrees.
    var styled = letterWords.length >= 4 &&
      (capsShare / letterWords.length >= 0.6 || upperShare / letterWords.length >= 0.6);

    function add(token, surface, kind) {
      if (!token) return;
      if (!out.tokens[token]) out.count += 1;
      out.tokens[token] = true;
      if (!out.surface[token]) out.surface[token] = surface;
      if (kind === "strong") out.strong[token] = true;
      else if (kind === "mid") out.capsMid[token] = true;
      else if (kind === "other") out.capsOther[token] = true;
    }

    words.forEach(function (entry) {
      var word = entry.word.replace(/['’]s$/i, "");
      if (CASHTAG_RE.test(word)) return add(word.toLowerCase(), word.toUpperCase(), "strong");
      if (HASHTAG_RE.test(word)) return add(word.toLowerCase(), word, "strong");
      if (/\d/.test(word)) {
        var figure = word.replace(/^\$/, "").replace(/,/g, "").toLowerCase();
        if (!/^[a-z0-9.%\-]+$/.test(figure)) return;
        // Single digits and bare years appear in everything.
        if (/^\d$/.test(figure)) return;
        if (YEAR_RE.test(figure)) return add(figure, word, "plain");
        return add(figure, word, "strong");
      }
      var bare = word.replace(/['’]/g, "");
      if (!/^[A-Za-zÀ-￿][A-Za-zÀ-￿\-]*$/.test(bare)) return;
      var lower = bare.toLowerCase();
      if (STOPWORDS[lower] || FILLER[lower]) return;
      var acronym = /^[A-Z]{2,6}$/.test(bare);
      if (!acronym && lower.length < 3) return;
      var token = acronym ? lower : stem(lower);
      if (FILLER[token]) return;
      var capital = /^[A-Z]/.test(bare);
      if (!capital || NON_DISTINCTIVE[lower]) return add(token, bare, "plain");
      if (styled) {
        // A short all-caps word in a shouted post is still likely an acronym.
        return add(token, bare, acronym && bare.length <= 4 ? "mid" : "other");
      }
      // An acronym's capitals are not positional, so it counts wherever it sits.
      add(token, bare, entry.initial && !acronym ? "other" : "mid");
    });
    return out;
  }

  /* ── Posts ─────────────────────────────────────────────────────────────── */

  /* Same identity rule as XFeedView.postKey: the X status id, else the
     permalink. Duplicated rather than imported so this module stands alone. */
  function postKey(post) {
    if (!post) return "";
    if (post.id !== undefined && post.id !== null && String(post.id)) return "id:" + String(post.id);
    return post.url ? "url:" + String(post.url) : "";
  }

  function timeOf(post) {
    var ms = post && post.publishedAt ? new Date(post.publishedAt).getTime() : NaN;
    return isFinite(ms) ? ms : null;
  }

  function handleOf(post) {
    return post && typeof post.handle === "string" ? post.handle.trim().replace(/^@/, "").toLowerCase() : "";
  }

  function keysOf(map) {
    var list = [];
    for (var k in map) list.push(k);
    return list;
  }

  /* The posts that can take part, newest `maxPosts` of them, oldest first.
     Skipped: anything that is not a post object, has no stable identity, no
     handle, no usable timestamp (its age is unknown, so it cannot be placed
     in a window), or too few words to compare. Duplicates — the same id, or
     the same permalink — count once. */
  function prepare(posts, opts, keyOf) {
    var seenKeys = Object.create(null);
    var seenUrls = Object.create(null);
    var records = [];
    var skipped = 0;
    (Array.isArray(posts) ? posts : []).forEach(function (post) {
      if (!post || typeof post !== "object") { skipped += 1; return; }
      var key = keyOf(post);
      var url = typeof post.url === "string" ? post.url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "") : "";
      if (!key || seenKeys[key] || (url && seenUrls[url])) { skipped += 1; return; }
      var t = timeOf(post);
      var handle = handleOf(post);
      if (t === null || !handle || typeof post.text !== "string") { skipped += 1; return; }
      seenKeys[key] = true;
      if (url) seenUrls[url] = true;
      var tok = tokenize(post.text);
      if (tok.count < opts.minTokens) { skipped += 1; return; }
      records.push({ post: post, key: key, t: t, handle: handle, tok: tok });
    });
    records.sort(function (a, b) { return b.t - a.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    var truncated = records.length > opts.maxPosts;
    if (truncated) {
      skipped += records.length - opts.maxPosts;
      records = records.slice(0, opts.maxPosts);
    }
    records.reverse();
    return { records: records, skipped: skipped, truncated: truncated };
  }

  /* Which terms are distinctive in each post, given the whole collection.
     A capital letter counts as evidence of a name when the word appears
     capitalised mid-sentence somewhere in the collection; terms on the
     generic list, or spread thinly across the whole feed, never count. */
  function assignDistinctive(records, opts) {
    var lexicon = Object.create(null);
    records.forEach(function (r) { for (var k in r.tok.capsMid) lexicon[k] = true; });

    records.forEach(function (r) {
      var d = Object.create(null);
      var k;
      for (k in r.tok.strong) d[k] = true;
      for (k in r.tok.capsMid) d[k] = true;
      for (k in r.tok.capsOther) if (lexicon[k]) d[k] = true;
      for (k in d) if (GENERIC[k]) delete d[k];
      r.distinct = d;
    });

    var stats = Object.create(null);
    records.forEach(function (r) {
      for (var k in r.distinct) {
        var s = stats[k] || (stats[k] = { df: 0, min: r.t, max: r.t });
        s.df += 1;
        if (r.t < s.min) s.min = r.t;
        if (r.t > s.max) s.max = r.t;
      }
    });
    var threshold = Math.max(opts.genericMin, Math.ceil(opts.genericShare * records.length));
    var background = Object.create(null);
    for (var term in stats) {
      var st = stats[term];
      if (st.df >= threshold && st.max - st.min > 2 * opts.windowMs) background[term] = true;
    }
    records.forEach(function (r) {
      for (var k in background) delete r.distinct[k];
      r.distinctList = keysOf(r.distinct);
      r.tokenList = keysOf(r.tok.tokens);
    });
    return background;
  }

  function jaccard(a, b) {
    var small = a.tokenList.length <= b.tokenList.length ? a : b;
    var large = small === a ? b : a;
    var shared = 0;
    small.tokenList.forEach(function (t) { if (large.tok.tokens[t]) shared += 1; });
    var union = a.tokenList.length + b.tokenList.length - shared;
    return union ? shared / union : 0;
  }

  /* The pair rule. Both posts inside the window, and either two shared
     distinctive terms with some overall overlap, or one shared distinctive
     term with a lot of it. A shared generic word contributes overlap only. */
  function relate(a, b, sharedDistinct, opts) {
    if (Math.abs(a.t - b.t) > opts.windowMs) return null;
    if (!sharedDistinct) return null;
    var j = jaccard(a, b);
    var ok = (sharedDistinct >= 2 && j >= opts.minJaccard) || (sharedDistinct >= 1 && j >= opts.strongJaccard);
    return ok ? { j: j, s: sharedDistinct } : null;
  }

  /* Candidate pairs come only from posts sharing a distinctive term inside
     the window (an inverted index), so the work grows with the number of
     plausible matches, not with the square of the feed. Capped at maxPairs. */
  function scorePairs(records, opts) {
    var index = Object.create(null);
    records.forEach(function (r, i) {
      r.distinctList.forEach(function (term) { (index[term] || (index[term] = [])).push(i); });
    });
    var shared = Object.create(null);
    var pairKeys = [];
    var capped = false;
    var terms = keysOf(index).sort();
    for (var ti = 0; ti < terms.length && !capped; ti += 1) {
      var list = index[terms[ti]];
      for (var x = 0; x < list.length && !capped; x += 1) {
        for (var y = x + 1; y < list.length; y += 1) {
          var i = list[x];
          var j = list[y];
          // Lists are in time order, so the rest of this row is out of range.
          if (records[j].t - records[i].t > opts.windowMs) break;
          var pk = i * records.length + j;
          if (shared[pk] === undefined) {
            if (pairKeys.length >= opts.maxPairs) { capped = true; break; }
            shared[pk] = 0;
            pairKeys.push(pk);
          }
          shared[pk] += 1;
        }
      }
    }
    var related = Object.create(null);
    var edges = [];
    pairKeys.forEach(function (pk) {
      var i = Math.floor(pk / records.length);
      var j = pk % records.length;
      var rel = relate(records[i], records[j], shared[pk], opts);
      if (!rel) return;
      related[pk] = true;
      edges.push({ i: i, j: j, score: rel.j + 0.1 * rel.s });
    });
    edges.sort(function (a, b) { return b.score - a.score || a.i - b.i || a.j - b.j; });
    return { related: related, edges: edges, capped: capped };
  }

  /* Greedy agglomerative grouping, strongest pairs first. Two clusters merge
     only if the merged group still holds together as a whole:
       - every post is within windowMs of every other;
       - every post is related to a strict majority of the others.
     The second rule is what stops a chain A~B~C from joining two separate
     events through a post that mentions both: in a group of three, each post
     has to match both of the others. */
  function cluster(records, scored, opts) {
    var n = records.length;
    var owner = [];
    var members = [];
    for (var i = 0; i < n; i += 1) { owner.push(i); members.push([i]); }

    function isRelated(a, b) {
      return a < b ? !!scored.related[a * n + b] : !!scored.related[b * n + a];
    }

    function consistent(list) {
      var min = Infinity;
      var max = -Infinity;
      list.forEach(function (m) {
        if (records[m].t < min) min = records[m].t;
        if (records[m].t > max) max = records[m].t;
      });
      if (max - min > opts.windowMs) return false;
      for (var a = 0; a < list.length; a += 1) {
        var hits = 0;
        for (var b = 0; b < list.length; b += 1) {
          if (a !== b && isRelated(list[a], list[b])) hits += 1;
        }
        if (hits * 2 <= list.length - 1) return false;
      }
      return true;
    }

    scored.edges.forEach(function (edge) {
      var ca = owner[edge.i];
      var cb = owner[edge.j];
      if (ca === cb) return;
      var merged = members[ca].concat(members[cb]);
      if (merged.length > opts.maxGroupSize || !consistent(merged)) return;
      var keep = Math.min(ca, cb);
      var drop = Math.max(ca, cb);
      members[keep] = merged;
      members[drop] = null;
      merged.forEach(function (m) { owner[m] = keep; });
    });

    return members.filter(function (list) { return list && list.length >= 2; });
  }

  /* Neutral keyword label: the distinctive terms most members share, in
     their written form. Never a sentence, never a claim. */
  function labelFor(list) {
    var counts = Object.create(null);
    var order = [];
    var surface = Object.create(null);
    var strong = Object.create(null);
    list.forEach(function (r) {
      r.distinctList.forEach(function (term) {
        if (!counts[term]) { counts[term] = 0; order.push(term); }
        counts[term] += 1;
        if (!surface[term]) surface[term] = r.tok.surface[term] || term;
        if (r.tok.strong[term]) strong[term] = true;
      });
    });
    var terms = order
      .filter(function (t) { return counts[t] >= 2; })
      .sort(function (a, b) {
        return counts[b] - counts[a] || (strong[a] ? 0 : 1) - (strong[b] ? 0 : 1) || order.indexOf(a) - order.indexOf(b);
      })
      .slice(0, 3)
      .map(function (t) { return surface[t]; })
      // Belt and braces: the filler list already keeps these out.
      .filter(function (s) { return !/confirm|verif|official|breaking/i.test(s); });
    return terms;
  }

  function normalizeOptions(options) {
    var opts = {};
    for (var k in DEFAULTS) {
      var v = options && typeof options[k] === "number" && isFinite(options[k]) && options[k] > 0 ? options[k] : DEFAULTS[k];
      opts[k] = v;
    }
    return opts;
  }

  /* Groups `posts` into developing stories. Returns
       { groups, considered, skipped, truncated }
     where each group is
       { id, label, terms, posts, postCount, accountCount, handles,
         earliestAt, latestAt }
     and `posts` are the original objects, newest first. Groups are ordered
     newest-latest-post first. Input is never modified. */
  function groupStories(posts, options) {
    var opts = normalizeOptions(options);
    var keyOf = options && typeof options.keyOf === "function" ? options.keyOf : postKey;
    var prep = prepare(posts, opts, keyOf);
    var records = prep.records;
    var result = { groups: [], considered: records.length, skipped: prep.skipped, truncated: prep.truncated };
    if (records.length < 2) return result;

    assignDistinctive(records, opts);
    var scored = scorePairs(records, opts);
    if (scored.capped) result.truncated = true;

    cluster(records, scored, opts).forEach(function (indices) {
      var list = indices.map(function (i) { return records[i]; });
      var handles = [];
      list.forEach(function (r) { if (handles.indexOf(r.handle) < 0) handles.push(r.handle); });
      // One account posting a thread is not a developing story.
      if (handles.length < 2) return;
      list.sort(function (a, b) { return b.t - a.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
      var earliest = list[list.length - 1];
      var terms = labelFor(list);
      result.groups.push({
        // Anchored on the earliest post, so the id survives a newer post
        // joining the group on the next refresh.
        id: "story:" + earliest.key,
        terms: terms,
        label: terms.join(" · "),
        posts: list.map(function (r) { return r.post; }),
        postCount: list.length,
        accountCount: handles.length,
        handles: handles.slice().sort(),
        earliestAt: new Date(earliest.t).toISOString(),
        latestAt: new Date(list[0].t).toISOString(),
      });
    });

    result.groups.sort(function (a, b) {
      return (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0) || (a.id < b.id ? -1 : 1);
    });
    return result;
  }

  /* ── Memoisation ───────────────────────────────────────────────────────── */

  /* The page re-renders on every filter keystroke and view change. This
     recomputes only when the scope (template) or the set of posts actually
     changed; a different template never reuses another template's groups. */
  function createStoryCache(options) {
    var last = null;
    return {
      compute: function (scope, posts) {
        var keyOf = options && typeof options.keyOf === "function" ? options.keyOf : postKey;
        var sig = String(scope || "") + "\n" + (Array.isArray(posts) ? posts : []).map(function (p) {
          return p ? keyOf(p) + "|" + (p.publishedAt || "") + "|" + (typeof p.text === "string" ? p.text.length : -1) + "|" + (p.handle || "") : "";
        }).join("\n");
        if (last && last.sig === sig) return last.result;
        last = { sig: sig, result: groupStories(posts, options) };
        return last.result;
      },
      clear: function () { last = null; },
    };
  }

  /* ── Preference ────────────────────────────────────────────────────────── */

  function readEnabled(storage) {
    try { return !!storage && storage.getItem(STORAGE_KEY) === "on"; } catch (err) { return false; }
  }

  function writeEnabled(storage, on) {
    try { if (storage) storage.setItem(STORAGE_KEY, on ? "on" : "off"); } catch (err) {}
  }

  /* ── Freshness caveat ──────────────────────────────────────────────────── */

  /* What the section adds to the page's own freshness banner. The groups
     carry no status of their own; when the feed is cached or degraded the
     section says so in its own words, so it cannot read as a live view. */
  function freshnessCaveat(status, cache, formatRelative) {
    var rel = typeof formatRelative === "function" ? formatRelative : function () { return ""; };
    if (cache) {
      var saved = cache.savedAtIso ? rel(cache.savedAtIso) : "";
      return "Built from browser-cached posts" + (saved ? " saved " + saved : "") +
        (cache.expired ? " that have expired" : "") +
        ". This is not a live view; newer posts may change or split these groups.";
    }
    var level = status && status.level;
    if (!level || level === "live" || level === "empty") return "";
    return "The latest feed check was not fully successful (" + level + "). " +
      "Groups only reflect the posts loaded here and may be missing newer ones.";
  }

  return {
    DEFAULTS: DEFAULTS,
    STORAGE_KEY: STORAGE_KEY,
    NOTE: NOTE,
    tokenize: tokenize,
    postKey: postKey,
    groupStories: groupStories,
    createStoryCache: createStoryCache,
    readEnabled: readEnabled,
    writeEnabled: writeEnabled,
    freshnessCaveat: freshnessCaveat,
  };
});
