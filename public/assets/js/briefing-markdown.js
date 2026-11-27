/* Shared by the briefing pages: ChatGPT output is loose markdown (headings,
   numbered stories, hyphen or bullet points, bold, links). Everything is
   escaped first; only http(s) links are ever produced. */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Inline markdown on already-escaped text: **bold**, [label](url) and bare
     URLs. Only http(s) links are ever produced. */
  function inline(text) {
    var out = esc(text);
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, lead, url) {
      return lead + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    return out;
  }

  /* ChatGPT's in-app citation markers ("citeturn12search3turn12search4"),
     wrapped in private-use characters that a copy may or may not keep. */
  var CITE_RE = /[\uE200-\uE2FF]*cite(?:[\uE200-\uE2FF]*turn\d+[a-z]+\d+)+[\uE200-\uE2FF]*/g;
  function stripCitations(text) {
    return String(text || "").replace(CITE_RE, "").replace(/[\uE200-\uE2FF]/g, "");
  }

  var TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
  function cells(line) {
    return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) { return cell.trim(); });
  }

  /* A run of "| a | b |" lines. With a "|---|" second row the first row is
     the header, unless every header cell is empty (ChatGPT's key/value
     tables), which then has no header at all. */
  function renderTable(rows) {
    var head = null;
    var body = rows;
    if (rows.length > 1 && TABLE_SEP_RE.test(rows[1])) {
      head = cells(rows[0]);
      body = rows.slice(2);
      if (head.every(function (cell) { return !cell; })) head = null;
    }
    var out = '<div class="briefing-table-wrap"><table class="briefing-table">';
    if (head) out += "<thead><tr>" + head.map(function (cell) { return "<th>" + inline(cell) + "</th>"; }).join("") + "</tr></thead>";
    out += "<tbody>" + body.filter(function (row) { return !TABLE_SEP_RE.test(row); }).map(function (row) {
      return "<tr>" + cells(row).map(function (cell) { return "<td>" + inline(cell) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody></table></div>";
    return out;
  }

  /* ── ChatGPT widget leftovers ──────────────────────────────
     A ChatGPT answer with a live price card comes out of the Shortcut as
     loose lines: "Bitcoin (BTC)", "$60,661.00", "Open", "+$150.00 (0.25%)",
     three empty-header key/value tables full of "-", then "1D" and a table
     of 5-minute prices. tidy() turns that back into one quote block, one
     key/value table without the empty rows, and a sparkline. It also drops
     the fear/greed gauge's axis labels and captions for charts that never
     made it into the text. Plain briefings pass through unchanged. */
  var TIME_RE = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
  var PRICE_RE = /^[-+]?\$?\d[\d,]*(\.\d+)?$/;
  var EMPTY_RE = /^(-|—|–|n\/a)?$/i;
  var DROP_LINE_RES = [
    /^(extreme fear|fear|neutral|greed|extreme greed)\s+(extreme fear|fear|neutral|greed|extreme greed)$/i,
    /schematic,? not to scale\.?$/i,
  ];
  var RANGE_RE = /^(1D|5D|1W|1M|3M|6M|YTD|1Y|5Y|MAX)$/;
  var STATUS_RE = /^(open|closed|pre-market|after hours|after-hours|market open|market closed)$/i;

  function isTableLine(line) { return /^\|.*\|$/.test(line) && line.length > 1; }
  function number(text) { var n = parseFloat(String(text).replace(/[$,+\s]/g, "")); return isFinite(n) ? n : null; }

  // Split lines into blocks: { table: [rows] } or { line }.
  function blocks(lines) {
    var out = [];
    lines.forEach(function (raw) {
      var line = raw.trim();
      var last = out[out.length - 1];
      if (isTableLine(line)) {
        if (last && last.table) last.table.push(line);
        else out.push({ table: [line] });
      } else {
        out.push({ line: line });
      }
    });
    return out;
  }

  function tableParts(rows) {
    var hasSep = rows.length > 1 && TABLE_SEP_RE.test(rows[1]);
    var head = hasSep ? cells(rows[0]) : null;
    var body = (hasSep ? rows.slice(2) : rows).filter(function (r) { return !TABLE_SEP_RE.test(r); }).map(cells);
    return { head: head, body: body, keyValue: !head || head.every(function (c) { return !c; }) };
  }

  function sparkline(points, label) {
    var values = points.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var w = 240, h = 48, span = max - min || 1;
    var path = values.map(function (v, i) {
      return (i ? "L" : "M") + (values.length === 1 ? 0 : (i / (values.length - 1)) * w).toFixed(1) + " " + (h - 4 - ((v - min) / span) * (h - 8)).toFixed(1);
    }).join(" ");
    var up = values[values.length - 1] >= values[0];
    return '<figure class="briefing-spark ' + (up ? "up" : "down") + '">' +
      '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" role="img" aria-label="' +
      esc((label ? label + " " : "") + "price from " + points[0][2] + " to " + points[points.length - 1][2]) + '">' +
      '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" /></svg>' +
      "<figcaption>" + esc((label ? label + " · " : "") + points[0][0] + " " + points[0][2] + " → " + points[points.length - 1][0] + " " + points[points.length - 1][2] +
      " · low " + min.toLocaleString() + " · high " + max.toLocaleString()) + "</figcaption></figure>";
  }

  function tidy(text) {
    var input = blocks(stripCitations(text).split("\n"));
    var out = [];   // { line } | { table: rows } | { html }
    var pendingKv = null;
    function flushKv() {
      if (pendingKv && pendingKv.length) {
        out.push({ table: ["| | |", "| --- | --- |"].concat(pendingKv.map(function (r) { return "| " + r[0] + " | " + r[1] + " |"; })) });
      }
      pendingKv = null;
    }
    for (var i = 0; i < input.length; i++) {
      var b = input[i];
      if (b.table) {
        var t = tableParts(b.table);
        // A price series: every row is "time | price".
        if (t.body.length >= 3 && t.body.every(function (r) { return r.length === 2 && TIME_RE.test(r[0]) && PRICE_RE.test(r[1].replace(/\s/g, "")); })) {
          var p = out.length - 1;
          while (p >= 0 && out[p].line === "") p--;
          var label = p >= 0 && out[p].line && RANGE_RE.test(out[p].line) ? out.splice(p, out.length - p)[0].line : "";
          flushKv();
          out.push({ html: sparkline(t.body.map(function (r) { return [r[0], number(r[1]), r[1]]; }), label) });
          continue;
        }
        // Key/value tables: drop empty values, merge neighbours into one table.
        if (t.keyValue && t.body.every(function (r) { return r.length === 2; })) {
          var rows = t.body.filter(function (r) { return r[0] && !EMPTY_RE.test(r[1]); });
          if (!pendingKv) pendingKv = [];
          pendingKv = pendingKv.concat(rows);
          continue;
        }
        flushKv();
        out.push(b);
        continue;
      }
      if (!b.line && pendingKv) continue; // blank line between merged tables
      flushKv();
      if (DROP_LINE_RES.some(function (re) { return re.test(b.line); })) continue;
      // Quote header: "Name (TICKER)", "$price", optional status, change.
      var name = b.line.match(/^(.{1,60}?)\s*\(([A-Z0-9.\-=^]{1,12})\)$/);
      var lines = [], at = [];
      for (var j = i + 1; j < input.length && lines.length < 4; j++) {
        if (input[j].table) break;
        if (input[j].line) { lines.push(input[j].line); at.push(j); }
      }
      if (name && lines[0] && PRICE_RE.test(lines[0].replace(/\s/g, ""))) {
        var used = 1, status = "", change = "";
        for (var k = 1; k < Math.min(lines.length, 3); k++) {
          if (STATUS_RE.test(lines[k])) { status = lines[k]; used = k + 1; }
          else if (/^[-+−]\$?[\d,.]+\s*\(?[-+−]?[\d.]+%\)?$/.test(lines[k])) { change = lines[k]; used = k + 1; }
          else break;
        }
        i = at[used - 1];
        var down = /^[-−]/.test(change);
        out.push({ html: '<div class="briefing-quote">' +
          '<span class="briefing-quote-name">' + esc(name[1]) + ' <span class="briefing-quote-ticker">' + esc(name[2]) + "</span></span>" +
          '<span class="briefing-quote-price">' + esc(lines[0]) + "</span>" +
          (change ? '<span class="briefing-quote-change ' + (down ? "down" : "up") + '">' + esc(change) + "</span>" : "") +
          (status ? '<span class="briefing-quote-status">' + esc(status) + "</span>" : "") + "</div>" });
        continue;
      }
      out.push(b);
    }
    flushKv();
    return out;
  }

  /* ChatGPT output is loose markdown: headings, numbered stories, hyphen or
     bullet points, bold, links, pipe tables. Anything else renders as a
     paragraph. */
  function renderMarkdown(text) {
    var html = [];
    var list = null;
    var table = [];
    function closeList() {
      if (list) html.push("</" + list + ">");
      list = null;
    }
    function closeTable() {
      if (table.length) html.push(renderTable(table));
      table = [];
    }
    function openList(type) {
      if (list === type) return;
      closeList();
      html.push("<" + type + ">");
      list = type;
    }
    tidy(text).forEach(function (block) {
      if (block.html) { closeList(); closeTable(); html.push(block.html); return; }
      if (block.table) { closeList(); closeTable(); table = block.table; return; }
      var line = block.line;
      var match;
      closeTable();
      if (!line) { closeList(); return; }
      if (/^(-{3,}|\*{3,}|_{3,}|—{2,})$/.test(line)) { closeList(); html.push("<hr />"); return; }
      if ((match = line.match(/^(#{1,4})\s+(.*)$/))) {
        closeList();
        var level = Math.min(match[1].length + 2, 6);
        html.push("<h" + level + ">" + inline(match[2]) + "</h" + level + ">");
        return;
      }
      if ((match = line.match(/^[-*•▪◦·]\s+(.*)$/))) {
        openList("ul");
        html.push("<li>" + inline(match[1]) + "</li>");
        return;
      }
      if ((match = line.match(/^(\d{1,2})[.)]\s+(.*)$/))) {
        closeList();
        html.push('<p class="briefing-story"><span class="briefing-rank">' + match[1] + "</span>" + inline(match[2]) + "</p>");
        return;
      }
      closeList();
      html.push("<p>" + inline(line) + "</p>");
    });
    closeTable();
    closeList();
    return html.join("");
  }

  global.BriefingMarkdown = { esc: esc, inline: inline, renderMarkdown: renderMarkdown, stripCitations: stripCitations };
})(window);
