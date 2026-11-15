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

  /* ChatGPT output is loose markdown: headings, numbered stories, hyphen or
     bullet points, bold, links. Anything else renders as a paragraph. */
  function renderMarkdown(text) {
    var html = [];
    var list = null;
    function closeList() {
      if (list) html.push("</" + list + ">");
      list = null;
    }
    function openList(type) {
      if (list === type) return;
      closeList();
      html.push("<" + type + ">");
      list = type;
    }
    String(text || "").split("\n").forEach(function (raw) {
      var line = raw.trim();
      var match;
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
    closeList();
    return html.join("");
  }

  global.BriefingMarkdown = { esc: esc, inline: inline, renderMarkdown: renderMarkdown };
})(window);
