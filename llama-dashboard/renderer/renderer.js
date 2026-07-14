"use strict";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtNum(n, digits) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Maps js/llama-score.js's/llama-log-machine.js's internal `reason` codes
// (see inferOutcome() in either file) to plain-English labels, so the
// dashboard can show HOW a winner was decided, not just the verdict - the
// user asked for this specifically to be able to spot-check outcomes
// against their own memory of the game in real time.
const REASON_LABELS = {
  "post-war-reparations-enforced": "War reparations enforced (peace-treaty term)",
  "post-war-independence-granted": "Independence granted (peace-treaty term)",
  "post-war-land-transfer": "Land changed hands (clean 1-on-1 data)",
  "post-war-land-transfer-coalition": "Land changed hands (coalition-wide - less certain)",
  "battle-losses-inflicted": "Battle losses (no economic signal)",
  "last-known-war-score": "Last known in-game war score",
  "white-peace": "No decisive signal - treated as white peace",
  "war-disappeared-without-decisive-signal": "No signal before the war disappeared",
  unknown: "Unknown",
};
// Hover tooltips for the less-obvious reason codes.
const REASON_TOOLTIPS = {
  "post-war-land-transfer-coalition": "Land changed hands, but only measured across the whole side (including any vassals/allies dragged in) rather than just the war's original two declared belligerents - a real signal, just less precise than a clean 1-on-1 comparison.",
};
function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason || "Unknown";
}

// Maps js/llama-score.js's computeFromLedger() `autoExcludeReason` codes to
// plain-English tooltips - mirrors js/app.js's AUTO_EXCLUDE_TITLES (kept in
// sync deliberately) so the dashboard shows WHY a row is excluded, not just
// that it is. "player-hidden" is web-app-only (there's no Hide-player UI
// here yet) but included for forward compatibility if that's ever added.
const AUTO_EXCLUDE_TITLES = {
  "vs-ai": "No country on the opposing side was ever recorded as player-controlled - a fight against AI isn't a PvP result, so it's kept visible but doesn't score.",
  "vs-player": "The opposing side had a real player - this is a PvP war, so it isn't scored under PvE/Alpaca Points.",
  "player-departed": "This player had already stopped controlling this country (the recorder saw it revert to AI) before this war even began - a war they were actually playing when it started still counts, even if they later left partway through it.",
  "opponent-departed": "Every enemy in this war had already left the campaign before this war even began - a war fought against a real opponent still counts even if they left partway through it.",
  "player-hidden": "This player has been hidden as departed.",
  "no-battle-losses": "This country never recorded a Battle or Capture loss in this PvP war (attrition doesn't count) - joined but never actually fought.",
};
function autoExcludeLabel(reason) {
  return AUTO_EXCLUDE_TITLES[reason] ? reason.replace(/-/g, " ") : "excluded";
}
// War score/battle-losses/treasury/prestige never decide a winner on their
// own (see inferOutcome() in js/llama-score.js or llama-log-machine.js) -
// only an enforced reparations obligation, a granted independence, or a real
// land transfer can. The rest are attached to every outcome as
// contributingFactors so the reasoning stays auditable. Surfaced here as an
// extra tooltip line, and in full numeric detail via the "Full breakdown"
// dropdown (renderBreakdownDetail).
const CONTRIBUTING_FACTOR_LABELS = {
  "war-score": "war score",
  "battle-losses": "battle losses",
  "land-transfer": "land change",
  treasury: "treasury",
  prestige: "prestige",
  independence: "independence status",
};

// The game's own internal war-goal label (war.warName - see
// js/clausewitz.js's extractWarFields and test/debug-war-name.js). Not an
// exhaustive list of every value EU5 can produce (dynasty/region-specific
// flavor names exist too) - unrecognized values fall back to a de-snaked
// prettified version of the raw string rather than hiding the column.
const WAR_TYPE_LABELS = {
  NORMAL_WAR_NAME: "Conquest",
  INDEPENDENCE_WAR_NAME: "Independence",
  CIVIL_WAR_NAME: "Civil War",
  COALITION_WAR_NAME: "Coalition",
  CLAIM_THRONE_WAR_NAME: "Claim Throne",
  HUNDRED_YEARS_WAR_NAME: "Hundred Years' War",
  AGRESSION_WAR_NAME: "Aggression",
  COLONIAL_WAR_NAME: "Colonial",
  CRUSADE_WAR_NAME: "Crusade",
  EXCOM_WAR_NAME: "Excommunication",
  UNIFY_ILKHANATE_WAR_NAME: "Unify Ilkhanate",
  SHED_SHACKLES_OF_ILKHANATE_WAR_NAME: "Shed Ilkhanate Shackles",
  FALSE_ILKHAN_CLAIMANT_WAR_NAME: "False Ilkhan Claimant",
  CLAN_EXPANSION_WAR_NAME: "Clan Expansion",
  SENGOKU_WAR_NAME: "Sengoku",
  NANBOKUCHOU_WAR_NAME: "Nanbokuchou",
  ANNEXING_ME_WAR_NAME: "Annexation",
};
function warTypeLabel(warName) {
  if (!warName) return null;
  if (WAR_TYPE_LABELS[warName]) return WAR_TYPE_LABELS[warName];
  return warName
    .replace(/_WAR_NAME$/i, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function renderWarType(warName) {
  const label = warTypeLabel(warName);
  return label ? escapeHtml(label) : '<span class="note">-</span>';
}
function contributingFactorsNote(w) {
  const factors = w.contributingFactors || [];
  if (!factors.length) return "";
  const parts = factors.map((f) => `${CONTRIBUTING_FACTOR_LABELS[f.signal] || f.signal} leaned ${f.winnerSide}`);
  return `Considered but not decisive: ${parts.join("; ")}.`;
}
function reasonTooltip(w) {
  return [REASON_TOOLTIPS[w.reason] || "", contributingFactorsNote(w)].filter(Boolean).join(" ");
}
const CONFIDENCE_CLASS = { high: "confidence-high", medium: "confidence-medium", low: "confidence-low", unknown: "confidence-unknown" };

function countrySideLabel(entry) {
  const players = entry.players && entry.players.length ? escapeHtml(entry.players.join(", ")) + " " : "";
  return `${players}<span class="tag-badge">${escapeHtml(entry.tag)}</span>`;
}

// Same "leader (+N allies)" collapse Concluded Wars applies (see
// renderConcludedSide below) - an ongoing AI coalition war can list 20+
// belligerents on one side, which was rendering as one <li> per country
// (unreadable). A side with at least one real player still lists every
// player individually (a human shouldn't disappear into an ally count on
// their own war), just with its AI co-belligerents folded into a trailing
// count instead of a badge each.
function renderOngoingSide(entries) {
  if (!entries.length) return '<span class="note">-</span>';
  const real = entries.filter((e) => e.players && e.players.length);
  const ai = entries.filter((e) => !e.players || !e.players.length);
  if (!real.length) {
    const sorted = ai.slice().sort((a, b) => (b.locationCount || 0) - (a.locationCount || 0));
    const [leader, ...rest] = sorted;
    const alliesNote = rest.length > 0 ? ` <span class="note">(+${rest.length} ${rest.length === 1 ? "ally" : "allies"})</span>` : "";
    return `<span class="tag-badge">${escapeHtml(leader.tag)}</span>${alliesNote}`;
  }
  const alliesNote = ai.length > 0 ? ` <span class="note">(+${ai.length} allied ${ai.length === 1 ? "nation" : "nations"})</span>` : "";
  return `<ul class="side-list">${real
    .map((e, i) => `<li>${countrySideLabel(e)}${i === real.length - 1 ? alliesNote : ""}</li>`)
    .join("")}</ul>`;
}

function renderOngoingWars(mode, wars) {
  const el = document.querySelector(`#${mode}Section [data-field="ongoingWarsTable"]`);
  if (!el) return;
  if (!wars.length) {
    el.innerHTML = `<p class="note">No ongoing ${mode === "pve" ? "PvE" : "player-vs-player"} wars.</p>`;
    return;
  }
  const rows = wars
    .map(
      (w) => `
    <tr>
      <td>${escapeHtml(w.startDate || "-")}</td>
      <td>${renderWarType(w.warName)}</td>
      <td>${renderOngoingSide(w.attackers)}</td>
      <td>${renderOngoingSide(w.defenders)}</td>
    </tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr><th>Started</th><th>Type</th><th>Attacker(s)</th><th>Defender(s)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// A PvE war's opposing side has no real player row (see summarizeWars'
// aiSidePlaceholders) - those entries carry `isAiSide` + just a countryTag
// (already sorted biggest-nation-first, see labelAndSortByLocationCount in
// js/llama-score.js), no player/score. Collapsed to ONE line - "leader (+N
// allies)" - matching the style a real row's own allies get below, rather
// than a separate tag per AI country (which got unreadable fast on a real
// 10+-country coalition war). A real row's own `.A` (allies excluding self,
// already vassal-filtered for PvE) is called out inline too - otherwise
// "how many allies" has nowhere to show at all for a PvE row, since AI
// vassals correctly have no row/tag of their own.
function renderConcludedSide(participants) {
  if (!participants.length) return '<span class="note">-</span>';
  if (participants.every((r) => r.isAiSide)) {
    const [leader, ...rest] = participants;
    const alliesNote = rest.length > 0 ? ` <span class="note">(+${rest.length} ${rest.length === 1 ? "ally" : "allies"})</span>` : "";
    return `<span class="tag-badge">${escapeHtml(leader.countryTag || "?")}</span>${alliesNote}`;
  }
  const items = participants.map((r) => {
    const name = `${escapeHtml(r.player || "-")} <span class="tag-badge">${escapeHtml(r.countryTag || "?")}</span>`;
    const alliesNote = r.A > 0 ? ` <span class="note">(+${r.A} ${r.A === 1 ? "ally" : "allies"})</span>` : "";
    if (r.excluded) {
      const title = r.autoExcludeReason && AUTO_EXCLUDE_TITLES[r.autoExcludeReason];
      const noteAttrs = title ? ` title="${escapeHtml(title)}"` : "";
      return `<li>${name}${alliesNote} <span class="note"${noteAttrs}>(${escapeHtml(autoExcludeLabel(r.autoExcludeReason))})</span></li>`;
    }
    if (typeof r.warScore !== "number") return `<li>${name}${alliesNote} <span class="note">-</span></li>`;
    const cls = r.warScore > 0 ? "score-positive" : r.warScore < 0 ? "score-negative" : "score-neutral";
    const sign = r.warScore > 0 ? "+" : "";
    return `<li>${name}${alliesNote} <span class="${cls}">${sign}${fmtNum(r.warScore, 2)}</span></li>`;
  });
  return `<ul class="side-list">${items.join("")}</ul>`;
}

function renderResult(w) {
  if (w.whitePeace) return '<span class="result-whitepeace">White Peace</span>';
  if (w.winnerSide === "Attacker") return '<span class="result-attacker">Attacker won</span>';
  if (w.winnerSide === "Defender") return '<span class="result-defender">Defender won</span>';
  return '<span class="note">Unknown</span>';
}

// Which factors ever get consulted, in priority order (matches
// economicOutcomeSignal/inferOutcome in js/llama-score.js and
// llama-log-machine.js) - the first three are DECISIVE-eligible (only one of
// them can ever crown a winner), the rest are informational-only, shown for
// context but never trusted to pick a side by themselves.
const BREAKDOWN_FACTOR_ORDER = ["reparations", "independence", "land-transfer", "treasury", "prestige", "war-score", "battle-losses", "occupation"];
// Maps a war's decisive `reason` code back to which breakdown factor
// actually produced it, so that row can be visually marked as "this is what
// decided it" among the full list.
const DECISIVE_REASON_TO_FACTOR_KEY = {
  "post-war-reparations-enforced": "reparations",
  "post-war-independence-granted": "independence",
  "post-war-land-transfer": "land-transfer",
  "post-war-land-transfer-coalition": "land-transfer",
};

// Land transfer/treasury/prestige are real DELTAS (can be negative, "+/-"
// and red/green convey something true: which way it moved). War score/
// casualties/occupation are plain non-negative COUNTS at a point in time -
// giving them a "+" prefix or green coloring would falsely imply "this is a
// gain", when e.g. more casualties inflicted isn't a gain for the side that
// inflicted them, just a raw tally.
const BREAKDOWN_DELTA_KEYS = new Set(["land-transfer", "treasury", "prestige"]);
function fmtFactorValue(value, isDelta) {
  if (typeof value !== "number" || Number.isNaN(value)) return '<span class="note">-</span>';
  const digits = Number.isInteger(value) ? 0 : 2;
  if (!isDelta) return `<span>${fmtNum(value, digits)}</span>`;
  const cls = value > 0 ? "score-positive" : value < 0 ? "score-negative" : "score-neutral";
  const sign = value > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${fmtNum(value, digits)}</span>`;
}

// The full numeric account behind a war's outcome - every factor the engine
// looked at, decisive or not, with both sides' raw values and which way (if
// any) each one leans. Only ever built from w.breakdown (see inferOutcome's
// `breakdown` field in both scoring engines) - a war scored before this
// feature shipped simply has no breakdown data yet, same "can't retroactively
// improve already-recorded ledger data" limitation as every other fix this
// project has hit.
function renderBreakdownDetail(w) {
  const factors = w.breakdown || [];
  if (!factors.length) {
    return '<p class="note">No factor breakdown recorded for this war (scored before this feature shipped) - re-check once new wars conclude.</p>';
  }
  const decisiveKey = DECISIVE_REASON_TO_FACTOR_KEY[w.reason] || null;
  const rows = BREAKDOWN_FACTOR_ORDER.map((key) => factors.find((f) => f.key === key))
    .filter(Boolean)
    .map((f) => {
      const isDecider = f.key === decisiveKey;
      const tierNote = f.decisive ? '<span class="note">(decisive-eligible)</span>' : '<span class="note">(informational)</span>';
      const leanCell = f.winnerSide
        ? `<span class="${f.winnerSide === "Attacker" ? "result-attacker" : "result-defender"}">${escapeHtml(f.winnerSide)}</span>`
        : '<span class="note">-</span>';
      let attackerCell;
      let defenderCell;
      if (f.key === "reparations") {
        attackerCell = f.applies && f.winnerSide === "Defender" ? '<span class="score-negative">Paid</span>' : '<span class="note">-</span>';
        defenderCell = f.applies && f.winnerSide === "Attacker" ? '<span class="score-negative">Paid</span>' : '<span class="note">-</span>';
      } else if (f.key === "independence") {
        // The attacker is always the vassal fighting for independence (see
        // independenceSignal in js/llama-score.js/llama-log-machine.js) - so
        // winnerSide=Attacker means they broke free, winnerSide=Defender
        // means the overlord kept them subjugated.
        attackerCell = f.applies ? (f.winnerSide === "Attacker" ? '<span class="score-positive">Granted</span>' : '<span class="score-negative">Denied</span>') : '<span class="note">-</span>';
        defenderCell = f.applies ? (f.winnerSide === "Attacker" ? '<span class="score-negative">Lost vassal</span>' : '<span class="score-positive">Retained</span>') : '<span class="note">-</span>';
      } else {
        const isDelta = BREAKDOWN_DELTA_KEYS.has(f.key);
        attackerCell = fmtFactorValue(f.attackerValue, isDelta);
        defenderCell = fmtFactorValue(f.defenderValue, isDelta);
      }
      return `
        <tr class="${isDecider ? "factor-row-decisive" : ""}">
          <td>${escapeHtml(f.label)} ${tierNote}</td>
          <td class="num">${attackerCell}</td>
          <td class="num">${defenderCell}</td>
          <td>${leanCell}</td>
        </tr>`;
    })
    .join("");
  return `
    <table class="breakdown-table">
      <thead><tr><th>Factor</th><th>Attacker</th><th>Defender</th><th>Leans</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Only "War reparations", "Independence granted", and "Land transfer" can ever decide a winner - everything else is shown for context only. The highlighted row is what actually decided this war, if any.</p>`;
}

// Persists which wars' breakdown detail is expanded, per mode - a plain
// in-memory Set (not localStorage) since this is a "let me peek" UI action,
// not a durable preference, but it still needs to survive renderConcludedWars
// being called again every recorder tick (~5s) or the detail row would
// silently collapse itself out from under the user mid-read.
const expandedBreakdowns = { pvp: new Set(), pve: new Set() };

function verifiedKey(campaignKey, mode, warNumber) {
  return `eu5-llama-dashboard-verified:${campaignKey}:${mode}:${warNumber}`;
}
function isVerified(campaignKey, mode, warNumber) {
  return localStorage.getItem(verifiedKey(campaignKey, mode, warNumber)) === "1";
}
function setVerified(campaignKey, mode, warNumber, value) {
  const key = verifiedKey(campaignKey, mode, warNumber);
  if (value) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
}

let currentCampaignKey = null;
let isPinnedToCampaign = false;
let latestByMode = { pvp: [], pve: [] };

function renderConcludedWars(mode, wars) {
  const el = document.querySelector(`#${mode}Section [data-field="concludedWarsTable"]`);
  if (!el) return;
  latestByMode[mode] = wars;
  if (!wars.length) {
    el.innerHTML = `<p class="note">No concluded ${mode === "pve" ? "PvE" : "player-vs-player"} wars scored yet.</p>`;
    return;
  }
  const hideVerified = document.querySelector(`#${mode}Section [data-field="hideVerified"]`).checked;
  const sorted = wars.slice().sort((a, b) => String(b.endDate || "").localeCompare(String(a.endDate || "")));
  const visible = hideVerified ? sorted.filter((w) => !isVerified(currentCampaignKey, mode, w.warNumber)) : sorted;
  if (!visible.length) {
    el.innerHTML = '<p class="note">All wars checked off - uncheck "Hide checked-off wars" to see them again.</p>';
    return;
  }
  const expanded = expandedBreakdowns[mode];
  const rows = visible
    .map((w) => {
      const checked = isVerified(currentCampaignKey, mode, w.warNumber);
      const confClass = CONFIDENCE_CLASS[w.confidence] || CONFIDENCE_CLASS.unknown;
      const isOpen = expanded.has(w.warNumber);
      const mainRow = `
    <tr class="${checked ? "row-verified" : ""}">
      <td><input type="checkbox" class="verify-check" data-war="${w.warNumber}" ${checked ? "checked" : ""} title="Check off once you've confirmed this outcome"></td>
      <td>${escapeHtml(w.startDate || "-")}</td>
      <td>${escapeHtml(w.endDate || "-")}</td>
      <td>${renderWarType(w.warName)}</td>
      <td>${renderConcludedSide(w.attackers)}</td>
      <td>${renderConcludedSide(w.defenders)}</td>
      <td>${renderResult(w)}</td>
      <td>
        <span class="${confClass}" title="${escapeHtml(reasonTooltip(w))}">${escapeHtml(reasonLabel(w.reason))}</span>
        <button type="button" class="breakdown-toggle ${isOpen ? "open" : ""}" data-war="${w.warNumber}" title="Show the full numeric breakdown of every factor considered">${isOpen ? "▴" : "▾"}</button>
      </td>
    </tr>`;
      const detailRow = isOpen ? `<tr class="breakdown-detail-row"><td colspan="8">${renderBreakdownDetail(w)}</td></tr>` : "";
      return mainRow + detailRow;
    })
    .join("");
  el.innerHTML = `<table><thead><tr><th>✓</th><th>Started</th><th>Ended</th><th>Type</th><th>Attacker(s)</th><th>Defender(s)</th><th>Result</th><th>How decided</th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll(".verify-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      setVerified(currentCampaignKey, mode, cb.dataset.war, cb.checked);
      renderConcludedWars(mode, latestByMode[mode]);
    });
  });
  el.querySelectorAll(".breakdown-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const warNumber = Number(btn.dataset.war);
      if (expanded.has(warNumber)) expanded.delete(warNumber);
      else expanded.add(warNumber);
      renderConcludedWars(mode, latestByMode[mode]);
    });
  });
}

// PVE's points are relabeled "Alpaca Points" per the user's request - same
// underlying formula/field (leaderboard's llamaPoints, unchanged) as PVP's
// "Llama Points", just named differently so the two leaderboards are never
// confused for one another.
function pointsLabel(mode) {
  return mode === "pve" ? "Alpaca Points" : "Llama Points";
}

function renderLeaderboard(mode, leaderboard) {
  const el = document.querySelector(`#${mode}Section [data-field="leaderboardTable"]`);
  const heading = document.querySelector(`#${mode}Section [data-field="leaderboardHeading"]`);
  if (heading) heading.textContent = `${pointsLabel(mode)} Leaderboard`;
  if (!el) return;
  if (!leaderboard.length) {
    el.innerHTML = '<p class="note">No players found yet.</p>';
    return;
  }
  const rows = leaderboard
    .map(
      (p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.player)} <span class="tag-badge">${escapeHtml(p.countryTag || "?")}</span></td>
      <td>${fmtNum(p.llamaPoints, 2)}</td>
      <td>${p.wins}/${p.losses}/${p.draws}</td>
    </tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr><th>#</th><th>Player</th><th>${escapeHtml(pointsLabel(mode))}</th><th>W/L/D</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function applyModeSection(mode, section) {
  document.querySelector(`#${mode}Section [data-field="statOngoing"]`).textContent = section.ongoingWars.length;
  document.querySelector(`#${mode}Section [data-field="statConcluded"]`).textContent = section.concludedWars.length;
  document.querySelector(`#${mode}Section [data-field="statWhitePeace"]`).textContent = section.whitePeaceCount || 0;
  document.querySelector(`#${mode}Section [data-field="statUnscoreable"]`).textContent = section.unscoreableCount || 0;
  renderOngoingWars(mode, section.ongoingWars);
  renderConcludedWars(mode, section.concludedWars);
  renderLeaderboard(mode, section.leaderboard);
}

function applyUpdate(payload) {
  const statusEl = document.getElementById("statusBadge");
  const campaignLine = document.getElementById("campaignLine");

  if (payload.lastError) {
    statusEl.textContent = "Scan error";
    statusEl.className = "status-badge status-error";
  } else if (!payload.campaignKey) {
    statusEl.textContent = "Waiting for a save...";
    statusEl.className = "status-badge status-warn";
  } else if (payload.isPinned) {
    statusEl.textContent = "Viewing past campaign";
    statusEl.className = "status-badge status-warn";
  } else {
    statusEl.textContent = "Watching";
    statusEl.className = "status-badge status-ok";
  }

  currentCampaignKey = payload.campaignKey;
  isPinnedToCampaign = !!payload.isPinned;

  if (payload.campaignKey) {
    const when = payload.capturedAt ? new Date(payload.capturedAt).toLocaleTimeString() : "-";
    campaignLine.textContent =
      `${payload.playthroughName || "Campaign"} (${payload.campaignKey}) - in-game date ${payload.date || "?"} - ` +
      `last recorder update ${when} - ${payload.snapshotCount || 0} snapshot(s), ${payload.eventCount || 0} event(s)` +
      (payload.isPinned ? " - pinned, won't auto-switch to a newer campaign" : "");
  } else {
    campaignLine.textContent = `Watching ${payload.config ? payload.config.saveDir : ""} - no autosave found yet.`;
  }

  if (payload.pvp) applyModeSection("pvp", payload.pvp);
  if (payload.pve) applyModeSection("pve", payload.pve);

  const logPane = document.getElementById("logPane");
  const wasScrolledToEnd = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
  logPane.textContent = (payload.log || []).map((l) => `[${l.at.slice(11, 19)}] ${l.line}`).join("\n");
  if (wasScrolledToEnd) logPane.scrollTop = logPane.scrollHeight;
}

// --- tab switching + per-mode section setup (both sections are cloned from
// one <template>, so the ongoing/concluded/leaderboard markup only needs to
// be written once) ---

const template = document.getElementById("modeSectionTemplate");
["pvp", "pve"].forEach((mode) => {
  const section = document.getElementById(`${mode}Section`);
  section.appendChild(template.content.cloneNode(true));
  section.querySelector('[data-field="hideVerified"]').addEventListener("change", () => renderConcludedWars(mode, latestByMode[mode]));
});

document.querySelectorAll(".mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b === btn));
    const mode = btn.dataset.mode;
    document.getElementById("pvpSection").classList.toggle("hidden", mode !== "pvp");
    document.getElementById("pveSection").classList.toggle("hidden", mode !== "pve");
  });
});

const logToggle = document.getElementById("logToggle");
logToggle.addEventListener("click", () => {
  const pane = document.getElementById("logPane");
  const chevron = logToggle.querySelector(".chevron");
  pane.classList.toggle("hidden");
  chevron.classList.toggle("open");
});

// --- campaigns dialog (browse/pick a past campaign, or go back to Auto) ---

function fmtCampaignDate(c) {
  const when = c.capturedAt ? new Date(c.capturedAt).toLocaleString() : null;
  if (c.date && when) return `in-game ${c.date} - last recorded ${when}`;
  if (c.date) return `in-game ${c.date}`;
  if (when) return `last recorded ${when}`;
  return "no snapshots yet";
}

async function renderCampaignsList() {
  const wrap = document.getElementById("campaignsListWrap");
  wrap.innerHTML = '<p class="note">Loading...</p>';
  const campaigns = await window.llamaAPI.listCampaigns();
  const autoRow = `
    <tr class="campaign-row ${!isPinnedToCampaign ? "current" : ""}" data-key="">
      <td>${!isPinnedToCampaign ? "&#9654;" : ""}</td>
      <td><strong>Auto (Latest)</strong></td>
      <td colspan="2" class="note">Always follows whatever the recorder is currently watching live</td>
    </tr>`;
  const rows = campaigns
    .map((c) => {
      const isCurrent = isPinnedToCampaign && c.campaignKey === currentCampaignKey;
      return `
    <tr class="campaign-row ${isCurrent ? "current" : ""}" data-key="${escapeHtml(c.campaignKey)}">
      <td>${isCurrent ? "&#9654;" : ""}</td>
      <td>${escapeHtml(c.playthroughName || "Unnamed campaign")}</td>
      <td class="note">${escapeHtml(c.campaignKey)}</td>
      <td class="note">${escapeHtml(fmtCampaignDate(c))}</td>
    </tr>`;
    })
    .join("");
  wrap.innerHTML = `<table><thead><tr><th></th><th>Campaign</th><th>Key</th><th>Status</th></tr></thead><tbody>${autoRow}${rows}</tbody></table>`;
  wrap.querySelectorAll(".campaign-row").forEach((row) => {
    row.addEventListener("click", async () => {
      await window.llamaAPI.selectCampaign(row.dataset.key || null);
      document.getElementById("campaignsDialog").close();
    });
  });
}

const campaignsDialog = document.getElementById("campaignsDialog");
document.getElementById("campaignsBtn").addEventListener("click", () => {
  campaignsDialog.showModal();
  renderCampaignsList();
});
document.getElementById("campaignsClose").addEventListener("click", () => campaignsDialog.close());

// --- settings dialog ---

const settingsDialog = document.getElementById("settingsDialog");
document.getElementById("settingsBtn").addEventListener("click", async () => {
  const settings = await window.llamaAPI.getSettings();
  // Only pre-fill the input with an EXPLICIT override the user actually set
  // before - the auto-computed default is shown as a placeholder hint
  // instead, so simply opening this dialog and clicking Save (without typing
  // anything) no longer permanently pins that value (see main.js's
  // settings:get/settings:save comments for the bug this used to cause).
  const saveDirInput = document.getElementById("saveDirInput");
  const dataDirInput = document.getElementById("dataDirInput");
  saveDirInput.value = settings.saveDir || "";
  saveDirInput.placeholder = settings.defaultSaveDir || "";
  dataDirInput.value = settings.dataDir || "";
  dataDirInput.placeholder = settings.defaultDataDir || "";
  settingsDialog.showModal();
});
document.getElementById("settingsCancel").addEventListener("click", () => settingsDialog.close());
document.getElementById("pickSaveDir").addEventListener("click", async () => {
  const input = document.getElementById("saveDirInput");
  const picked = await window.llamaAPI.pickFolder(input.value || input.placeholder);
  if (picked) input.value = picked;
});
document.getElementById("pickDataDir").addEventListener("click", async () => {
  const input = document.getElementById("dataDirInput");
  const picked = await window.llamaAPI.pickFolder(input.value || input.placeholder);
  if (picked) input.value = picked;
});
document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await window.llamaAPI.saveSettings({
    saveDir: document.getElementById("saveDirInput").value.trim(),
    dataDir: document.getElementById("dataDirInput").value.trim(),
  });
  settingsDialog.close();
});

window.llamaAPI.onUpdate(applyUpdate);
