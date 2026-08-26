"use strict";

/**
 * NewsroomService
 *
 * Orchestrates one newsroom reporting cycle: preflight, generation, delivery.
 * It owns no storage of its own — the reporter generation log keeps the
 * report text, the broadcast ledger keeps the receipts, and the cycle store
 * keeps the spine that links them. What it adds is sequencing and, more
 * importantly, the rules about *not* repeating work:
 *
 *   - a doubled cron invocation attaches to the existing cycle rather than
 *     forking a parallel run;
 *   - a cycle that generated its report and failed to deliver is redelivered,
 *     never regenerated;
 *   - a failure is classified before it is stored, so an authentication or
 *     configuration fault is not retried on a loop the way a 5xx would be.
 *
 * What this repository cannot verify is the ShareBot/OpenClaw side of the
 * route: the model identity behind the scheduled agent lives outside this
 * codebase. `externalPreflight` is the seam for it — supply an async function
 * and its verdict joins the preflight; supply nothing and the check is
 * recorded as unverified rather than silently assumed to pass.
 */

const crypto = require("crypto");
const { destinationsForNewsType } = require("./news-routing");
const { broadcastReportSections, REPORT_CATEGORIES } = require("./report-broadcast");
const { classifyFailure } = require("./failure-classification");
const { scheduledCycleKey, ACTIVE_STATUSES, GENERATED_STATUSES } = require("./newsroom-cycles");
const { UNCONFIGURED_DETAIL, PASS, WARN, FAIL } = require("./newsroom-agent-preflight");

const DEFAULT_SECTIONS = ["crypto", "economics", "markets"];
// How long a cycle may sit untouched in an active status before a later
// invocation treats it as abandoned and resumes it rather than deferring to a
// run that is no longer happening.
const RESUME_STALE_MS = 15 * 60 * 1000;
const SECTION_TO_NEWS_TYPE = Object.fromEntries(REPORT_CATEGORIES.map((category) => [category.key, category.newsType]));

function isPostedDestination(destination) {
  return destination && destination.status === "posted";
}

/** Next UTC occurrence of any "HH:MM" in `times`, or null when none are set. */
function nextExpectedRun(times, from = new Date()) {
  const parsed = (Array.isArray(times) ? times : [])
    .map((value) => /^(\d{1,2}):(\d{2})$/.exec(String(value).trim()))
    .filter(Boolean)
    .map((match) => ({ hour: Number(match[1]), minute: Number(match[2]) }))
    .filter(({ hour, minute }) => hour >= 0 && hour < 24 && minute >= 0 && minute < 60);
  if (!parsed.length) return null;

  const candidates = [];
  [0, 1].forEach((dayOffset) => {
    parsed.forEach(({ hour, minute }) => {
      const candidate = new Date(
        Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset, hour, minute, 0, 0),
      );
      if (candidate.getTime() > from.getTime()) candidates.push(candidate);
    });
  });
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((date) => date.getTime()))).toISOString();
}

function promptHash(prompt) {
  if (!prompt) return null;
  return crypto.createHash("sha256").update(String(prompt)).digest("hex").slice(0, 16);
}

class NewsroomService {
  constructor({
    cycleStore,
    reporterService,
    telegramService,
    broadcastLedgerStore,
    sections,
    expectedRunTimesUtc = [],
    externalPreflight = null,
    allowPartialDelivery = false,
    logger = console,
  } = {}) {
    this._cycles = cycleStore;
    this._reporter = reporterService;
    this._telegram = telegramService;
    this._ledger = broadcastLedgerStore;
    this._sections = Array.isArray(sections) && sections.length ? [...sections] : [...DEFAULT_SECTIONS];
    this._expectedRunTimesUtc = Array.isArray(expectedRunTimesUtc) ? [...expectedRunTimesUtc] : [];
    this._externalPreflight = typeof externalPreflight === "function" ? externalPreflight : null;
    this._allowPartialDelivery = Boolean(allowPartialDelivery);
    this._logger = logger;
  }

  get sections() {
    return [...this._sections];
  }

  /**
   * Cheap, local, side-effect-free configuration check.
   *
   * Everything here is answerable from this process's own configuration — no
   * provider call, no Telegram message. A cycle runs it before spending
   * anything, so a missing key produces a cycle record with a readable reason
   * instead of a half-finished broadcast.
   */
  async preflight() {
    const checks = [];
    // `ok` decides whether a cycle may proceed; `status` carries the severity,
    // in the same pass/warn/fail vocabulary the broadcast preflight uses. They
    // differ in exactly one place — an unverifiable external route is a warn
    // that still lets the cycle run.
    const add = (name, ok, detail, extra = {}) =>
      checks.push({ name, ok: Boolean(ok), status: ok ? PASS : FAIL, detail, ...extra });

    const reporterConfigured = Boolean(this._reporter && this._reporter.configured);
    add(
      "reporter-credentials",
      reporterConfigured,
      reporterConfigured ? "Reporter API key is present." : "Reporter has no API key (OPENAI_API_KEY).",
    );

    const model = this._reporter ? this._reporter.model : null;
    add("reporter-model", Boolean(model), model ? `Model route: ${model}` : "No reporter model configured.");

    const sectionsOk = this._sections.length > 0;
    add(
      "report-sections",
      sectionsOk,
      sectionsOk ? `Expected sections: ${this._sections.join(", ")}` : "No report sections are configured.",
    );

    const unknownSections = this._sections.filter((section) => !SECTION_TO_NEWS_TYPE[section]);
    add(
      "section-categories",
      unknownSections.length === 0,
      unknownSections.length
        ? `No news category is mapped for: ${unknownSections.join(", ")}`
        : "Every expected section maps to a news category.",
    );

    const telegramConfigured = Boolean(this._telegram && this._telegram.configured);
    add(
      "telegram-credentials",
      telegramConfigured,
      telegramConfigured ? "Telegram sender is configured." : "Telegram is not configured (bot token / chat ids).",
    );

    const settings = this._ledger ? this._ledger.getSettings() : null;
    const unroutable = this._sections
      .map((section) => SECTION_TO_NEWS_TYPE[section])
      .filter(Boolean)
      .filter((newsType) => {
        const targets = destinationsForNewsType(newsType, settings);
        if (targets && targets.length) return false;
        // No locked topic means the category falls back to the configured chat
        // list, which is only a valid route if that list has something in it.
        const fallback = (this._telegram && this._telegram._chatIds) || [];
        return fallback.length === 0;
      });
    add(
      "news-routing",
      unroutable.length === 0,
      unroutable.length ? `No destination resolves for: ${unroutable.join(", ")}` : "Every category resolves to a destination.",
    );

    add("broadcast-ledger", Boolean(this._ledger), this._ledger ? "Receipt store is available." : "No broadcast ledger store.");

    if (this._externalPreflight) {
      // A configured route is a real gate: a credential the gateway no longer
      // recognizes fails the cycle here, before it spends anything, instead of
      // surfacing as an unexplained silence hours later.
      try {
        const result = await this._externalPreflight();
        const ok = result?.ok !== false;
        checks.push({
          name: "external-agent-route",
          ok,
          status: result?.status || (ok ? PASS : FAIL),
          detail: result?.detail || "External route check completed.",
          ...(result?.code ? { code: result.code } : {}),
          ...(result?.httpStatus ? { httpStatus: result.httpStatus } : {}),
        });
      } catch (err) {
        // createAgentRoutePreflight resolves rather than throws, so reaching
        // here means a caller-supplied checker misbehaved. Treat it the same
        // way: a check that cannot answer does not get to pass.
        const classification = classifyFailure(err, { phase: "preflight" });
        checks.push({
          name: "external-agent-route",
          ok: false,
          status: FAIL,
          code: classification.code,
          detail: `External route check failed: ${classification.message || classification.reason}`,
        });
      }
    } else {
      // Not a failure — the cycle still runs — but not a pass either. The
      // agent route is configured outside this repository, and calling an
      // unknown a pass is how a broken route stays invisible.
      checks.push({
        name: "external-agent-route",
        ok: true,
        status: WARN,
        skipped: true,
        detail: UNCONFIGURED_DETAIL,
      });
    }

    return { ok: checks.every((check) => check.ok), checks };
  }

  /**
   * Start (or resume) the cycle for a scheduled slot and drive it as far as it
   * can go.
   *
   * Called twice for the same slot, the second call does not start a second
   * run: it finds the first cycle by its deterministic key and either reports
   * it (in flight or complete) or continues the work that is still
   * outstanding.
   */
  async runCycle({ scheduledAt, trigger = "cron", ttlMs, cycleKey, deliver = true } = {}) {
    const key = cycleKey || scheduledCycleKey(scheduledAt);
    const { cycle, created } = this._cycles.startCycle({
      cycleKey: key,
      scheduledAt,
      trigger,
      sectionsExpected: this._sections,
      reporter: { model: this._reporter ? this._reporter.model : null },
    });

    if (!created && cycle.status === "completed") {
      return { cycle, created: false, reused: true, skipped: "already-completed" };
    }
    if (!created && ACTIVE_STATUSES.has(cycle.status)) {
      // Another invocation is mid-flight on this same slot. Attaching to it is
      // the whole point of the deterministic key — a second generation would
      // double the spend and a second delivery would double the post.
      //
      // The staleness window is what keeps that from becoming a permanent
      // block: a cycle abandoned mid-run by a restart stops looking in-flight
      // once nothing has touched it for RESUME_STALE_MS, and the next
      // invocation resumes it.
      const touchedAt = new Date(cycle.updatedAt || cycle.startedAt).getTime();
      const stale = Number.isFinite(touchedAt) && Date.now() - touchedAt > RESUME_STALE_MS;
      if (!stale) return { cycle, created: false, reused: true, skipped: "already-running" };
    }

    const preflight = await this.preflight();
    this._cycles.recordPreflight(cycle.id, preflight);
    if (!preflight.ok) {
      const failed = preflight.checks.filter((check) => !check.ok);
      failed.forEach((check) => {
        this._cycles.recordFailure(cycle.id, {
          phase: "preflight",
          classification: {
            class: "non_retryable",
            retryable: false,
            code: "preflight",
            status: null,
            message: `${check.name}: ${check.detail}`,
            reason: "Preflight failed. Nothing was generated or sent.",
          },
        });
      });
      return { cycle: this._cycles.setStatus(cycle.id, "preflight_failed"), created, preflight };
    }

    const generation = GENERATED_STATUSES.has(cycle.status)
      ? { ok: true, skipped: "already-generated" }
      : await this._generate(cycle, { ttlMs });

    if (!generation.ok) {
      return { cycle: this._cycles.getCycle(cycle.id), created, preflight, generation };
    }

    if (!deliver) {
      return { cycle: this._cycles.getCycle(cycle.id), created, preflight, generation };
    }

    const delivery = await this._deliver(cycle.id, { ttlMs, incomplete: generation.incomplete });
    return { cycle: this._cycles.getCycle(cycle.id), created, preflight, generation, delivery };
  }

  /**
   * Deliver an already-generated cycle. Never generates: this is the path a
   * partial or failed delivery retries through, and regenerating a report that
   * already exists would both cost money and change what was published.
   */
  async deliverCycle(idOrKey, { ttlMs } = {}) {
    const cycle = this._cycles.getCycle(idOrKey);
    if (!cycle) return null;
    if (!GENERATED_STATUSES.has(cycle.status)) {
      return { cycle, skipped: "not-generated" };
    }
    const delivery = await this._deliver(cycle.id, { ttlMs });
    return { cycle: this._cycles.getCycle(cycle.id), delivery };
  }

  async _generate(cycle, { ttlMs } = {}) {
    this._cycles.setStatus(cycle.id, "generating");
    const alreadyGenerated = new Set((cycle.sectionsGenerated || []).map((entry) => entry.section));
    const failures = [];
    let generatedCount = alreadyGenerated.size;

    for (const section of this._sections) {
      if (alreadyGenerated.has(section)) continue;
      try {
        const report = await this._reporter.generateReport(ttlMs, section, "", { cycleId: cycle.id });
        if (report && report.configured === false) {
          throw Object.assign(new Error("Reporter is not configured"), { code: "missing_credentials" });
        }
        if (report && report.rateLimited) {
          throw Object.assign(new Error(report.error || "Reporter is rate-limited"), { status: 429 });
        }
        const content = report ? report[section] : "";
        if (!content) {
          throw Object.assign(new Error(`Reporter returned no content for section "${section}"`), { code: "empty_generation" });
        }

        const logged =
          typeof this._reporter.listGenerations === "function"
            ? this._reporter.listGenerations({ section, limit: 1 })[0] || null
            : null;
        this._cycles.recordSectionGenerated(cycle.id, {
          section,
          generatedAt:
            (report.generatedAtBySection && report.generatedAtBySection[section]) ||
            report.reusedGeneratedAt ||
            (logged && logged.generatedAt),
          model: (logged && logged.model) || report.reusedModel || this._reporter.model,
          promptHash: promptHash(logged && logged.prompt),
          hasCustomPrompt: Boolean(logged && logged.prompt),
          contentLength: String(content).length,
          reused: Boolean(report.generationSkipped),
          sources: (logged && logged.sources) || report.generatedSources || [],
          sourcesUnavailableReason:
            (logged && Array.isArray(logged.sources) && logged.sources.length) || (report.generatedSources || []).length
              ? null
              : "The provider response exposed no citations for this section.",
        });
        generatedCount += 1;
      } catch (err) {
        const classification = classifyFailure(err, { phase: "generation" });
        this._cycles.recordFailure(cycle.id, { phase: "generation", section, classification });
        failures.push({ section, classification });
        this._logger.error?.(`[Newsroom] ${cycle.id} generation failed for ${section}: ${classification.message}`);
      }
    }

    if (failures.length) {
      this._cycles.setStatus(cycle.id, "generation_failed");
      // By default a cycle missing an expected section is not delivered: a
      // digest that silently drops a category reads as a complete report to
      // everyone in the room. The next run of the same slot resumes and
      // generates only what is still missing, which is why the failure does
      // not have to be fatal to the cycle's report.
      //
      // With allowPartialDelivery on, what exists goes out anyway — but the
      // cycle can never reach "completed" while an expected section is
      // missing, so `incomplete` travels with it to delivery.
      if (!this._allowPartialDelivery || !generatedCount) {
        return { ok: false, generatedCount, failures };
      }
      return { ok: true, incomplete: true, generatedCount, failures };
    }

    this._cycles.setStatus(cycle.id, "generated");
    return { ok: true, generatedCount, failures };
  }

  async _deliver(cycleId, { ttlMs, incomplete = false } = {}) {
    const before = this._cycles.getCycle(cycleId);
    // Recomputed from the record rather than trusted from the caller, so a
    // delivery *retry* on an incomplete cycle stays partial too — the missing
    // section is still missing however the delivery got here.
    const generated = new Set(((before && before.sectionsGenerated) || []).map((entry) => entry.section));
    const missingSections = ((before && before.sectionsExpected) || []).filter((section) => !generated.has(section));
    const reportIncomplete = incomplete || missingSections.length > 0;

    this._cycles.setStatus(cycleId, "delivering");
    const peeked = this._reporter.peekReport(ttlMs);

    // Deliver only what *this* cycle generated. peekReport returns the latest
    // cached content per section, which can still hold yesterday's copy of a
    // section today's run failed to produce — sending that would attach a
    // receipt to a cycle that never generated it and publish stale copy under
    // today's date.
    const report = peeked && peeked.configured !== false
      ? this._sections.reduce(
          (carry, section) => (generated.has(section) ? carry : { ...carry, [section]: "" }),
          peeked,
        )
      : peeked;

    if (!report || report.configured === false || !this._sections.some((section) => report[section])) {
      this._cycles.recordFailure(cycleId, {
        phase: "delivery",
        classification: {
          class: "non_retryable",
          retryable: false,
          code: "nothing_to_send",
          status: null,
          message: "No generated report is available to deliver.",
          reason: "Delivery was asked for a report that does not exist. Generate the cycle's sections first.",
        },
      });
      this._cycles.setStatus(cycleId, "delivery_failed");
      return { ok: false, destinations: [], receipts: [] };
    }

    // continueOnError: one dead chat or topic must not cost the other
    // categories their delivery, and each failure is recorded against the
    // cycle with its own classification.
    const { receipts, destinations, failures } = await broadcastReportSections({
      report,
      telegramService: this._telegram,
      broadcastLedgerStore: this._ledger,
      cycleId,
      source: "dashboard",
      actor: "newsroom",
      continueOnError: true,
    });

    failures.forEach((failure) => {
      this._cycles.recordFailure(cycleId, {
        phase: "delivery",
        newsType: failure.newsType,
        section: failure.section,
        classification: classifyFailure(failure.error, { phase: "delivery" }),
      });
    });

    // A destination that came back "failed" is a delivery failure too, even
    // when the send call itself resolved.
    destinations
      .filter((destination) => destination.status === "failed")
      .forEach((destination) => {
        this._cycles.recordFailure(cycleId, {
          phase: "delivery",
          newsType: destination.newsType,
          classification: classifyFailure(
            Object.assign(new Error(destination.error || "Destination rejected the message"), {
              status: destination.statusCode || null,
            }),
            { phase: "delivery" },
          ),
        });
      });

    this._cycles.recordDelivery(cycleId, {
      receiptIds: receipts.map((receipt) => receipt && receipt.id).filter(Boolean),
      destinations,
    });

    const posted = destinations.filter(isPostedDestination);
    const failed = destinations.filter((destination) => destination.status === "failed");
    // A cycle delivering an incomplete report is partial even when every send
    // succeeded: "completed" has to mean the whole newsroom went out, or the
    // health panel reports a missing category as a clean run.
    const anyFailure = failures.length > 0 || failed.length > 0 || reportIncomplete;
    const status = posted.length
      ? anyFailure
        ? "delivery_partial"
        : "completed"
      : "delivery_failed";

    this._cycles.setStatus(cycleId, status);
    return { ok: status === "completed", status, destinations, receipts, posted: posted.length, failed: failed.length };
  }

  /**
   * Read-only operational status. Deliberately carries no credential, no
   * prompt body and no message text — only identifiers, counts, statuses and
   * the provider's own error message.
   */
  health({ windowLimit = 50, now = new Date() } = {}) {
    const cycles = this._cycles ? this._cycles.list({ limit: windowLimit }) : [];
    const lastAttempted = cycles[0] || null;
    const lastSuccessful = cycles.find((cycle) => cycle.status === "completed") || null;
    const current = cycles.find((cycle) => ACTIVE_STATUSES.has(cycle.status)) || null;

    const summarize = (cycle) => {
      if (!cycle) return null;
      const posted = (cycle.destinations || []).filter(isPostedDestination).length;
      const failed = (cycle.destinations || []).filter((destination) => destination.status === "failed").length;
      return {
        id: cycle.id,
        cycleKey: cycle.cycleKey,
        status: cycle.status,
        trigger: cycle.trigger,
        scheduledAt: cycle.scheduledAt,
        startedAt: cycle.startedAt,
        completedAt: cycle.completedAt,
        sectionsExpected: cycle.sectionsExpected,
        generatedSectionCount: (cycle.sectionsGenerated || []).length,
        deliverySucceeded: posted,
        deliveryFailed: failed,
        receiptIds: cycle.receiptIds || [],
      };
    };

    const lastError = cycles.map((cycle) => cycle.lastError).find(Boolean) || null;
    const agentRouteCheck = cycles
      .map((cycle) => (cycle.preflight?.checks || []).find((check) => check.name === "external-agent-route"))
      .find(Boolean) || null;

    return {
      status: current ? "running" : lastAttempted ? lastAttempted.status : "idle",
      reporter: {
        model: this._reporter ? this._reporter.model : null,
        configured: Boolean(this._reporter && this._reporter.configured),
      },
      telegramConfigured: Boolean(this._telegram && this._telegram.configured),
      sections: this.sections,
      currentCycle: summarize(current),
      lastAttemptedCycle: summarize(lastAttempted),
      lastSuccessfulCycle: summarize(lastSuccessful),
      nextExpectedRunAt: nextExpectedRun(this._expectedRunTimesUtc, now),
      lastError: lastError
        ? {
            at: lastError.at,
            phase: lastError.phase,
            class: lastError.class,
            retryable: lastError.retryable,
            code: lastError.code,
            message: lastError.message,
            reason: lastError.reason,
          }
        : null,
      counts: {
        cyclesInWindow: cycles.length,
        completed: cycles.filter((cycle) => cycle.status === "completed").length,
        generatedSections: cycles.reduce((total, cycle) => total + (cycle.sectionsGenerated || []).length, 0),
        deliverySucceeded: cycles.reduce(
          (total, cycle) => total + (cycle.destinations || []).filter(isPostedDestination).length,
          0,
        ),
        deliveryFailed: cycles.reduce(
          (total, cycle) => total + (cycle.destinations || []).filter((destination) => destination.status === "failed").length,
          0,
        ),
      },
      // Lifted out of the last preflight so a status panel can show the one
      // check nobody else can answer without digging into cycle detail.
      agentRoute: agentRouteCheck
        ? {
            status: agentRouteCheck.status,
            verified: agentRouteCheck.status === PASS,
            detail: agentRouteCheck.detail,
            code: agentRouteCheck.code || null,
          }
        : { status: WARN, verified: false, detail: UNCONFIGURED_DETAIL, code: null },
      allowPartialDelivery: this._allowPartialDelivery,
      lastPreflight: lastAttempted ? lastAttempted.preflight : null,
    };
  }
}

module.exports = { NewsroomService, nextExpectedRun, DEFAULT_SECTIONS, SECTION_TO_NEWS_TYPE };
