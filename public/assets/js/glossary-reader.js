(function () {
  "use strict";

  var glossary = window.MarketGlossary;
  var dialog = document.getElementById("glossaryReader");
  if (!glossary || !dialog || typeof dialog.showModal !== "function") return;

  var button = document.getElementById("glossaryReadRandom");
  var title = document.getElementById("glossaryReaderTitle");
  var definition = document.getElementById("glossaryReaderDefinition");
  var interpretation = document.getElementById("glossaryReaderInterpretation");
  var playback = document.getElementById("glossaryReaderPlayback");
  var next = document.getElementById("glossaryReaderNext");
  var link = document.getElementById("glossaryReaderLink");
  var status = document.getElementById("glossaryReaderStatus");
  var synthesis = window.speechSynthesis;
  var canSpeak = synthesis && typeof window.SpeechSynthesisUtterance === "function";
  var entry = null;
  var activeUtterance = null;

  function finishSpeech() {
    activeUtterance = null;
    playback.textContent = "Read aloud";
  }

  function stopSpeech() {
    if (!activeUtterance) return;
    finishSpeech();
    synthesis.cancel();
  }

  function readEntry() {
    if (!canSpeak) {
      status.textContent = "Read-aloud is unavailable in this browser.";
      return;
    }

    // Short utterances keep voices that cut off long passages reading.
    var text = entry.term + ". " + entry.def + " How to read it. " + entry.read;
    var chunks = text.match(/\S.{0,159}(?=\s|$)|\S+/g);
    status.textContent = "";
    playback.textContent = "Stop reading";

    function speakChunk(index) {
      var utterance = new window.SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = document.documentElement.lang;
      activeUtterance = utterance;
      utterance.onend = function () {
        if (activeUtterance !== utterance) return;
        if (index + 1 < chunks.length) speakChunk(index + 1);
        else finishSpeech();
      };
      utterance.onerror = function () {
        if (activeUtterance !== utterance) return;
        finishSpeech();
        status.textContent = "Audio couldn’t play. Try Read aloud again or read the text above.";
      };
      synthesis.speak(utterance);
    }

    speakChunk(0);
  }

  function showAnother() {
    var pool = glossary.currentSearchPool();
    var pick = glossary.takeRandomConcept(pool, entry && entry.id);
    if (!pick) return;

    stopSpeech();
    entry = pick;
    title.textContent = entry.term;
    definition.textContent = entry.def;
    interpretation.textContent = entry.read;
    link.href = glossary.conceptHref(entry);
    next.disabled = pool && pool.length === 1;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    // Start during the click, while the browser still has a user gesture.
    readEntry();
  }

  playback.hidden = !canSpeak;
  playback.addEventListener("click", function () {
    if (activeUtterance) stopSpeech();
    else readEntry();
  });
  next.addEventListener("click", showAnother);
  button.addEventListener("click", showAnother);
  dialog.addEventListener("close", function () {
    if (!dialog.open) stopSpeech();
  });
  window.addEventListener("pagehide", stopSpeech);
  button.hidden = false;
})();
