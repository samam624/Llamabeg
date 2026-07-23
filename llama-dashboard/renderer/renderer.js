"use strict";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtNum(n, digits) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function prettifyId(value) {
  return String(value || "-")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtModifierValue(value) {
  if (typeof value !== "number") return "unresolved";
  const percent = value * 100;
  return `${percent > 0 ? "+" : ""}${percent.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
}

function fmtMonthlyValue(value) {
  if (typeof value !== "number") return "unresolved";
  return `${value > 0 ? "+" : ""}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}/month`;
}

function fmtSourceValue(source) {
  return source && source.valueFormat === "monthly_points" ? fmtMonthlyValue(source.resolvedValue) : fmtModifierValue(source && source.resolvedValue);
}

// Maps js/llama-score.js's/llama-log-machine.js's internal `reason` codes
// (see inferOutcome() in either file) to plain-English labels, so the
// dashboard can show HOW a winner was decided, not just the verdict - the
// user asked for this specifically to be able to spot-check outcomes
// against their own memory of the game in real time.
const REASON_LABELS = {
  "post-war-reparations-enforced": "War reparations enforced (peace-treaty term)",
  "post-war-independence-granted": "Independence granted (peace-treaty term)",
  "post-war-revolt-crushed": "Rebellion fully crushed (annexed/reabsorbed)",
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
// that it is. "player-hidden" is set via this dashboard's own Hide button on
// the leaderboard (writes hidden-players.json in the campaign folder, shared
// with the web app - see main.js's players:hide handler) or the web app's
// own manual Hide list.
const AUTO_EXCLUDE_TITLES = {
  "vs-ai": "No country on the opposing side was ever recorded as player-controlled - a fight against AI isn't a PvP result, so it's kept visible but doesn't score.",
  "vs-player": "The opposing side had a real player - this is a PvP war, so it isn't scored under PvE/Alpaca Points.",
  "player-departed": "This player had already stopped controlling this country (the recorder saw it revert to AI) before this war even began - a war they were actually playing when it started still counts, even if they later left partway through it.",
  "opponent-departed": "Every enemy in this war had already left the campaign before this war even began - a war fought against a real opponent still counts even if they left partway through it.",
  "player-hidden": "This player was marked departed - wars that started before that point still count, only later ones are excluded.",
  revolt: "This is a revolt (independence war or civil war) against your own rebels/pretender, not a fight against a foreign AI nation - the winner is still tracked correctly, but it never moves PVE/Alpaca Points either direction.",
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
// Raw in-game location IDs behind the "Land transfer" row's numbers (see
// llama-log-machine.js's locationSetDelta/principalFieldUnion) - only
// populated for wars recorded after that data model existed, null for
// older ones. No province-name lookup exists in this pipeline yet, so
// these are the game's own internal numeric IDs, capped to the first 20
// per list so a big conquest doesn't dump an unreadable wall of numbers.
function fmtLocationIds(ids) {
  const shown = ids.slice(0, 20).join(", ");
  return ids.length > 20 ? `${shown}, +${ids.length - 20} more` : shown;
}
function renderLocationExchangeDetail(landFactor) {
  if (!landFactor) return "";
  const rows = [
    ["Attacker gained", landFactor.attackerLocationsGained],
    ["Attacker lost", landFactor.attackerLocationsLost],
    ["Defender gained", landFactor.defenderLocationsGained],
    ["Defender lost", landFactor.defenderLocationsLost],
  ].filter(([, ids]) => Array.isArray(ids) && ids.length);
  if (!rows.length) return "";
  const items = rows.map(([label, ids]) => `<li class="note">${escapeHtml(label)} ${ids.length} location(s): ${escapeHtml(fmtLocationIds(ids))}</li>`).join("");
  return `
    <p class="note"><strong>Locations exchanged</strong> (raw in-game location IDs, no name lookup yet):</p>
    <ul class="location-exchange-list">${items}</ul>`;
}

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
    <p class="note">Only "War reparations", "Independence granted", and "Land transfer" can ever decide a winner - everything else is shown for context only. The highlighted row is what actually decided this war, if any.</p>
    ${renderLocationExchangeDetail(factors.find((f) => f.key === "land-transfer"))}`;
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
let latestLeaderboardByMode = { pvp: [], pve: [] };

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

// A `hidden` row (see js/llama-score.js's computeFromLedger - a player
// marked departed via the Hide button below) is collapsed out of the
// DEFAULT view but never dropped from the underlying array - their
// llamaPoints/W-L-D here still reflect everything they actually earned or
// lost while genuinely active (only wars that started after their marked
// departure date get excluded from the total), so revealing them via "Show
// departed players" shows the real number, not a zeroed-out placeholder.
function renderLeaderboard(mode, leaderboard) {
  const el = document.querySelector(`#${mode}Section [data-field="leaderboardTable"]`);
  const heading = document.querySelector(`#${mode}Section [data-field="leaderboardHeading"]`);
  if (heading) heading.textContent = `${pointsLabel(mode)} Leaderboard`;
  if (!el) return;
  latestLeaderboardByMode[mode] = leaderboard;
  if (!leaderboard.length) {
    el.innerHTML = '<p class="note">No players found yet.</p>';
    return;
  }
  const showDepartedEl = document.querySelector(`#${mode}Section [data-field="showDeparted"]`);
  const showDeparted = showDepartedEl ? showDepartedEl.checked : false;
  const visible = showDeparted ? leaderboard : leaderboard.filter((p) => !p.hidden);
  if (!visible.length) {
    el.innerHTML = '<p class="note">Every player here has been hidden as departed - check "Show departed players" to see them again.</p>';
    return;
  }
  const rows = visible
    .map((p, i) => {
      const departedTitle = p.hiddenSince ? `Hidden as of ${escapeHtml(p.hiddenSince)}` : "Hidden";
      return `
    <tr class="${p.hidden ? "row-departed" : ""}">
      <td>${i + 1}</td>
      <td>${escapeHtml(p.player)} <span class="tag-badge">${escapeHtml(p.countryTag || "?")}</span>${p.hidden ? ` <span class="departed-badge" title="${departedTitle}">departed</span>` : ""}</td>
      <td>${fmtNum(p.llamaPoints, 2)}</td>
      <td>${p.wins}/${p.losses}/${p.draws}</td>
      <td><button type="button" class="btn-secondary btn-small hide-player-btn" data-player="${escapeHtml(p.player)}" data-hidden="${p.hidden ? "1" : "0"}">${p.hidden ? "Unhide" : "Hide"}</button></td>
    </tr>`;
    })
    .join("");
  el.innerHTML = `<table><thead><tr><th>#</th><th>Player</th><th>${escapeHtml(pointsLabel(mode))}</th><th>W/L/D</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll(".hide-player-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const name = btn.dataset.player;
      // main.js's players:hide/unhide handlers call pushUpdate() themselves
      // right after writing hidden-players.json, which re-renders this
      // table with the real, freshly-scored result - no local optimistic
      // re-render needed here.
      if (btn.dataset.hidden === "1") await window.llamaAPI.unhidePlayer(name);
      else await window.llamaAPI.hidePlayer(name);
    });
  });
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
  if (Object.prototype.hasOwnProperty.call(payload, "modifierContext")) applyModifierContext(payload.modifierContext);

  const logPane = document.getElementById("logPane");
  const wasScrolledToEnd = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
  logPane.textContent = (payload.log || []).map((l) => `[${l.at.slice(11, 19)}] ${l.line}`).join("\n");
  if (wasScrolledToEnd) logPane.scrollTop = logPane.scrollHeight;
}

let latestModifierContext = null;
let latestSocietalAxes = [];
let societalAxesError = null;
let latestModifierCatalog = [];

// The Value Optimizer and Modifier Optimizer are now separate tabs, but both
// read the same recorder ledger snapshot - each has its own "Player country"
// select (so choosing a country in one doesn't affect the other), keyed by
// select element id.
function selectedCountry(selectId) {
  const countries = latestModifierContext && Array.isArray(latestModifierContext.playerCountries) ? latestModifierContext.playerCountries : [];
  const selected = document.getElementById(selectId).value;
  return countries.find((country) => String(country.number) === selected) || countries[0] || null;
}

function selectedSocietalAxis() {
  const key = document.getElementById("societalValueAxis").value;
  return latestSocietalAxes.find((axis) => axis.axisKey === key) || null;
}

function fmtImpactValue(value) {
  if (typeof value !== "number") return "unresolved";
  if (Math.abs(value) <= 2) return fmtModifierValue(value);
  return `${value > 0 ? "+" : ""}${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}`;
}

function renderSocietalCurrent(country, axis) {
  const el = document.getElementById("societalValueCurrent");
  if (!country || !country.hasSocietalValues) {
    el.innerHTML = "Societal-value positions are not present in this ledger snapshot. Let the recorder capture one new autosave.";
    return;
  }
  if (!axis || typeof country.societalValues[axis.axisKey] !== "number") {
    el.innerHTML = societalAxesError
      ? escapeHtml(societalAxesError)
      : "This is a later-age societal value, so the current position is not active yet. Its game-file sources can still be inspected and planned for.";
    return;
  }

  const value = country.societalValues[axis.axisKey];
  const clamped = Math.max(-100, Math.min(100, value));
  const side = value < 0 ? "left" : value > 0 ? "right" : null;
  const sideId = side ? axis[`${side}Id`] : null;
  const strength = Math.abs(value) / 100;
  const impactRows = side
    ? (axis[`${side}Impact`] || [])
        .filter((impact) => typeof impact.resolvedValue === "number")
        .map((impact) => `<li><span>${escapeHtml(prettifyId(impact.modifier))}</span><strong>${escapeHtml(fmtImpactValue(impact.resolvedValue * strength))}</strong></li>`)
        .join("")
    : "";
  const positionText = side ? `${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} toward ${prettifyId(sideId)}` : "Balanced at 0";
  el.innerHTML = `
    <div class="societal-axis-labels"><strong>${escapeHtml(prettifyId(axis.leftId))}</strong><span>${escapeHtml(positionText)}</span><strong>${escapeHtml(prettifyId(axis.rightId))}</strong></div>
    <div class="societal-axis-track"><span class="societal-axis-center"></span><span class="societal-axis-marker" style="left:${(clamped + 100) / 2}%"></span></div>
    <div class="societal-impact"><strong>Current impact</strong>${impactRows ? `<ul>${impactRows}</ul>` : '<span class="note"> No directional bonuses at the center.</span>'}</div>`;
}

function updateSocietalDirection(preferCurrentSide) {
  const axis = selectedSocietalAxis();
  const country = selectedCountry("valueOptimizerCountry");
  const select = document.getElementById("societalValueDirection");
  const previous = select.value;
  if (!axis) {
    select.innerHTML = '<option value="">No direction available</option>';
    return;
  }
  select.innerHTML = `<option value="left">${escapeHtml(prettifyId(axis.leftId))}</option><option value="right">${escapeHtml(prettifyId(axis.rightId))}</option>`;
  const value = country && country.societalValues && country.societalValues[axis.axisKey];
  const currentSide = typeof value === "number" && value < 0 ? "left" : "right";
  select.value = preferCurrentSide ? currentSide : previous === "left" || previous === "right" ? previous : currentSide;
  renderSocietalCurrent(country, axis);
}

function updateSocietalAxes(country, forceDirection) {
  const select = document.getElementById("societalValueAxis");
  const previous = select.value;
  const values = country && country.societalValues && typeof country.societalValues === "object" ? country.societalValues : {};
  const applicable = latestSocietalAxes.filter((axis) => Object.prototype.hasOwnProperty.call(values, axis.axisKey));
  const future = latestSocietalAxes.filter((axis) => !Object.prototype.hasOwnProperty.call(values, axis.axisKey));
  select.innerHTML = latestSocietalAxes.length
    ? `${applicable.length ? `<optgroup label="Active now">${applicable.map((axis) => `<option value="${escapeHtml(axis.axisKey)}">${escapeHtml(prettifyId(axis.leftId))} vs ${escapeHtml(prettifyId(axis.rightId))}</option>`).join("")}</optgroup>` : ""}${future.length ? `<optgroup label="Later ages / not active yet">${future.map((axis) => `<option value="${escapeHtml(axis.axisKey)}">${escapeHtml(prettifyId(axis.leftId))} vs ${escapeHtml(prettifyId(axis.rightId))}</option>`).join("")}</optgroup>` : ""}`
    : `<option value="">${societalAxesError ? "Could not read game definitions" : latestSocietalAxes.length ? "No applicable axes recorded" : "Loading societal values..."}</option>`;
  const axisStillValid = latestSocietalAxes.some((axis) => axis.axisKey === previous);
  if (axisStillValid) select.value = previous;
  // Only snap "Push toward" back to the axis's current-leaning side on a
  // genuine user action (country/axis change) or when the previous axis
  // selection no longer exists. A routine background poll tick (~every
  // 5s, see main.js's tick()/pushUpdate()) must not silently discard a
  // direction the user deliberately chose - it used to call this with an
  // implicit "always force" and reset the dropdown out from under the user
  // mid-session even when nothing they picked had actually changed.
  updateSocietalDirection(forceDirection || !axisStillValid);
  document.getElementById("societalValueAnalyze").disabled = !country || !country.hasSocietalDynamics || !latestSocietalAxes.length;
}

function modifierStateNoteText(selected, context) {
  if (!selected) return "Waiting for the recorder to capture a player-controlled country.";
  if (!selected.hasModifierState) return "This ledger snapshot predates modifier-state tracking. Let the recorder capture one new autosave, then try again.";
  if (!selected.hasEligibilityFacts) return "Choice state is available, but eligibility facts were added later. Let the recorder capture one new autosave for the most accurate result.";
  if (!selected.hasSocietalValues) return "Eligibility facts are available, but societal-value positions need one newly captured autosave.";
  if (!selected.hasSocietalDynamics) return "Societal positions are available, but equilibrium inputs are being refreshed from the latest autosave.";
  return `Eligibility and societal-value facts captured on ${context.date || "the latest autosave"}.`;
}

function populateCountrySelect(selectId, noteId, context) {
  const select = document.getElementById(selectId);
  const previous = select.value;
  const countries = context && Array.isArray(context.playerCountries) ? context.playerCountries : [];
  select.innerHTML = countries.length
    ? countries
        .map((country) => {
          const players = country.players && country.players.length ? ` - ${country.players.join(", ")}` : "";
          return `<option value="${country.number}">${escapeHtml(country.tag || "?")}${escapeHtml(players)}</option>`;
        })
        .join("")
    : '<option value="">No player country recorded</option>';
  if (countries.some((country) => String(country.number) === previous)) select.value = previous;

  const selected = countries.find((country) => String(country.number) === select.value) || countries[0];
  document.getElementById(noteId).textContent = modifierStateNoteText(selected, context);
  return selected;
}

function applyModifierContext(context) {
  latestModifierContext = context;
  const valueCountry = populateCountrySelect("valueOptimizerCountry", "valueOptimizerStateNote", context);
  updateSocietalAxes(valueCountry);
  populateCountrySelect("modifierOptimizerCountry", "modifierOptimizerStateNote", context);
}

function modifierSourceName(source) {
  if (source.displayName) return source.displayName;
  if ((source.folder === "laws" || source.folder === "gods") && source.choice) return prettifyId(source.choice);
  if (source.folder === "subject_types") return `${prettifyId(source.entity)} Subjects${source.sourceCount > 1 ? ` x${source.sourceCount}` : ""}`;
  return prettifyId(source.entity || source.bundleId);
}

function modifierSourcePath(source) {
  if (source.formulaDetail) return source.formulaDetail;
  if (source.automaticFormula) {
    const scale = source.automaticFormula.scalesWith;
    return scale ? `Automatic game formula - scales with ${JSON.stringify(scale)}` : "Automatic game formula";
  }
  if (source.folder === "estate_privileges" && source.estate) return `${source.estateLabel || prettifyId(source.estate)} privilege`;
  // Unlike a law swap, we can't yet tell which omen (if any) is already
  // active for this god - see classifyDynamicSource()'s comment in
  // js/modifier-finder.js - so this is flagged as unverified rather than
  // claimed as a clean "replace X" recommendation.
  if (source.folder === "gods" && source.choice) return `${prettifyId(source.entity)} omen - current selection not tracked, may already be active`;
  if (source.folder !== "laws" || !source.choice) return "";
  const category = source.eligibility && source.eligibility.lawCategory;
  const parts = [];
  if (category) parts.push(`${prettifyId(category)} Laws`);
  parts.push(prettifyId(source.entity), prettifyId(source.choice));
  return parts.join(" → ");
}

const modifierCategoryOrder = ["advances", "laws", "government_reforms", "estate_privileges", "gods", "character_traits", "societal_values", "subject_types", "dynamic_country_state", "events", "missions", "decisions", "actions", "situations", "scripted", "other"];

function modifierDurationLabel(duration) {
  if (!duration || typeof duration.value !== "number") return "duration controlled by script";
  if (duration.value < 0) return "until removed by game script";
  const unit = duration.value === 1 ? String(duration.unit || "day").replace(/s$/, "") : duration.unit || "days";
  return `${duration.value} ${unit}`;
}

function modifierGrantorSummary(source) {
  const grantors = Array.isArray(source.grantors) ? source.grantors : [];
  if (!grantors.length) return "No direct grant was found in the currently installed game scripts.";
  return grantors
    .map((grantor) => `${prettifyId(grantor.entity || "scripted grant")}${grantor.file ? ` [${grantor.file}]` : ""} (${modifierDurationLabel(grantor.duration)})`)
    .join("; ");
}

function renderModifierRows(rows, includeStatus) {
  if (!rows.length) return '<p class="note">None found.</p>';
  const estatePrivileges = rows.every((source) => source.folder === "estate_privileges");
  const body = rows
    .map((source, index) => {
      let status = "";
      if (includeStatus) {
        const reason = source.eligibilityReasons && source.eligibilityReasons[0];
        if (source.category === "events") status = `Informational only - event-granted; ${modifierGrantorSummary(source)}`;
        else if (source.informationalOnly) status = `Informational only - excluded from optimizer; ${modifierGrantorSummary(source)}`;
        else if (source.eligibilityState === "eligible") {
          status = source.folder === "laws" && source.currentChoice ? `Eligible now - replace ${prettifyId(source.currentChoice)}` : "Eligible now";
        } else if (source.eligibilityState === "blocked") status = `Blocked${reason ? ` - ${reason}` : ""}`;
        else status = `Unknown${reason ? ` - ${reason}` : ""}`;
      }
      const sourcePath = modifierSourcePath(source);
      return `<tr>
        <td>${escapeHtml(source.categoryLabel || prettifyId(source.folder || "indirect bundle"))}</td>
        <td>${estatePrivileges ? `<span class="source-rank">#${index + 1}</span>` : ""}<strong>${escapeHtml(modifierSourceName(source))}</strong>${sourcePath ? `<div class="source-path">${escapeHtml(sourcePath)}</div>` : ""}<div class="source-id">${escapeHtml(source.choice || source.entity || source.bundleId || "")}</div></td>
        <td class="modifier-value">${escapeHtml(fmtSourceValue(source))}</td>
        ${estatePrivileges ? `<td class="estate-power-cost">${escapeHtml(typeof source.estatePowerCost === "number" ? fmtModifierValue(source.estatePowerCost) : "Unknown")}</td>` : ""}
        ${includeStatus ? `<td>${escapeHtml(status)}</td>` : ""}
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>System</th><th>Source</th><th>Effect</th>${estatePrivileges ? "<th>Estate power cost</th>" : ""}${includeStatus ? "<th>Status</th>" : ""}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderEstatePrivilegeGroups(rows, includeStatus) {
  const estates = new Map();
  for (const source of rows) {
    const key = source.estate || "unknown_estate";
    if (!estates.has(key)) estates.set(key, []);
    estates.get(key).push(source);
  }
  return [...estates.entries()]
    .sort((a, b) => String(a[1][0].estateLabel || a[0]).localeCompare(String(b[1][0].estateLabel || b[0])))
    .map(([estate, sources]) => {
      sources.sort((a, b) => {
        const aCost = typeof a.estatePowerCost === "number" ? a.estatePowerCost : Infinity;
        const bCost = typeof b.estatePowerCost === "number" ? b.estatePowerCost : Infinity;
        return aCost - bCost || (b.resolvedValue || 0) - (a.resolvedValue || 0) || modifierSourceName(a).localeCompare(modifierSourceName(b));
      });
      const label = sources[0].estateLabel || prettifyId(estate);
      return `<h5 class="estate-heading">${escapeHtml(label)} (${sources.length})</h5>${renderModifierRows(sources, includeStatus)}`;
    })
    .join("");
}

function renderModifierGroups(rows, includeStatus) {
  if (!rows.length) return '<p class="note">None found.</p>';
  const groups = new Map();
  for (const source of rows) {
    const key = source.category || source.folder || "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const ai = modifierCategoryOrder.indexOf(a[0]);
    const bi = modifierCategoryOrder.indexOf(b[0]);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a[0].localeCompare(b[0]);
  });
  return ordered
    .map(([category, sources]) => `<h4>${escapeHtml(sources[0].categoryLabel || prettifyId(sources[0].folder || "other"))} (${sources.length})</h4>${category === "estate_privileges" ? `<p class="note estate-ranking-note">Grouped by estate and ranked by lowest estate-power cost.</p>${renderEstatePrivilegeGroups(sources, includeStatus)}` : renderModifierRows(sources, includeStatus)}`)
    .join("");
}

function renderModifierReport(report, societal) {
  const results = document.getElementById(societal ? "valueOptimizerResults" : "modifierResults");
  const countryLabel = report.country ? `${report.country.tag || "?"}${report.country.players.length ? ` - ${report.country.players.join(", ")}` : ""}` : "No country state";
  const title = societal ? `Push toward ${prettifyId(societal.directionId)}` : prettifyId(report.modifierKey);
  const contribution = report.valueFormat === "monthly_points" ? fmtMonthlyValue(report.knownActiveContribution) : fmtModifierValue(report.knownActiveContribution);
  const activeEstateNote =
    report.country && Array.isArray(report.country.activeEstates)
      ? `Active estates: <strong>${escapeHtml(report.country.activeEstates.map((estate) => estate.label || prettifyId(estate.id)).join(", ") || "None")}</strong>. Estate privileges for inactive estates are excluded from Eligible actions now.`
      : "Active estates could not be verified from this snapshot, so estate privileges are withheld from Eligible actions now until a fresh autosave is captured.";
  let contributionNote;
  if (societal) {
    const equilibrium = societal.equilibrium;
    const equilibriumText = equilibrium.position < 0.000001 ? "centered at 0" : `${equilibrium.position.toLocaleString(undefined, { maximumFractionDigits: 2 })} toward ${prettifyId(equilibrium.directionId)}`;
    contributionNote =
      `Confirmed active push: <strong>${escapeHtml(fmtMonthlyValue(equilibrium.selectedRate))}</strong> toward ${escapeHtml(prettifyId(societal.directionId))} ` +
      `minus <strong>${escapeHtml(fmtMonthlyValue(equilibrium.opposingRate))}</strong> toward ${escapeHtml(prettifyId(societal.opposingDirectionId))}. ` +
      `The net is <strong>${escapeHtml(fmtMonthlyValue(Math.abs(equilibrium.netRate)))}</strong> toward ${escapeHtml(prettifyId(equilibrium.directionId))}, ` +
      `giving an equilibrium of <strong>${escapeHtml(equilibriumText)}</strong>. Active sources come from the snapshot; automatic engine scalars that EU5 does not serialize exactly are explicitly labeled as save-backed estimates, and temporary sources are excluded.`;
  } else {
    contributionNote = `Confirmed active contribution from modeled sources: <strong>${escapeHtml(contribution)}</strong>. Event-granted modifiers are temporary/informational and are excluded from this optimizer total.`;
  }
  results.innerHTML = `
    <div class="panel-header"><h2>${escapeHtml(title)}</h2><span class="tag-badge">${escapeHtml(countryLabel)}</span></div>
    <p class="note">${contributionNote}</p>
    <p class="note">${activeEstateNote}</p>
    <h3>Eligible actions now</h3>
    <p class="note">Ranked positive actions whose captured game requirements pass for this country. This checks eligibility, not whether you currently have enough points or currency to pay the action cost.</p>
    ${renderModifierGroups(report.recommendations, true)}
    <details><summary>Blocked actions (${report.blockedSources.length})</summary>${renderModifierGroups(report.blockedSources, true)}</details>
    <details><summary>Needs more data or trigger support (${report.unknownSources.length})</summary><p class="note">These stay out of the eligible list because at least one requirement could not be proven from the current snapshot and supported trigger set.</p>${renderModifierGroups(report.unknownSources, true)}</details>
    <h3>${societal ? "What's currently pushing it" : "Confirmed active sources"}</h3>
    ${renderModifierGroups(report.activeSources, false)}
    ${societal ? `<h3>What's pushing the other way - toward ${escapeHtml(prettifyId(societal.opposingDirectionId))}</h3>${renderModifierGroups(societal.opposingReport.activeSources, false)}` : ""}
    <details><summary>Other direct sources (${report.otherSources.length})</summary><p class="note">These affect the value but are not one of the four player-choice systems currently optimized.</p>${renderModifierGroups(report.otherSources, false)}</details>
    <details><summary>Temporary event bonuses (${report.eventSources.length})</summary><p class="note">These modifier bundles are granted by events. They are shown for context only and never enter the eligible-action list or optimizer total.</p>${renderModifierGroups(report.eventSources, true)}</details>
    <details><summary>Other informational/scripted sources (${report.otherIndirectSources.length})</summary><p class="note">Mission rewards, decisions, situations, and other scripted grants are categorized here but remain outside the optimizer until their action and eligibility rules are modeled.</p>${renderModifierGroups(report.otherIndirectSources, true)}</details>`;
  results.classList.remove("hidden");
}

// --- modifier key autocomplete (search by plain-English name like "selling
// efficiency" instead of requiring the raw key "selling_efficiency" up
// front - matches against both the localized label and the raw key, so
// typing either still works) ---

function normalizeModifierSearchText(value) {
  return String(value || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
}

function matchModifierCatalog(query) {
  const q = normalizeModifierSearchText(query);
  if (!q) return [];
  const terms = q.split(" ").filter(Boolean);
  const scored = [];
  for (const entry of latestModifierCatalog) {
    const label = normalizeModifierSearchText(entry.label);
    const key = normalizeModifierSearchText(entry.key);
    if (!terms.every((term) => label.includes(term) || key.includes(term))) continue;
    let score = 3;
    if (label === q || key === q) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (key.startsWith(q)) score = 2;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label));
  return scored.slice(0, 20).map((s) => s.entry);
}

let modifierSuggestionIndex = -1;

function renderModifierSuggestions(matches) {
  const box = document.getElementById("modifierKeySuggestions");
  modifierSuggestionIndex = -1;
  if (!matches.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.innerHTML = matches
    .map((entry) => `<div class="modifier-key-option" data-key="${escapeHtml(entry.key)}"><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.key)}</span></div>`)
    .join("");
  box.classList.remove("hidden");
}

function chooseModifierSuggestion(key) {
  const input = document.getElementById("modifierKey");
  input.value = key;
  renderModifierSuggestions([]);
  input.focus();
}

const modifierKeyInput = document.getElementById("modifierKey");
const modifierKeyBox = document.getElementById("modifierKeySuggestions");

modifierKeyInput.addEventListener("input", () => renderModifierSuggestions(matchModifierCatalog(modifierKeyInput.value)));
modifierKeyInput.addEventListener("focus", () => {
  if (modifierKeyInput.value) renderModifierSuggestions(matchModifierCatalog(modifierKeyInput.value));
});
modifierKeyInput.addEventListener("keydown", (event) => {
  const options = [...modifierKeyBox.querySelectorAll(".modifier-key-option")];
  if (!options.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    modifierSuggestionIndex = Math.min(modifierSuggestionIndex + 1, options.length - 1);
    options.forEach((opt, i) => opt.classList.toggle("active", i === modifierSuggestionIndex));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    modifierSuggestionIndex = Math.max(modifierSuggestionIndex - 1, 0);
    options.forEach((opt, i) => opt.classList.toggle("active", i === modifierSuggestionIndex));
  } else if (event.key === "Enter" && modifierSuggestionIndex >= 0) {
    event.preventDefault();
    chooseModifierSuggestion(options[modifierSuggestionIndex].dataset.key);
  } else if (event.key === "Escape") {
    renderModifierSuggestions([]);
  }
});
modifierKeyBox.addEventListener("click", (event) => {
  const option = event.target.closest(".modifier-key-option");
  if (option) chooseModifierSuggestion(option.dataset.key);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".modifier-key-autocomplete")) renderModifierSuggestions([]);
});

// Lets Enter/submit work even when the user never clicked a suggestion.
// Almost every real modifier key contains an underscore (2453 of 2457 in a
// checked install; the 4 exceptions - adm/dip/mil/discipline - are exact
// catalog keys anyway), so a single bare word with no underscore (e.g.
// "sell") is far more likely to be a fragment the user meant to pick a
// suggestion for than the literal key itself - resolve it via the catalog
// instead of passing it through unchanged.
function resolveModifierKeyInput(value) {
  const trimmed = String(value || "").trim();
  const lower = trimmed.toLowerCase();
  if (latestModifierCatalog.some((entry) => entry.key === lower)) return lower;
  if (/^[a-z0-9]+_[a-z0-9_]*$/i.test(trimmed)) return lower;
  const matches = matchModifierCatalog(trimmed);
  return matches.length ? matches[0].key : lower;
}

async function loadModifierCatalog() {
  try {
    latestModifierCatalog = await window.llamaAPI.listModifierCatalog();
  } catch {
    latestModifierCatalog = [];
  }
}

loadModifierCatalog();

document.getElementById("modifierForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("modifierAnalyze");
  const results = document.getElementById("modifierResults");
  button.disabled = true;
  button.textContent = "Scanning game files...";
  results.classList.remove("hidden");
  results.innerHTML = '<p class="note">Scanning the local EU5 install...</p>';
  try {
    const modifierKey = resolveModifierKeyInput(modifierKeyInput.value);
    modifierKeyInput.value = modifierKey;
    const report = await window.llamaAPI.analyzeModifier({
      modifierKey,
      countryNumber: document.getElementById("modifierOptimizerCountry").value,
    });
    renderModifierReport(report);
  } catch (err) {
    results.innerHTML = `<h2>Could not analyze modifier</h2><p class="note error-text">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Find sources";
  }
});

document.getElementById("societalValueForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("societalValueAnalyze");
  const results = document.getElementById("valueOptimizerResults");
  const country = selectedCountry("valueOptimizerCountry");
  const axis = selectedSocietalAxis();
  const direction = document.getElementById("societalValueDirection").value;
  if (!country || !axis || (direction !== "left" && direction !== "right")) return;
  const directionId = axis[`${direction}Id`];
  const opposingDirection = direction === "left" ? "right" : "left";
  const opposingDirectionId = axis[`${opposingDirection}Id`];
  button.disabled = true;
  button.textContent = "Scanning game files...";
  results.classList.remove("hidden");
  results.innerHTML = `<p class="note">Finding ways to push toward ${escapeHtml(prettifyId(directionId))}...</p>`;
  try {
    const analysis = await window.llamaAPI.analyzeSocietalValue({ axisKey: axis.axisKey, direction, countryNumber: country.number });
    renderModifierReport(analysis.report, {
      axisKey: axis.axisKey,
      direction,
      directionId,
      opposingDirectionId,
      currentValue: country.societalValues ? country.societalValues[axis.axisKey] : undefined,
      opposingReport: analysis.opposingReport,
      equilibrium: analysis.equilibrium,
    });
  } catch (err) {
    results.innerHTML = `<h2>Could not analyze societal value</h2><p class="note error-text">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Find ways to push";
  }
});

document.getElementById("societalValueAxis").addEventListener("change", () => updateSocietalDirection(true));
document.getElementById("societalValueDirection").addEventListener("change", () => renderSocietalCurrent(selectedCountry("valueOptimizerCountry"), selectedSocietalAxis()));

document.getElementById("valueOptimizerCountry").addEventListener("change", () => {
  const country = selectedCountry("valueOptimizerCountry");
  document.getElementById("valueOptimizerStateNote").textContent = modifierStateNoteText(country, latestModifierContext);
  updateSocietalAxes(country, true);
});
document.getElementById("modifierOptimizerCountry").addEventListener("change", () => {
  document.getElementById("modifierOptimizerStateNote").textContent = modifierStateNoteText(selectedCountry("modifierOptimizerCountry"), latestModifierContext);
});

async function loadSocietalValueAxes() {
  try {
    latestSocietalAxes = await window.llamaAPI.listSocietalValueAxes();
    societalAxesError = null;
  } catch (err) {
    latestSocietalAxes = [];
    societalAxesError = err && err.message ? err.message : String(err);
  }
  applyModifierContext(latestModifierContext);
}

loadSocietalValueAxes();

// --- tab switching + per-mode section setup (both sections are cloned from
// one <template>, so the ongoing/concluded/leaderboard markup only needs to
// be written once) ---

const template = document.getElementById("modeSectionTemplate");
["pvp", "pve"].forEach((mode) => {
  const section = document.getElementById(`${mode}Section`);
  section.appendChild(template.content.cloneNode(true));
  section.querySelector('[data-field="hideVerified"]').addEventListener("change", () => renderConcludedWars(mode, latestByMode[mode]));
  section.querySelector('[data-field="showDeparted"]').addEventListener("change", () => renderLeaderboard(mode, latestLeaderboardByMode[mode]));
});

document.querySelectorAll(".mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b === btn));
    const mode = btn.dataset.mode;
    for (const sectionMode of ["pvp", "pve", "valueOptimizer", "modifierOptimizer"]) {
      document.getElementById(`${sectionMode}Section`).classList.toggle("hidden", mode !== sectionMode);
    }
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
  const gameDirInput = document.getElementById("gameDirInput");
  saveDirInput.value = settings.saveDir || "";
  saveDirInput.placeholder = settings.defaultSaveDir || "";
  dataDirInput.value = settings.dataDir || "";
  dataDirInput.placeholder = settings.defaultDataDir || "";
  gameDirInput.value = settings.gameDir || "";
  gameDirInput.placeholder = settings.defaultGameDir || "";
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
document.getElementById("pickGameDir").addEventListener("click", async () => {
  const input = document.getElementById("gameDirInput");
  const picked = await window.llamaAPI.pickFolder(input.value || input.placeholder);
  if (picked) input.value = picked;
});
document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await window.llamaAPI.saveSettings({
    saveDir: document.getElementById("saveDirInput").value.trim(),
    dataDir: document.getElementById("dataDirInput").value.trim(),
    gameDir: document.getElementById("gameDirInput").value.trim(),
  });
  settingsDialog.close();
});

window.llamaAPI.onUpdate(applyUpdate);
