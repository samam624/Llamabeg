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
  "post-war-land-transfer": "Land changed hands (clean 1-on-1 data)",
  "post-war-land-transfer-coalition": "Land changed hands (coalition-wide - less certain)",
  "post-war-treasury-swing": "Treasury swung between sides",
  "post-war-treasury-gain": "One side gained a lot of gold",
  "post-war-prestige-swing": "Prestige swung between sides",
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
// War score/prestige/battle-losses no longer decide a winner on their own
// (see inferOutcome() in js/llama-score.js or llama-log-machine.js) - they're
// attached to every outcome as contributingFactors so the reasoning stays
// auditable even though only a land or gold exchange between the two
// principals can crown a winner. Surfaced here as an extra tooltip line.
const CONTRIBUTING_FACTOR_LABELS = {
  "war-score": "war score",
  "prestige-swing": "prestige",
  "battle-losses": "battle losses",
  "land-transfer": "land change",
  treasury: "treasury",
};
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

function renderOngoingSide(entries) {
  if (!entries.length) return '<span class="note">-</span>';
  return `<ul class="side-list">${entries.map((e) => `<li>${countrySideLabel(e)}</li>`).join("")}</ul>`;
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
      <td>${renderOngoingSide(w.attackers)}</td>
      <td>${renderOngoingSide(w.defenders)}</td>
    </tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr><th>Started</th><th>Attacker(s)</th><th>Defender(s)</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    if (r.excluded) return `<li>${name}${alliesNote} <span class="note">(excluded)</span></li>`;
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
  const rows = visible
    .map((w) => {
      const checked = isVerified(currentCampaignKey, mode, w.warNumber);
      const confClass = CONFIDENCE_CLASS[w.confidence] || CONFIDENCE_CLASS.unknown;
      return `
    <tr class="${checked ? "row-verified" : ""}">
      <td><input type="checkbox" class="verify-check" data-war="${w.warNumber}" ${checked ? "checked" : ""} title="Check off once you've confirmed this outcome"></td>
      <td>${escapeHtml(w.startDate || "-")}</td>
      <td>${escapeHtml(w.endDate || "-")}</td>
      <td>${renderConcludedSide(w.attackers)}</td>
      <td>${renderConcludedSide(w.defenders)}</td>
      <td>${renderResult(w)}</td>
      <td><span class="${confClass}" title="${escapeHtml(reasonTooltip(w))}">${escapeHtml(reasonLabel(w.reason))}</span></td>
    </tr>`;
    })
    .join("");
  el.innerHTML = `<table><thead><tr><th>✓</th><th>Started</th><th>Ended</th><th>Attacker(s)</th><th>Defender(s)</th><th>Result</th><th>How decided</th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll(".verify-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      setVerified(currentCampaignKey, mode, cb.dataset.war, cb.checked);
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
  document.getElementById("saveDirInput").value = settings.saveDir;
  document.getElementById("dataDirInput").value = settings.dataDir;
  settingsDialog.showModal();
});
document.getElementById("settingsCancel").addEventListener("click", () => settingsDialog.close());
document.getElementById("pickSaveDir").addEventListener("click", async () => {
  const picked = await window.llamaAPI.pickFolder(document.getElementById("saveDirInput").value);
  if (picked) document.getElementById("saveDirInput").value = picked;
});
document.getElementById("pickDataDir").addEventListener("click", async () => {
  const picked = await window.llamaAPI.pickFolder(document.getElementById("dataDirInput").value);
  if (picked) document.getElementById("dataDirInput").value = picked;
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
