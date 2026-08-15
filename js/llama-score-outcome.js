// War-outcome inference engine, shared between the website (js/llama-score.js)
// and the desktop recorder (llama-score-automatic-logging-machine/
// llama-log-machine.js). Previously duplicated as two independently-
// maintained ~600-line copies - a whole-repo review found the two had
// already drifted apart in real, non-cosmetic ways (a missing defensive
// null-check in one copy's reparationsSignal, a loserSide field only one
// copy populated, an inferOutcome signature difference) despite both being
// intended as "the same signal, weighed the same way." Extracted here as one
// canonical implementation - the recorder's version, since it was the
// superset of the two - so a future fix only has to happen once and both
// consumers can never silently disagree on the same war's outcome again.
//
// Pure computation only: takes already-extracted war/economy-delta/
// reparations data and returns an outcome verdict. No file I/O, no
// Clausewitz/ClausewitzBinary dependency - loads identically as a plain
// <script> in the browser or via require() in Node, same UMD pattern as
// js/clausewitz.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LlamaScoreOutcome = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Private to this module - NOT the same object as js/llama-score.js's own
  // (public, differently-behaved) dateKey used for ledger/snapshot sorting.
  // This one is only used internally by reparationsSignal below to compare
  // an obligation's start date against the war's own start date.
  function dateKey(date) {
    if (!date || typeof date !== "string") return null;
    const parts = date.split(".").map((p) => Number(p));
    if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
    while (parts.length < 4) parts.push(0);
    return parts[0] * 100000000 + parts[1] * 1000000 + parts[2] * 10000 + parts[3];
  }

// Restricts a side's economy delta to just the war's ORIGINALLY-declared
// belligerent(s) before falling back to the full side aggregate, so a
// player fully annexing an unrelated coalition member mid-war can't swing
// the wrong side's "winner" call off a windfall against a third party while
// actually losing land to the real opposing player.
// `war.originalAttacker`/`war.originalDefenders` record who the game
// DECLARED as belligerents, not who actually showed up - a country invited/
// targeted but never joining (status "Declined") still appears here. Real
// bug found on real data: a declined defender's own (unrelated) location
// gain got summed together with the REAL defender's real location LOSS in
// the same principal set, netting to ~0 and masking a clean, decisive land
// transfer as a White Peace - the declined country was never actually
// fighting, so whatever else was happening to its territory that same month
// has nothing to do with this war. Excluded here so a Declined "principal"
// contributes nothing to any economic signal, the same way it's already
// excluded from the displayed participant lists (countriesBySide, in each
// consumer's own war-summary building).
function principalCountrySet(value, war) {
  const declined = new Set();
  if (war) for (const p of war.participants || []) if (p.status === "Declined") declined.add(p.country);
  const set = new Set();
  if (typeof value === "number") {
    if (!declined.has(value)) set.add(value);
  } else if (Array.isArray(value)) {
    for (const n of value) if (typeof n === "number" && !declined.has(n)) set.add(n);
  }
  return set;
}
// A vassal being attacked drags its Overlord into the war automatically
// (confirmed by the user from real play - "the overlord will auto take over
// if i attack a vassal") - the war's own participant list already records
// this: the Overlord's own participant entry has `reason === "Overlord"` and
// `calledAlly` pointing at the vassal it's defending. Looked up per-war (not
// from a country's current `.overlord` field, which only reflects
// present-day status) since that's the actual mechanic that pulled them in,
// self-contained in data already on the war object.
function overlordFor(war, vassalCountry) {
  const participants = war.participants || [];
  for (const p of participants) {
    if (p.reason === "Overlord" && p.calledAlly === vassalCountry) return p.country;
  }
  return null;
}
// Land can genuinely move to/from either the vassal (their own conquered
// provinces) or the Overlord (who negotiates the actual peace) - so the
// location-delta principal set is the UNION of both.
function principalsWithOverlords(base, war) {
  const expanded = new Set(base);
  for (const country of base) {
    const overlord = overlordFor(war, country);
    if (overlord != null) expanded.add(overlord);
  }
  // Downward direction too, not just upward: per the user's explicit call,
  // taking land from someone's VASSAL is winning against THEM - a subject
  // has no standing of its own, it's the same political entity as its
  // overlord. `reason === "Subject"` participants (real subjects, called in
  // specifically because they belong to a principal already in this set)
  // get folded in, transitively - a subject can itself have its own
  // subjects fighting too, confirmed real in an actual campaign war (a
  // 3-level chain). Deliberately does NOT pull in "InternationalOrganization"
  // or any other non-Subject call-in reason - those are genuinely separate
  // political entities dragged in by an alliance/league mechanic, not part
  // of the principal's own realm, and stay excluded per the original
  // coalition-vs-principal design - only a REAL subject counts here.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of war.participants || []) {
      if (expanded.has(p.country) || p.status === "Declined") continue;
      if (p.reason === "Subject" && expanded.has(p.calledAlly)) {
        expanded.add(p.country);
        changed = true;
      }
    }
  }
  return expanded;
}
// Gold is different: per the user's call, "you can never exchange money with
// a vassal only with the overlord in a peace" - a vassal has no treasury
// standing of its own in a peace deal, so when a principal has an Overlord
// present, the Overlord REPLACES it for gold purposes rather than being
// added alongside it (unlike location, this is not a union).
function principalsForGold(base, war) {
  const result = new Set();
  for (const country of base) {
    const overlord = overlordFor(war, country);
    result.add(overlord != null ? overlord : country);
  }
  return result;
}
function principalFieldSum(sideInfo, principals, field) {
  if (!sideInfo || !sideInfo.countryDeltas || !principals.size) return null;
  let sum = 0;
  let count = 0;
  for (const cd of sideInfo.countryDeltas) {
    if (!principals.has(cd.country)) continue;
    if (typeof cd[field] === "number") {
      sum += cd[field];
      count++;
    }
  }
  return count ? sum : null;
}
function resolveSideField(sideInfo, principals, field) {
  const principalValue = principalFieldSum(sideInfo, principals, field);
  if (principalValue !== null) return { value: principalValue, usedPrincipal: true };
  return { value: sideInfo ? sideInfo[field] : null, usedPrincipal: false };
}
// Same principal-scoping as principalFieldSum, but for the actual location
// ID lists (locationsGained/locationsLost - see locationSetDelta) instead
// of the net number - lets a war's real land exchange be inspected directly
// rather than just trusting a spread. Union across every principal on the
// side. Null (not an empty array) when nothing in this side's principals
// carries it, so the UI can tell "no exchange" apart from "no data for this
// older war".
function principalFieldUnion(sideInfo, principals, field) {
  if (!sideInfo || !sideInfo.countryDeltas || !principals.size) return null;
  const ids = new Set();
  let any = false;
  for (const cd of sideInfo.countryDeltas) {
    if (!principals.has(cd.country)) continue;
    if (Array.isArray(cd[field])) {
      any = true;
      for (const id of cd[field]) ids.add(id);
    }
  }
  return any ? [...ids] : null;
}

// The single strongest signal available: an ENFORCED war-reparations
// obligation (diplomacy_manager's war_reparations - see js/clausewitz.js's
// extractWarReparationsFields) directly records who lost and who won,
// straight from the peace treaty itself - unlike land/gold deltas, it isn't
// INFERRED from noisy before/after snapshot comparisons, and it persists
// ~10 in-game years, far longer than war_manager keeps a concluded war's own
// record around (confirmed on real data: matching war-disappeared events
// for these exact wars had already been purged from war_manager by the time
// the corresponding autosave was captured, yet the reparations record was
// still sitting in diplomacy_manager). "first"/payer is the war's LOSER,
// "second"/receiver is the WINNER - confirmed against a real save's already-
// independently-validated outcome (England collecting from Castile), not
// assumed. Uses the same gold-principal substitution as the treasury-swing
// signal (a vassal has no treasury standing in a peace, so its Overlord is
// who actually pays/collects), and only considers an obligation that started
// on or after this war's own start date - one from years earlier between the
// same two countries would be a leftover from a DIFFERENT war.
function reparationsSignal(war, warReparations, attackerGoldPrincipals, defenderGoldPrincipals) {
  if (!Array.isArray(warReparations) || !warReparations.length) return null;
  const startKey = dateKey(war.startDate);
  let best = null;
  let bestKey = null;
  for (const rep of warReparations) {
    if (typeof rep.payer !== "number" || typeof rep.receiver !== "number") continue;
    const repKey = dateKey(rep.startDate);
    if (repKey === null || (startKey !== null && repKey < startKey)) continue;
    let winnerSide = null;
    if (attackerGoldPrincipals.has(rep.payer) && defenderGoldPrincipals.has(rep.receiver)) winnerSide = "Defender";
    else if (defenderGoldPrincipals.has(rep.payer) && attackerGoldPrincipals.has(rep.receiver)) winnerSide = "Attacker";
    if (!winnerSide) continue;
    if (!best || repKey > bestKey) {
      best = winnerSide;
      bestKey = repKey;
    }
  }
  if (!best) return null;
  return {
    winnerSide: best,
    loserSide: best === "Attacker" ? "Defender" : "Attacker",
    reason: "post-war-reparations-enforced",
    // Deliberately larger than any land/gold strength value (land tops out
    // around locationCount*1000, gold around raw treasury deltas in the
    // thousands at most) so this always wins the sort below when present,
    // per the user's explicit call that enforced reparations are even more
    // reliable evidence than a land transfer.
    strength: Number.MAX_SAFE_INTEGER,
  };
}

// Reads a resolved-side-field's two values and reports a directional LEAN
// only when both sides show real, opposite-signed movement of a real (>=100)
// magnitude on whichever side is gaining - the exact same rigor the old
// treasury-swing DECISIVE check used, just repurposed for a non-decisive
// lean (see economicOutcomeSignal's big comment on why treasury/prestige no
// longer get to crown a winner at all).
function goldLikeLean(aValue, dValue) {
  if (typeof aValue !== "number" || typeof dValue !== "number") return null;
  if (aValue === 0 || dValue === 0 || Math.sign(aValue) === Math.sign(dValue)) return null;
  const gainerValue = aValue > 0 ? aValue : dValue;
  if (Math.abs(gainerValue) < 100) return null;
  return aValue > dValue ? "Attacker" : "Defender";
}

// A war whose own internal goal is literally "gain independence" - the game
// tags this directly (war.warName === "INDEPENDENCE_WAR_NAME", see
// js/clausewitz.js's extractWarFields and test/debug-war-name.js for the
// derivation), and by definition of this war type the ATTACKER is always
// the vassal fighting to break free, with the (former) overlord auto-joining
// the DEFENDER side. Land/gold rarely change hands in an independence peace
// (confirmed on real data: a real independence war showed 0/0 land and only
// a modest, non-decisive treasury swing, even though the outcome was
// completely unambiguous) - without this signal, that shape falls through to
// White Peace despite a real, decisive result.
//
// Deliberately does NOT need "before the war" snapshot data - EU5 already
// guarantees the pre-war relationship (that's what this war type means), so
// the only thing left to check is whether the vassal is STILL subject to one
// of the war's original defenders by the time the war disappears - if the
// AFTER snapshot's dependency data is gone (or points elsewhere), the vassal
// achieved independence; if it still points at one of the defenders, they
// lost and remain subjugated. (An earlier, more complex design compared
// dependency status before vs. after the war, using multi-snapshot history -
// abandoned once this simpler, more direct check was found: the vassal's own
// `overlord` field reads null almost immediately upon DECLARING an
// independence war, not just upon winning it, which would have made a
// before/after comparison unreliable for exactly the case this exists to
// catch.)
// `war.revolt` covers BOTH INDEPENDENCE_WAR_NAME (a vassal fighting to break
// free) and CIVIL_WAR_NAME (a pretender contesting the throne) - the
// rebel/pretender is always the ATTACKER (confirmed on real data: 7/7 revolt
// wars in a real campaign had `revolter: true` on the Attacker side, never
// the Defender).
//
// Real bug found on real data: the old version of this signal (named
// independenceSignal, INDEPENDENCE_WAR_NAME-only) returned null the moment
// the attacker's country was missing from `afterCountries` (`if (!info)
// return null`) - exactly what happens when the player FULLY ANNEXES the
// rebel back (same "vanished" pattern documented in sideEconomyDeltas'
// comment), so a clean, decisive crush fell through to weaker signals
// instead of being recognized as a Defender win. Worse: if the rebel's tag
// survived a snapshot or two as an empty `locationCount: 0` stub (rather
// than vanishing outright - also documented as real in sideEconomyDeltas'
// comment) with `overlord` already cleared, the OLD `stillSubjugated` check
// read that as "independence achieved" and credited the ATTACKER with a win
// - the exact inverted-outcome bug the user reported (full annexation of a
// rebel scored as a loss). Fixed: a rebel with no land left (vanished OR
// `locationCount === 0`) is checked FIRST and is always a Defender win
// (crushed), regardless of what its `overlord` field says - only a rebel
// that's still a going concern with real land afterward falls through to
// the subjugation check below.
function revoltOutcomeSignal(war, afterCountries) {
  if (!war.revolt) return null;
  const attacker = war.originalAttacker;
  const defenders = war.originalDefenders || [];
  if (typeof attacker !== "number" || !afterCountries) return null;
  const info = afterCountries[attacker];
  const crushed = !info || (typeof info.locationCount === "number" && info.locationCount === 0);
  if (crushed) {
    return { winnerSide: "Defender", loserSide: "Attacker", reason: "post-war-revolt-crushed", strength: Number.MAX_SAFE_INTEGER };
  }
  // The "still subjugated to a defender = they lost, independence not
  // granted" check only makes sense for an actual INDEPENDENCE_WAR_NAME (a
  // real vassal/overlord relationship to test) - a CIVIL_WAR_NAME pretender
  // that's still around with land afterward has no equivalent relationship
  // to check, so it falls through to land-transfer/reparations instead of
  // guessing here.
  if (war.warName !== "INDEPENDENCE_WAR_NAME") return null;
  const stillSubjugated = typeof info.overlord === "number" && defenders.includes(info.overlord);
  return {
    winnerSide: stillSubjugated ? "Defender" : "Attacker",
    loserSide: stillSubjugated ? "Attacker" : "Defender",
    reason: "post-war-independence-granted",
    // Same tier as reparations - a direct state check, not an inferred delta.
    strength: Number.MAX_SAFE_INTEGER,
  };
}

// Returns { decisive, contributing, breakdown }: `decisive` is the single
// strongest qualifying DECISIVE signal (or null - only reparations, land
// transfer, and independence are eligible, see below), `contributing` is
// every OTHER DECISIVE-eligible signal that also qualified but lost out, and
// `breakdown` is a full numeric account of every factor this function looked
// at (decisive or not) for the UI's expandable "how was this decided" detail
// view.
//
// Per the user's explicit call: treasury swing, like prestige before it, is
// being DEMOTED from decisive to informational-only. Real data this session
// found repeated false positives from it even after two rounds of
// tightening the threshold (a big campaigning army outspending a defender
// regardless of outcome; one side hemorrhaging money on unrelated war costs
// while the other only incidentally gained a little) - the user's read is
// that gold, like prestige, has too many reasons to swing that have nothing
// to do with who actually won THIS war. Only land transfer (a real
// before/after territory comparison), enforced war reparations, and granted
// independence (both literal, non-inferred peace-treaty facts) are trusted
// to crown a winner now. Treasury and prestige are still computed and
// surfaced - as contributingFactors/breakdown entries, same tier as
// war-score/battle-losses/occupation - just never decisive.
function economicOutcomeSignal(war, economy, warReparations, afterCountries) {
  const breakdown = [];
  const signals = [];
  const revoltOutcome = revoltOutcomeSignal(war, afterCountries);
  if (revoltOutcome) signals.push(revoltOutcome);
  breakdown.push({
    key: "independence",
    label: "Independence granted",
    decisive: true,
    applies: !!revoltOutcome,
    winnerSide: revoltOutcome ? revoltOutcome.winnerSide : null,
    attackerValue: null,
    defenderValue: null,
  });
  if (!economy || !economy.Attacker || !economy.Defender) {
    if (!signals.length) return { decisive: null, contributing: [], breakdown };
    signals.sort((a, b) => b.strength - a.strength);
    return { decisive: signals[0], contributing: signals.slice(1), breakdown };
  }
  const attackerPrincipalsBase = principalCountrySet(war.originalAttacker, war);
  const defenderPrincipalsBase = principalCountrySet(war.originalDefenders, war);
  const attackerPrincipals = principalsWithOverlords(attackerPrincipalsBase, war);
  const defenderPrincipals = principalsWithOverlords(defenderPrincipalsBase, war);
  const attackerGoldPrincipals = principalsForGold(attackerPrincipalsBase, war);
  const defenderGoldPrincipals = principalsForGold(defenderPrincipalsBase, war);

  const aLoc = resolveSideField(economy.Attacker, attackerPrincipals, "locationDelta");
  const dLoc = resolveSideField(economy.Defender, defenderPrincipals, "locationDelta");
  const aGoldR = resolveSideField(economy.Attacker, attackerGoldPrincipals, "goldDelta");
  const dGoldR = resolveSideField(economy.Defender, defenderGoldPrincipals, "goldDelta");
  // Prestige reuses the gold-principal substitution (an overlord replaces a
  // vassal, per the same "a vassal has no standing of its own in a peace"
  // reasoning) - it's informational only, so this is a judgment call, not a
  // load-bearing one.
  const aPrestigeR = resolveSideField(economy.Attacker, attackerGoldPrincipals, "prestigeDelta");
  const dPrestigeR = resolveSideField(economy.Defender, defenderGoldPrincipals, "prestigeDelta");

  const aGold = aGoldR.value;
  const dGold = dGoldR.value;
  const aLocations = aLoc.value;
  const dLocations = dLoc.value;
  const aPrestige = aPrestigeR.value;
  const dPrestige = dPrestigeR.value;

  const reparations = reparationsSignal(war, warReparations, attackerGoldPrincipals, defenderGoldPrincipals);
  if (reparations) signals.push(reparations);
  breakdown.push({
    key: "reparations",
    label: "War reparations",
    decisive: true,
    applies: !!reparations,
    winnerSide: reparations ? reparations.winnerSide : null,
    attackerValue: null,
    defenderValue: null,
  });

  let landApplies = false;
  let landWinner = null;
  // Ground-truth check: principalFieldUnion (below) exposes the ACTUAL
  // location-ID sets each side gained/lost (null, not [], for a war
  // recorded before this per-location tracking existed). A real overlap
  // between one side's lost IDs and the other's gained IDs PROVES land
  // moved between these two specific principals - strictly better evidence
  // than inferring it from the aggregate net-delta spread below, since it
  // can neither miss a genuine same-signed pile-on transfer nor be fooled
  // by two unrelated swings that happen to spread by chance (a real gap
  // found reviewing the spread-only version of this check - see the
  // sign-check history in the comment further down). Only used to gate
  // decisiveness, not to replace `winnerSide`/`strength` below, which still
  // read from the plain net-delta numbers either way. Kept identical to the
  // same fix in js/llama-score.js's economicOutcomeSignal - see that
  // file's comment for the full reasoning.
  const attackerLocationsLostIds = principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsLost");
  const attackerLocationsGainedIds = principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsGained");
  const defenderLocationsLostIds = principalFieldUnion(economy.Defender, defenderPrincipals, "locationsLost");
  const defenderLocationsGainedIds = principalFieldUnion(economy.Defender, defenderPrincipals, "locationsGained");
  function idSetsOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
    const bSet = new Set(b);
    return a.some((id) => bSet.has(id));
  }
  const hasLocationIdData =
    Array.isArray(attackerLocationsLostIds) &&
    Array.isArray(attackerLocationsGainedIds) &&
    Array.isArray(defenderLocationsLostIds) &&
    Array.isArray(defenderLocationsGainedIds);
  const confirmedBilateralTransfer =
    hasLocationIdData &&
    (idSetsOverlap(attackerLocationsLostIds, defenderLocationsGainedIds) ||
      idSetsOverlap(defenderLocationsLostIds, attackerLocationsGainedIds));
  if (typeof aLocations === "number" && typeof dLocations === "number") {
    const spread = aLocations - dLocations;
    // Both principal sides must show a REAL (nonzero) location change for
    // this to be evidence of land actually exchanged between THEM
    // specifically. Confirmed on real data (pure-reparations wars where the
    // loser paid gold only): the loser's own location delta was exactly 0
    // while the winner's showed an unrelated nonzero swing (some other war/
    // colonization concluding in the same snapshot window, not land taken
    // from this opponent) - the old check treated 0 as "opposite sign" from
    // any nonzero value and wrongly called that a clean two-sided transfer.
    // A genuine bilateral transfer moves both sides' counts in real,
    // opposite directions (e.g. -24 / +24, an exact mirror); one side
    // sitting at exactly 0 proves nothing came from/went to this opponent,
    // whatever the other side's unrelated change was.
    //
    // Real bug found on real data: requiring OPPOSITE signs (on top of the
    // nonzero guard above) missed a real, decisive pile-on war - a
    // 2-attacker-vs-34-defender conquest where the attacker principal ended
    // net -23 locations and the defender principal ended net -7 (a real
    // war-time save shows a clean 7-location swap between exactly these two
    // principals, PLUS the attacker separately losing 23 more elsewhere in
    // the same multi-front war to other coalition members not tracked as
    // this defender's own principal). Both deltas were real and nonzero,
    // just same-signed, so the old sign check silently discarded a genuine,
    // sizeable relative loss and fell through to White Peace. The nonzero
    // guard above already rules out the "one side truly uninvolved" false
    // positive described above; requiring opposite signs on top of that only
    // protects against two unrelated, similarly-sized swings elsewhere
    // coincidentally producing a spread - a much rarer and smaller risk than
    // silently missing every same-signed pile-on result, so the relative
    // spread between the two principals (not the sign of either) is what
    // decides now, UNLESS the ID-confirmed check above already settled it -
    // confirmedBilateralTransfer takes priority whenever location-ID data
    // exists (both to catch a same-signed pile-on the spread math alone
    // might still miss at small magnitudes, and to correctly withhold a
    // decisive call when the IDs prove no land actually moved between these
    // two sides despite a coincidental spread). The spread-only heuristic
    // remains the fallback only for a war recorded before per-location IDs
    // existed.
    const winnerSide = spread > 0 ? "Attacker" : "Defender";
    if (
      (confirmedBilateralTransfer && spread !== 0) ||
      (!hasLocationIdData && aLocations !== 0 && dLocations !== 0 && Math.abs(spread) >= 2)
    ) {
      const clean = aLoc.usedPrincipal && dLoc.usedPrincipal;
      landApplies = true;
      landWinner = winnerSide;
      signals.push({
        winnerSide,
        loserSide: winnerSide === "Attacker" ? "Defender" : "Attacker",
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(spread) * 1000,
      });
    }
  } else if (typeof aLocations === "number" || typeof dLocations === "number") {
    const side = typeof aLocations === "number" ? "Attacker" : "Defender";
    const value = typeof aLocations === "number" ? aLocations : dLocations;
    const clean = side === "Attacker" ? aLoc.usedPrincipal : dLoc.usedPrincipal;
    const winnerSide = value > 0 ? side : side === "Attacker" ? "Defender" : "Attacker";
    if (Math.abs(value) >= 1) {
      landApplies = true;
      landWinner = winnerSide;
      signals.push({
        winnerSide,
        loserSide: winnerSide === "Attacker" ? "Defender" : "Attacker",
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(value) * 1000,
      });
    }
  }
  breakdown.push({
    key: "land-transfer",
    label: "Land transfer",
    decisive: true,
    applies: landApplies,
    winnerSide: landWinner,
    attackerValue: aLocations,
    defenderValue: dLocations,
    attackerLocationsGained: attackerLocationsGainedIds,
    attackerLocationsLost: attackerLocationsLostIds,
    defenderLocationsGained: defenderLocationsGainedIds,
    defenderLocationsLost: defenderLocationsLostIds,
  });

  const treasuryLean = goldLikeLean(aGold, dGold);
  breakdown.push({
    key: "treasury",
    label: "Treasury swing",
    decisive: false,
    applies: typeof aGold === "number" && typeof dGold === "number",
    winnerSide: treasuryLean,
    attackerValue: aGold,
    defenderValue: dGold,
  });

  const prestigeLean = goldLikeLean(aPrestige, dPrestige);
  breakdown.push({
    key: "prestige",
    label: "Prestige swing",
    decisive: false,
    applies: typeof aPrestige === "number" && typeof dPrestige === "number",
    winnerSide: prestigeLean,
    attackerValue: aPrestige,
    defenderValue: dPrestige,
  });

  if (!signals.length) return { decisive: null, contributing: [], breakdown };
  signals.sort((a, b) => b.strength - a.strength);
  return { decisive: signals[0], contributing: signals.slice(1), breakdown };
}

// Battle-inflicted casualties (Battle+Capture, NOT Attrition) compared
// between sides - unlike Attrition, which a large/far-from-home invading
// army racks up regardless of whether it's winning (confirmed on a real
// concluded war: the attacker held 92% of contested territory yet had the
// only recorded losses, all Attrition, none Battle - a clean Attacker win
// with a heavily attrited army, not a contradiction), Battle/Capture losses
// are actually inflicted by the other side, so a lopsided split there is a
// real (if indirect) signal of who's losing the fight. Needs a minimum
// sample and a decisive-enough margin to matter - see thresholds below.
function battleLossSignal(war) {
  const a = war.attackerLosses;
  const d = war.defenderLosses;
  if (!a || !d) return null;
  const aCombat = (a.battle || 0) + (a.capture || 0);
  const dCombat = (d.battle || 0) + (d.capture || 0);
  const total = aCombat + dCombat;
  if (total < 50) return null; // too small a sample to read anything into
  const spread = dCombat - aCombat; // positive -> attacker inflicted more -> attacker likely winning
  if (Math.abs(spread) / total < 0.2) return null; // not a decisive enough margin
  return { winnerSide: spread > 0 ? "Attacker" : "Defender", reason: "battle-losses-inflicted" };
}

const CONFIDENCE_ORDER = ["unknown", "low", "medium", "high"];
function shiftConfidence(level, delta) {
  const idx = CONFIDENCE_ORDER.indexOf(level);
  if (idx < 0) return level;
  return CONFIDENCE_ORDER[Math.max(0, Math.min(CONFIDENCE_ORDER.length - 1, idx + delta))];
}

// Maps an economicOutcomeSignal reason code to the short label used in
// contributingFactors, so a land signal that LOST out to reparations (see
// economicOutcomeSignal's `contributing`) still shows up as "considered but
// not decisive" the same way war-score/battle-losses do.
const CONTRIBUTING_SIGNAL_FROM_REASON = {
  "post-war-reparations-enforced": "reparations",
  "post-war-independence-granted": "independence",
  "post-war-revolt-crushed": "independence",
  "post-war-land-transfer": "land-transfer",
  "post-war-land-transfer-coalition": "land-transfer",
};

function inferOutcome(war, disappeared, economy, warReparations, afterCountries) {
  const aScore = war.attackerScore;
  const dScore = war.defenderScore;
  const lossSignal = battleLossSignal(war);
  const scoreSignal =
    typeof aScore === "number" && typeof dScore === "number" && aScore !== dScore
      ? { winnerSide: aScore > dScore ? "Attacker" : "Defender" }
      : null;
  const aCombat = war.attackerLosses ? (war.attackerLosses.battle || 0) + (war.attackerLosses.capture || 0) : null;
  const dCombat = war.defenderLosses ? (war.defenderLosses.battle || 0) + (war.defenderLosses.capture || 0) : null;
  const occ = war.occupation;
  const occupationLean =
    occ && typeof occ.attackerLocations === "number" && typeof occ.defenderLocations === "number" && occ.attackerLocations !== occ.defenderLocations
      ? occ.attackerLocations > occ.defenderLocations
        ? "Attacker"
        : "Defender"
      : null;

  // Confirmed wrong on real data: a war where the attacker held 238 of 259
  // contested locations (92%, about as decisive a split as this game
  // produces) still had a lone defenderScore=5 lingering (attackerScore
  // already cleared to null) - the old priority order trusted that
  // single-sided leftover score over the occupation split and called a
  // Defender win the user confirmed was actually a clear Attacker win. A
  // lone surviving score value is most likely a partial-clear artifact from
  // EU5's own end-of-war cleanup (both fields are normally cleared
  // together), not a real signal - unlike a direct two-sided comparison
  // (both scores present at once) or the physical occupation snapshot, so
  // it's now only consulted as a fallback when occupation itself has
  // nothing to say.
  //
  // Per the user's explicit call: war score, battle
  // losses, occupation, treasury, and prestige never decide a winner on
  // their own - each one moves for reasons that don't reliably track who
  // actually won THIS specific war (a two-sided war score is frequently a
  // partial-clear artifact from EU5's own end-of-war cleanup; a winning
  // invader can still rack up heavy battle losses; occupying land mid-war
  // isn't the same as keeping it; treasury and prestige both swing from
  // battles/events/unrelated spending as often as from the war's actual
  // outcome). Only land transfer (a real before/after territory comparison)
  // and enforced war reparations (economicOutcomeSignal, a literal peace-
  // treaty term) decide who won; everything else is attached below as
  // contributingFactors/breakdown so the reasoning stays visible/auditable
  // without ever being trusted to pick a side by itself - not even when
  // several of them happen to agree.
  const economicSignal = economicOutcomeSignal(war, economy, warReparations, afterCountries);
  const treasuryFactor = economicSignal.breakdown.find((f) => f.key === "treasury");
  const prestigeFactor = economicSignal.breakdown.find((f) => f.key === "prestige");
  const fullBreakdown = economicSignal.breakdown.concat([
    { key: "war-score", label: "War score", decisive: false, applies: !!scoreSignal, winnerSide: scoreSignal ? scoreSignal.winnerSide : null, attackerValue: aScore, defenderValue: dScore },
    { key: "battle-losses", label: "Casualties inflicted", decisive: false, applies: !!lossSignal, winnerSide: lossSignal ? lossSignal.winnerSide : null, attackerValue: dCombat, defenderValue: aCombat },
    { key: "occupation", label: "Occupied enemy territory", decisive: false, applies: occupationLean != null, winnerSide: occupationLean, attackerValue: occ ? occ.attackerLocations : null, defenderValue: occ ? occ.defenderLocations : null },
  ]);

  function finalize(result, extraContributing) {
    let confidence = result.confidence;
    let lossSignalAgrees = null;
    if (lossSignal && result.winnerSide != null) {
      lossSignalAgrees = lossSignal.winnerSide === result.winnerSide;
      confidence = shiftConfidence(confidence, lossSignalAgrees ? 1 : 0);
    }
    if (typeof war.stalledYears === "number" && war.stalledYears >= 2) {
      confidence = shiftConfidence(confidence, -1);
    }
    const contributingFactors = [];
    if (scoreSignal) contributingFactors.push({ signal: "war-score", winnerSide: scoreSignal.winnerSide });
    if (lossSignal) contributingFactors.push({ signal: "battle-losses", winnerSide: lossSignal.winnerSide });
    if (treasuryFactor && treasuryFactor.winnerSide) contributingFactors.push({ signal: "treasury", winnerSide: treasuryFactor.winnerSide });
    if (prestigeFactor && prestigeFactor.winnerSide) contributingFactors.push({ signal: "prestige", winnerSide: prestigeFactor.winnerSide });
    for (const s of extraContributing || []) {
      contributingFactors.push({ signal: CONTRIBUTING_SIGNAL_FROM_REASON[s.reason] || s.reason, winnerSide: s.winnerSide });
    }
    return { ...result, confidence, lossSignalAgrees, contributingFactors, attackerScore: aScore, defenderScore: dScore, breakdown: fullBreakdown };
  }

  // The only decisive checks in this function: an enforced reparations
  // obligation (strongest - see reparationsSignal) and before/after
  // territory change, restricted to the war's two original principals (see
  // economicOutcomeSignal's own comments for the nonzero-both-sides fix and
  // the principal/coalition split). Both get "high" confidence (about as
  // unambiguous as this game's data gets).
  if (economicSignal.decisive) {
    return finalize(
      {
        winnerSide: economicSignal.decisive.winnerSide,
        loserSide: economicSignal.decisive.loserSide,
        confidence: "high",
        reason: economicSignal.decisive.reason,
      },
      economicSignal.contributing
    );
  }

  // Deliberately NOT falling back to war.occupation (who's occupying more
  // contested territory at the moment the war disappears) to DECIDE anything
  // here - confirmed wrong on real data twice now (see js/llama-score.js's
  // copy of this function): occupation called 4 of 5 real wars for the wrong
  // side even as the PRIMARY signal. Occupying land mid-war is not the same
  // as keeping it - only land TRANSFER (a real before/after comparison) and
  // enforced reparations can tell those apart. Occupation is still surfaced
  // above as a breakdown/contributingFactors entry (informational only, same
  // tier as war-score/battle-losses/treasury/prestige), just never used to
  // pick a winner.

  // No reparations were enforced and no land actually changed hands between
  // the two principals - default to White Peace. War score/battle-losses/
  // occupation/treasury/prestige are still attached above as
  // contributingFactors/breakdown for anyone auditing the call, but per the
  // user's call none of them gets to crown a winner on its own - a white
  // peace costs nothing to get right, and the per-row manual override still
  // corrects it if this genuinely was decisive.
  return finalize(
    {
      winnerSide: null,
      loserSide: null,
      confidence: "unknown",
      // whitePeace: true here is real and load-bearing, not decorative - a
      // real gap found reconciling this module with js/llama-score.js's own
      // pre-extraction copy, which set this and used it (js/llama-score.js's
      // computeFromLedger checks `!outcome.whitePeace` to decide whether
      // this fallback counts as a legitimate scored White Peace row versus
      // a truly indecisive/unscoreable one - see that file for the only
      // consumer that reads this field; the recorder itself never does).
      // Without it, every war that fell through to this branch would have
      // silently stopped being scored at all instead of being counted as
      // White Peace.
      whitePeace: true,
      reason: disappeared ? "war-disappeared-without-decisive-signal" : "active-or-tied",
    },
    economicSignal.contributing
  );
}

  return {
    principalCountrySet,
    overlordFor,
    principalsWithOverlords,
    principalsForGold,
    principalFieldSum,
    resolveSideField,
    principalFieldUnion,
    reparationsSignal,
    goldLikeLean,
    revoltOutcomeSignal,
    economicOutcomeSignal,
    battleLossSignal,
    shiftConfidence,
    inferOutcome,
  };
});
