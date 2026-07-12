// Port of the user's EU4 "Llama Points" multiplayer scoring spreadsheet to
// EU5, driven by the war_manager data js/clausewitz.js and
// js/clausewitz-binary.js now extract (see extractWarFields in the former).
//
// Confirmed formula (from the actual .xlsx, not the older PDF write-up,
// which describes a different design that was never what the spreadsheet
// computed):
//   LlamaPoints[player] = GP_Score[player] / 100 + VP_total[player]
//   VP_total[player] = sum over the player's wars of warScore
//   warScore = E>0 ? 10*E*W/(A+1) + 10*(W-1)*(A+1)/(2*E)
//                  : 2*C*(2*W-1)         // E==0 -> condottieri-contract case
// where, per war and per player: E = distinct enemy countries, A = distinct
// allied countries (excluding self), W = 1 if won else 0, C = condottieri-
// contract flag.
//
// E and A are fully mechanical (count distinct countries by side in the
// war's participant list). W is NOT: EU5 clears attacker_score/
// defender_score/war_goal_held once a war concludes, and participant status/
// left-reason ("Left"/"WarEnded") is identical for winners and losers alike
// - no clean win/loss field survives. So W here is a best-effort heuristic
// (which side ended up holding more of the war's contested locations), with
// per-row manual overrides as the safety valve - this was an explicit,
// accepted design tradeoff (see llama_warscore_feature memory), not an
// oversight.
//
// Likewise, attributing a war to the *correct* player when a country
// changed hands mid-campaign can't be fully automated: played_country
// entries carry no timestamp, only file-order recency (see
// player_session_handling memory), which doesn't line up with a specific
// war's start/end dates. So a country with more than one historical player
// is flagged "ambiguous" here and defaults to its CURRENT controller,
// leaving the real call to the manual-review UI's player-reassignment
// dropdown (populated from every candidate who has ever played that
// country, oldest-first).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LlamaScore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function buildPlayerCandidatesByCountry(playerSessions) {
    const map = new Map();
    for (const s of playerSessions || []) {
      if (typeof s.countryNumber !== "number" || !s.name) continue;
      let arr = map.get(s.countryNumber);
      if (!arr) {
        arr = [];
        map.set(s.countryNumber, arr);
      }
      if (!arr.includes(s.name)) arr.push(s.name);
    }
    return map;
  }

  function sideCountryList(participants, side, excludeCountry) {
    const set = new Set();
    for (const p of participants) {
      if (p.side === side && p.country !== excludeCountry) set.add(p.country);
    }
    return [...set];
  }

  // Best-effort "who won" call for a concluded war - see the module comment
  // above for why no authoritative field exists. Ties and wars with no
  // occupation data at all (nothing changed hands) come back uncertain.
  function heuristicWinnerSide(war) {
    if (!war.concluded) return { winnerSide: null, uncertain: true, reason: "active" };
    const occ = war.occupation || {};
    if (!occ.totalLocations) return { winnerSide: null, uncertain: true, reason: "no-occupation-data" };
    if (occ.attackerLocations === occ.defenderLocations) return { winnerSide: null, uncertain: true, reason: "tie" };
    return { winnerSide: occ.attackerLocations > occ.defenderLocations ? "Attacker" : "Defender", uncertain: false, reason: null };
  }

  function overrideKey(warNumber, country) {
    return warNumber + ":" + country;
  }

  function warScoreFor(E, A, W, condottieri) {
    if (E > 0) return (10 * E * W) / (A + 1) + (10 * (W - 1) * (A + 1)) / (2 * E);
    return 2 * (condottieri ? 1 : 0) * (2 * W - 1);
  }

  function participantSide(war, country) {
    const p = (war.participants || []).find((part) => part.country === country);
    return p ? p.side : null;
  }

  function sideCountries(war, side, excludeCountry) {
    const set = new Set();
    for (const p of war.participants || []) {
      if (p.side === side && p.country !== excludeCountry) set.add(p.country);
    }
    return set;
  }

  // PVE-mode-only: a fight against one AI empire can drag in several of its
  // own vassals/subjects as extra call-in participants on the same side,
  // which used to inflate E (or A, if the player's own vassals joined)
  // purely by participant COUNT - fighting "the Ottomans + 3 vassals" scored
  // very differently from fighting just "the Ottomans", even though it's
  // really the same one fight against the same one empire. Confirmed this
  // is what the user meant by "point swing" getting muddied by vassals
  // fighting alongside their overlord - not the win/loss economic signal
  // (which already only looks at the war's original declared belligerents,
  // see economicOutcomeSignal's principal/coalition split), but the E/A
  // participant counts that directly drive warScoreFor(). Drops a country
  // from the set ONLY if its own overlord (per `overlordOf`, built from
  // `result.dependencies`/each country's `.overlord` field) is ALSO present
  // - a vassal fighting a war entirely on its own (its overlord isn't part
  // of this war at all) is a real, independent belligerent and is left
  // alone. `presentList` (optional) checks overlord presence against a
  // DIFFERENT list than the one being filtered - needed for the Allies
  // count specifically, whose input list already excludes the row's own
  // country ("allies excluding self") - if THAT country is itself the
  // overlord, checking presence against the self-excluded list alone would
  // never find it, silently failing to filter its own vassals out. Passing
  // the war side's FULL country list (self included) as `presentList` fixes
  // this; the enemy side has no such self-exclusion, so its call site
  // doesn't need to pass one.
  function excludeSubjectsOfPresentOverlords(countryList, overlordOf, presentList) {
    if (!overlordOf) return countryList;
    const present = new Set(presentList || countryList);
    return countryList.filter((c) => {
      const overlord = overlordOf(c);
      return !(typeof overlord === "number" && present.has(overlord));
    });
  }

  // Builds the {number, tag} list a PvE war's UI-facing side uses (see
  // aiSidePlaceholders in summarizeWars) - sorted biggest-nation-first
  // (by locationCount, where known) so "the war leader" means something
  // real rather than whatever arbitrary order a Set happened to iterate in.
  // No true "leader" field exists in the data beyond this - a PvE fight can
  // genuinely be several independent AI nations coalitioned together, not
  // one empire with subjects (already handled separately by
  // excludeSubjectsOfPresentOverlords), so "biggest by territory" is a
  // reasonable stand-in, not a claim that EU5 itself designates one.
  function labelAndSortByLocationCount(countryNumbers, countryInfoOf) {
    return countryNumbers
      .map((c) => {
        const info = countryInfoOf(c);
        return { number: c, tag: countryLabel(info, "#" + c), locationCount: (info && info.locationCount) || 0 };
      })
      .sort((a, b) => b.locationCount - a.locationCount)
      .map((e) => ({ number: e.number, tag: e.tag }));
  }

  // GP Score: built from `great_power_rank` (a per-country world-standing
  // rank present from game start in every save checked), NOT the ADM/DIP/MIL
  // rank sum this module used to use - those turned out to barely
  // differentiate between top players (everyone competitive already sits in
  // the top ~20 of ~2000+ ranked countries either way) and don't reflect the
  // game's own notion of "great power" standing.
  //
  // `great_power_rank`'s scale is save-dependent (total ranked real
  // countries ranges ~2100-2400 across test saves) and most of that range is
  // irrelevant - EU5 itself only tags the top tier as `regional_power=true`,
  // and empirically (the one test save where the mechanic had unlocked -
  // this appears to be gated behind a later game era, absent entirely in 5
  // of 6 test saves alongside `great_power_points`) that flag covers exactly
  // ranks 12-27, with the unflagged "true" great powers implicitly ranks
  // 1-11. So rank 28+ isn't a great/regional power at all and scores 0; rank
  // 1-27 scores on a linear taper, calibrated so rank 1 lands close to the
  // original EU4 spreadsheet's observed high end (~2139) once combined with
  // the existing GP_Score/100 term. This is a deliberate design choice, not
  // a value EU5 exposes directly - flagged as such in the UI.
  const GP_TIER_SIZE = 27;
  const GP_SCORE_PER_RANK = 75;
  function gpScoreFromRank(rank) {
    if (typeof rank !== "number") return null;
    return Math.max(0, GP_TIER_SIZE - rank + 1) * GP_SCORE_PER_RANK;
  }

  // Pure computation - no localStorage/DOM access, so it runs the same in a
  // test harness or the browser. `overrides` is a plain object keyed by
  // overrideKey(warNumber, country): { win, condottieri, excluded, player }
  // - any subset; unset fields fall back to the computed default. The
  // caller (js/app.js) owns persisting overrides, keyed additionally by
  // save id (war numbers/country numbers are only meaningful within one
  // save). `excludedPlayers` (optional Set of names) is the same manual
  // "Hide this player" list the Players table uses (js/app.js's
  // EXCLUDED_PLAYERS_KEY) - a save has no "still connected" flag (see
  // player_session_handling memory), so a departed player who was never
  // replaced keeps scoring wars forever unless the user says otherwise here.
  // `mode` ("pvp", the default, or "pve") picks which side of the same
  // isPvP split actually scores: "pvp" (unchanged original behavior) only
  // scores a war whose enemy side ever had a real player on it; "pve" is the
  // mirror image - only scores a war whose enemy side was NEVER anyone but
  // AI, using the SAME warScoreFor() formula, so a player's PvE performance
  // is comparable on the same points scale as their PvP performance. This
  // also doubles as a way to sanity-check the PvP scoring logic itself,
  // since both modes share every line of code below except which side of
  // the isPvP flag counts as "in scope" - a bug in one is very likely a bug
  // in both.
  function computeLlamaScores(result, overrides, excludedPlayers, mode) {
    overrides = overrides || {};
    excludedPlayers = excludedPlayers || new Set();
    mode = mode === "pve" ? "pve" : "pvp";
    const wars = result.wars || [];
    const candidatesByCountry = buildPlayerCandidatesByCountry(result.playerSessions);
    const currentPlayerByCountry = new Map(
      (result.players || []).filter((p) => typeof p.countryNumber === "number").map((p) => [p.countryNumber, p.name])
    );
    const countryByNumber = new Map((result.countries || []).map((c) => [c.number, c]));
    function isKnownPlayer(c) {
      return candidatesByCountry.has(c) || currentPlayerByCountry.has(c);
    }
    // See excludeSubjectsOfPresentOverlords()'s comment - PVE mode only.
    const overlordByCountry = new Map();
    for (const dep of result.dependencies || []) {
      if (typeof dep.overlord === "number" && typeof dep.subject === "number") overlordByCountry.set(dep.subject, dep.overlord);
    }
    const overlordOf = (c) => overlordByCountry.get(c);

    const rows = [];
    for (const war of wars) {
      const heuristic = heuristicWinnerSide(war);
      for (const participant of war.participants) {
        const country = participant.country;
        if (typeof country !== "number") continue;
        const candidates = candidatesByCountry.get(country) || [];
        const currentPlayer = currentPlayerByCountry.get(country) || null;
        if (!currentPlayer && !candidates.length) continue; // never player-controlled - AI, skip

        const key = overrideKey(war.number, country);
        const override = overrides[key] || {};
        const player = override.player || currentPlayer || candidates[candidates.length - 1] || null;
        const ambiguous = candidates.length > 1;

        const enemySide = participant.side === "Attacker" ? "Defender" : "Attacker";
        const enemyCountriesAll = sideCountryList(war.participants, enemySide);
        const enemyEverPlayer = enemyCountriesAll.filter(isKnownPlayer);
        const allyCountriesAll = sideCountryList(war.participants, participant.side, country);
        const allyEverPlayer = allyCountriesAll.filter(isKnownPlayer);
        // Full side INCLUDING self - see excludeSubjectsOfPresentOverlords'
        // `presentList` param comment for why this is needed for A.
        const allySideFull = sideCountryList(war.participants, participant.side);

        // Same PvP-only gate as computeFromLedger below: a war only scores
        // if the enemy side has at least one country ever known to be
        // player-controlled - a coalition war against a purely-AI side is
        // "player vs AI" reference data, not a PvP result, and shouldn't
        // move Llama Points. Once confirmed PvP, E/A count only the player
        // countries on each side so an AI call-in doesn't dilute/inflate
        // the score either direction. These stay based on "ever known to be
        // played", NOT current/hidden status - a war fought while an
        // opponent was still legitimately active shouldn't have its E/A
        // (and therefore its score) rewritten just because that player
        // later got hidden.
        const isPvP = enemyEverPlayer.length > 0;
        const matchesMode = mode === "pve" ? !isPvP : isPvP;
        // Keyed off the row's own true isPvP nature, NOT the requested
        // `mode` - a war is either really PvP or really PvE regardless of
        // which tab you're currently looking at it from, so its E/A numbers
        // must stay the same either way (this used to key off `mode`
        // instead, which meant the exact same war could show DIFFERENT E/A
        // depending on whether you viewed it as a scored row under one mode
        // or an excluded reference row under the other - confirmed as a
        // real bug via an end-to-end test with a real 30-country vassal
        // cluster, not just reasoning about it). PvP counts ONLY ever-player
        // enemies/allies (an AI call-in shouldn't dilute/inflate a PvP
        // score). PvE's enemy side is by definition all-AI, so E is the
        // full enemy country count instead - minus any vassal/subject whose
        // own overlord is fighting alongside it on the same side (see
        // excludeSubjectsOfPresentOverlords) so "the Ottomans + 3 vassals"
        // reads as one fight against one empire, not four separate
        // enemies; A gets the same subject-filtering treatment (the
        // player's own vassals joining their PvE conquest shouldn't count
        // as extra "allies" diluting the score either).
        // Kept as the actual lists (not just their .length) so a PvE row can
        // show WHO the enemy/allies were - see the identical comment in
        // computeFromLedger below for why.
        const enemyList = isPvP ? enemyEverPlayer : excludeSubjectsOfPresentOverlords(enemyCountriesAll, overlordOf);
        const allyList = isPvP ? allyEverPlayer : excludeSubjectsOfPresentOverlords(allyCountriesAll, overlordOf, allySideFull);
        const E = enemyList.length;
        const A = allyList.length;

        function attributedPlayerForCountry(c) {
          const cands = candidatesByCountry.get(c) || [];
          return currentPlayerByCountry.get(c) || cands[cands.length - 1] || null;
        }
        // A single save has no continuous history, so this can't tell WHEN
        // mid-campaign a player departed (unlike the ledger view) - but the
        // manual Hide list is a reliable, date-independent signal: if every
        // once-player enemy in this war is now a hidden/departed player,
        // the fight is against a phantom by the time anyone's looking at
        // it, and shouldn't move anyone's score either direction. Only
        // meaningful in PvP mode - a PvE war's opponent is AI and never
        // "departs".
        const enemyActivePlayer = enemyEverPlayer.filter((c) => !excludedPlayers.has(attributedPlayerForCountry(c)));
        const active = !war.concluded;
        const autoExcludeReason = excludedPlayers.has(player)
          ? "player-hidden"
          : !matchesMode
            ? mode === "pve"
              ? "vs-player"
              : "vs-ai"
            : mode === "pvp" && enemyActivePlayer.length === 0
              ? "opponent-departed"
              : null;
        const hasOverrideExcluded = typeof override.excluded === "boolean";
        // Active wars are unconditionally excluded (no win/loss to score yet)
        // regardless of any override - only a concluded war's exclusion is
        // actually up for grabs, between the user's override and the vs-ai default.
        const excluded = active || (hasOverrideExcluded ? override.excluded : autoExcludeReason !== null);
        const condottieri = override.condottieri === true;
        const hasOverrideWin = typeof override.win === "boolean";
        const win = hasOverrideWin ? override.win : heuristic.winnerSide !== null ? participant.side === heuristic.winnerSide : null;
        const uncertain = hasOverrideWin ? false : heuristic.uncertain;

        let warScore = null;
        if (!excluded && win !== null) warScore = warScoreFor(E, A, win ? 1 : 0, condottieri);

        rows.push({
          warNumber: war.number,
          country,
          countryTag: (countryByNumber.get(country) || {}).tag || null,
          player,
          candidates,
          ambiguous,
          side: participant.side,
          revolt: war.revolt,
          revolter: participant.revolter,
          startDate: war.startDate,
          endDate: war.endDate,
          active,
          E,
          A,
          enemies: labelAndSortByLocationCount(enemyList, (c) => countryByNumber.get(c)),
          allies: labelAndSortByLocationCount(allyList, (c) => countryByNumber.get(c)),
          isPvP,
          win,
          uncertain,
          heuristicReason: heuristic.reason,
          condottieri,
          excluded,
          autoExcludeReason: hasOverrideExcluded ? null : autoExcludeReason,
          warScore,
        });
      }
    }

    // Seed every CURRENT player with a zero-war baseline first, so a player
    // who never fought a war still shows up on the leaderboard (GP_Score
    // alone), rather than only players who appear in a war row.
    const byPlayer = new Map();
    for (const p of result.players || []) {
      if (!p.name) continue;
      byPlayer.set(p.name, { player: p.name, vpTotal: 0, vpPositive: 0, vpNegative: 0, warCount: 0, scoredWarCount: 0, uncertainCount: 0 });
    }
    for (const row of rows) {
      if (!row.player) continue;
      let agg = byPlayer.get(row.player);
      if (!agg) {
        agg = { player: row.player, vpTotal: 0, vpPositive: 0, vpNegative: 0, warCount: 0, scoredWarCount: 0, uncertainCount: 0 };
        byPlayer.set(row.player, agg);
      }
      agg.warCount++;
      if (row.uncertain && !row.excluded) agg.uncertainCount++;
      if (typeof row.warScore === "number") {
        agg.vpTotal += row.warScore;
        if (row.warScore >= 0) agg.vpPositive += row.warScore;
        else agg.vpNegative += row.warScore;
        agg.scoredWarCount++;
      }
    }

    const leaderboard = [];
    for (const [name, agg] of byPlayer) {
      if (excludedPlayers.has(name)) continue;
      const player = (result.players || []).find((p) => p.name === name);
      const country = player && typeof player.countryNumber === "number" ? countryByNumber.get(player.countryNumber) : null;
      // Alpaca Points (PVE mode) are the player's raw PVE war performance
      // only, per the user's request - GP Score is a world-standing/economic
      // baseline that has nothing to do with how well someone's doing
      // against AI specifically, unlike PVP's Llama Points where it's an
      // intentional baseline everyone starts with. Zeroed rather than just
      // excluded from the total so the leaderboard chart's segment
      // breakdown (which reads gpScore directly) doesn't show a "GP
      // contribution" sliver that isn't actually counted.
      const gpScore = mode === "pve" ? null : country ? gpScoreFromRank(country.greatPowerRank) : null;
      leaderboard.push({
        player: name,
        countryTag: country ? country.tag : null,
        color: country ? country.color : null,
        gpScore,
        vpTotal: agg.vpTotal,
        vpPositive: agg.vpPositive,
        vpNegative: agg.vpNegative,
        llamaPoints: mode === "pve" ? agg.vpTotal : (gpScore || 0) / 100 + agg.vpTotal,
        warCount: agg.warCount,
        scoredWarCount: agg.scoredWarCount,
        uncertainCount: agg.uncertainCount,
      });
    }
    leaderboard.sort((a, b) => b.llamaPoints - a.llamaPoints);

    return { rows, leaderboard };
  }

  function dateKey(date) {
    if (!date || typeof date !== "string") return 0;
    const parts = date.split(".").map((p) => parseInt(p, 10) || 0);
    while (parts.length < 4) parts.push(0);
    return parts[0] * 100000000 + parts[1] * 1000000 + parts[2] * 10000 + parts[3];
  }

  function countryLabel(country, fallback) {
    if (!country) return fallback || "?";
    return country.tag || country.name || fallback || String(country.number || "?");
  }

  // Same signal, weighed the same way as llama-score-automatic-logging-
  // machine/llama-log-machine.js's inferOutcome() - duplicated rather than
  // shared because that file is Node-only (fs, path) and this one loads as
  // a plain <script> in the browser. Recomputed fresh here from the war's
  // own raw fields instead of trusting a war-event's stored
  // `inferredOutcome` at face value, so a fix to this logic (like the one
  // below) retroactively corrects every campaign already on disk without
  // needing to delete and re-record any of it.
  //
  // Confirmed wrong on real data: a war where the attacker held 238 of 259
  // contested locations (92%, about as decisive a split as this game
  // produces) still had a lone defenderScore=5 lingering (attackerScore
  // already cleared to null) - the old priority order trusted that
  // single-sided leftover score over the occupation split and called a
  // Defender win the user confirmed was actually a clear Attacker win. A
  // lone surviving score value is most likely a partial-clear artifact from
  // EU5's own end-of-war cleanup (both fields are normally cleared
  // together - see the module comment above), not a real signal - unlike a
  // direct two-sided comparison (both scores present at once) or the
  // physical occupation snapshot, so it's now only consulted as a fallback
  // when occupation itself has nothing to say.
  // Restricts a side's economy delta to just the war's ORIGINALLY-declared
  // belligerent(s) (war.originalAttacker - a single country; war.
  // originalDefenders - can be more than one at declaration) instead of the
  // full "side" (which can grow mid-war via called allies/revolters).
  // Confirmed real failure mode this fixes: a player can fully annex an
  // unrelated coalition member as part of the peace deal, which swings that
  // whole SIDE's aggregate location count wildly even though the actual two
  // principals' land didn't meaningfully change hands between each other -
  // the old aggregate-only check could credit the wrong side with "winning"
  // off a windfall against a third party while the player was simultaneously
  // losing land to the actual opposing player. Falls back to the full side
  // aggregate only when the principal(s) have no tracked delta at all (e.g.
  // never appeared in an "interesting countries" snapshot) - `usedPrincipal`
  // tells the caller which source it got, so a comparison built from a
  // fallback isn't trusted as fully as one built from clean principal data
  // on both sides.
  function principalCountrySet(value) {
    const set = new Set();
    if (typeof value === "number") set.add(value);
    else if (Array.isArray(value)) for (const n of value) if (typeof n === "number") set.add(n);
    return set;
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

  function economicOutcomeSignal(war, economy) {
    if (!economy || !economy.Attacker || !economy.Defender) return null;
    const attackerPrincipals = principalCountrySet(war.originalAttacker);
    const defenderPrincipals = principalCountrySet(war.originalDefenders);

    const aLoc = resolveSideField(economy.Attacker, attackerPrincipals, "locationDelta");
    const dLoc = resolveSideField(economy.Defender, defenderPrincipals, "locationDelta");
    const aGoldR = resolveSideField(economy.Attacker, attackerPrincipals, "goldDelta");
    const dGoldR = resolveSideField(economy.Defender, defenderPrincipals, "goldDelta");

    const aLocations = aLoc.value;
    const dLocations = dLoc.value;
    const aGold = aGoldR.value;
    const dGold = dGoldR.value;
    const signals = [];

    if (typeof aLocations === "number" && typeof dLocations === "number") {
      const spread = aLocations - dLocations;
      // Both principal sides must show a REAL (nonzero) location change for
      // this to be evidence of land actually exchanged between THEM
      // specifically. Confirmed on real data (pure-reparations wars where
      // the loser paid gold only): the loser's own location delta was
      // exactly 0 while the winner's showed an unrelated nonzero swing (some
      // other war/colonization concluding in the same snapshot window, not
      // land taken from this opponent) - the old check treated 0 as
      // "opposite sign" from any nonzero value and wrongly called that a
      // clean two-sided transfer. A genuine bilateral transfer moves both
      // sides' counts in real, opposite directions (e.g. -24 / +24, an exact
      // mirror); one side sitting at exactly 0 proves nothing came from/went
      // to this opponent, whatever the other side's unrelated change was.
      if (aLocations !== 0 && dLocations !== 0 && Math.abs(spread) >= 2 && Math.sign(aLocations) !== Math.sign(dLocations)) {
        const clean = aLoc.usedPrincipal && dLoc.usedPrincipal;
        signals.push({
          winnerSide: spread > 0 ? "Attacker" : "Defender",
          reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
          strength: Math.abs(spread) * 1000,
        });
      }
    } else if (typeof aLocations === "number" || typeof dLocations === "number") {
      const side = typeof aLocations === "number" ? "Attacker" : "Defender";
      const value = typeof aLocations === "number" ? aLocations : dLocations;
      const clean = side === "Attacker" ? aLoc.usedPrincipal : dLoc.usedPrincipal;
      if (Math.abs(value) >= 1) {
        signals.push({
          winnerSide: value > 0 ? side : side === "Attacker" ? "Defender" : "Attacker",
          reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
          strength: Math.abs(value) * 1000,
        });
      }
    }

    if (typeof aGold === "number" && typeof dGold === "number") {
      const spread = aGold - dGold;
      if (Math.abs(spread) >= 100) {
        signals.push({ winnerSide: spread > 0 ? "Attacker" : "Defender", reason: "post-war-treasury-swing", strength: Math.abs(spread) });
      }
    } else if (typeof aGold === "number" || typeof dGold === "number") {
      const side = typeof aGold === "number" ? "Attacker" : "Defender";
      const value = typeof aGold === "number" ? aGold : dGold;
      if (value > 100) signals.push({ winnerSide: side, reason: "post-war-treasury-gain", strength: value });
    }

    // Prestige deliberately NOT considered here anymore - see prestigeSignal
    // below and inferOutcome's comment for why it's a contributing factor
    // only, never decisive on its own.

    if (!signals.length) return null;
    signals.sort((a, b) => b.strength - a.strength);
    return signals[0];
  }

  // Prestige swing alone (diplomatic reputation, not land or gold) - kept as
  // a CONTRIBUTING factor only (see inferOutcome), never decisive: unlike
  // land/gold, prestige moves constantly for reasons that have nothing to do
  // with a specific war (tech, religion, other diplomacy elsewhere), so
  // trusting it to crown a winner risks the exact same false-positive shape
  // economicOutcomeSignal's own nonzero-both-sides fix just had to correct
  // for location counts.
  function prestigeSignal(war, economy) {
    if (!economy || !economy.Attacker || !economy.Defender) return null;
    const attackerPrincipals = principalCountrySet(war.originalAttacker);
    const defenderPrincipals = principalCountrySet(war.originalDefenders);
    const aPrestige = resolveSideField(economy.Attacker, attackerPrincipals, "prestigeDelta").value;
    const dPrestige = resolveSideField(economy.Defender, defenderPrincipals, "prestigeDelta").value;
    if (typeof aPrestige !== "number" || typeof dPrestige !== "number") return null;
    const spread = aPrestige - dPrestige;
    if (Math.abs(spread) < 5) return null;
    return { winnerSide: spread > 0 ? "Attacker" : "Defender" };
  }

  // Battle-inflicted casualties (Battle+Capture, NOT Attrition) compared
  // between sides - unlike Attrition, which a large/far-from-home invading
  // army racks up regardless of whether it's winning (confirmed on a real
  // concluded war: the attacker held 92% of contested territory yet had the
  // only recorded losses, all Attrition, none Battle - a clean Attacker win
  // with a heavily attrited army, not a contradiction), Battle/Capture
  // losses are actually inflicted by the other side, so a lopsided split is
  // a real (if indirect) signal of who's losing the fight. Needs a minimum
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

  function inferOutcome(war, economy) {
    const aScore = war.attackerScore;
    const dScore = war.defenderScore;
    const lossSignal = battleLossSignal(war);
    const scoreSignal =
      typeof aScore === "number" && typeof dScore === "number" && aScore !== dScore
        ? { winnerSide: aScore > dScore ? "Attacker" : "Defender" }
        : null;
    const prestSignal = prestigeSignal(war, economy);

    // Per your call: war score, prestige, and battle losses never decide a
    // winner on their own anymore - each one moves for reasons that don't
    // reliably track who actually won THIS specific war (a two-sided war
    // score is frequently a partial-clear artifact from EU5's own
    // end-of-war cleanup; prestige swings constantly from unrelated
    // diplomacy/tech/religion - see prestigeSignal's comment; a winning
    // invader can still rack up heavy battle losses). Only land or gold
    // actually changing hands between the two principals
    // (economicOutcomeSignal) decides who won a war; everything else is
    // attached below as contributingFactors so the reasoning stays visible/
    // auditable without ever being trusted to pick a side by itself - not
    // even when several of them happen to agree.
    function finalize(result) {
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
      if (prestSignal) contributingFactors.push({ signal: "prestige-swing", winnerSide: prestSignal.winnerSide });
      if (lossSignal) contributingFactors.push({ signal: "battle-losses", winnerSide: lossSignal.winnerSide });
      return { ...result, confidence, lossSignalAgrees, contributingFactors };
    }

    // The only decisive check in this function: before/after territory and
    // treasury change, restricted to the war's two original principals (see
    // economicOutcomeSignal's own comments for the nonzero-both-sides fix
    // and the principal/coalition split). Land transfer gets "high"
    // confidence (about as unambiguous as this game's data gets); a
    // gold-only signal gets "medium" (real, but a country's treasury swings
    // for other reasons too, just less commonly by this much right as a war
    // ends).
    const economicSignal = economicOutcomeSignal(war, economy);
    if (economicSignal) {
      return finalize({
        winnerSide: economicSignal.winnerSide,
        confidence: economicSignal.reason === "post-war-land-transfer" ? "high" : "medium",
        reason: economicSignal.reason,
      });
    }

    // Deliberately NOT falling back to war.occupation (who's occupying more
    // contested territory at the moment the war disappears) here - confirmed
    // wrong on real data twice now: the module comment above already found
    // it called 4 of 5 real wars for the wrong side even as the PRIMARY
    // signal. Occupying land mid-war is not the same as keeping it - only
    // the economic/land-transfer signal above (a real before/after
    // comparison) can tell those apart, so this heuristic is retired rather
    // than kept as a lower-confidence guess.

    // No land or gold actually changed hands between the two principals -
    // default to White Peace. Confirmed on real data that this genuinely
    // happens (a real war fought entirely against non-player countries near
    // "Strasinet" ended with no score/occupation/economic signal at all
    // pointing either way, and really was a white peace in game), and per
    // your call it's also the right default when the ONLY things pointing
    // either way are war score/prestige/battle-losses - those are still
    // attached as contributingFactors above for anyone auditing the call,
    // but a white peace costs nothing to get right, and the per-row manual
    // override still corrects it if this genuinely was decisive.
    return finalize({ winnerSide: null, confidence: "medium", reason: "white-peace", whitePeace: true });
  }

  // Automatic "player has left" detection for the ledger view, so an
  // abandoned country's later wars don't score for OR against anyone -
  // the concern that motivated this (see js/app.js) is a remaining player
  // farming free wins off a teammate's now-AI-controlled shell once they've
  // stopped playing. A single save can never tell "no longer played" apart
  // from "still played, just not by anyone we've seen a session for" (see
  // player_session_handling / the README's played_country writeup) - but
  // the recorder takes a snapshot every time it notices a new autosave, so
  // scanning that real history for a country that visibly had a live
  // player and then visibly stopped (attributed via a LATER snapshot, not
  // just a gap where the country wasn't otherwise mentioned) is a genuine,
  // automatic signal, not a guess. A country that reappears with a player
  // again later (a reconnect, or someone else taking the seat) un-departs.
  //
  // Only countries this method actually re-observes with zero players get
  // marked - a country that simply never comes up again (no war touches it)
  // has no signal either way and is left alone rather than assumed departed.
  function buildDepartureDates(snapshots) {
    const sorted = (snapshots || []).slice().sort((a, b) => dateKey(a.date) - dateKey(b.date));
    const everActive = new Set();
    const departedAt = new Map();
    for (const snapshot of sorted) {
      const countryBlocks = {};
      if (snapshot.countries && typeof snapshot.countries === "object") Object.assign(countryBlocks, snapshot.countries);
      if (snapshot.economyCountries && typeof snapshot.economyCountries === "object") Object.assign(countryBlocks, snapshot.economyCountries);
      for (const [numStr, info] of Object.entries(countryBlocks)) {
        const num = Number(numStr);
        if (!Number.isFinite(num) || !info) continue;
        const hasPlayer = Array.isArray(info.players) && info.players.length > 0;
        if (hasPlayer) {
          everActive.add(num);
          departedAt.delete(num);
        } else if (everActive.has(num) && !departedAt.has(num)) {
          departedAt.set(num, snapshot.date);
        }
      }
    }
    return departedAt;
  }

  // `mode` ("pvp", the default, or "pve") - see the identical parameter on
  // computeLlamaScores above for the full rationale; this is the same split
  // applied to the campaign-ledger data source instead of a single save.
  function computeFromLedger(snapshots, events, overrides, excludedPlayers, mode) {
    overrides = overrides || {};
    snapshots = snapshots || [];
    events = events || [];
    excludedPlayers = excludedPlayers || new Set();
    mode = mode === "pve" ? "pve" : "pvp";

    // The recorder can now persist a snapshot that arrived chronologically
    // out of order (a fast-saving source can hand it content out of turn
    // relative to when it actually gets read - see llama-log-machine.js's
    // processParsedFile) rather than dropping it, so every "last value
    // wins" accumulation below needs to walk snapshots in DATE order, not
    // raw file/array order, or an out-of-order straggler appearing later
    // in the file could overwrite genuinely-latest data with stale values.
    const snapshotsByDate = snapshots.slice().sort((a, b) => dateKey(a.date) - dateKey(b.date));

    const latestCountryByNumber = new Map();
    const playerCountries = new Map();
    // A player who forms a new nation (tag switch) mid-campaign keeps
    // fighting under a different country number afterward - playerCountries
    // above deliberately keeps BOTH the old and new number's association
    // (needed so an older war's country number still resolves back to this
    // player), but the leaderboard's displayed GP Score/tag should reflect
    // whichever country the player controls NOW, not whichever one they
    // happened to be seen in first. Snapshots are walked in date order here
    // (see the out-of-order comment above), so the last write per player
    // wins - i.e. this ends up holding each player's most recently known
    // country by the time the loop finishes.
    const latestCountryByPlayer = new Map();
    for (const snapshot of snapshotsByDate) {
      const countryBlocks = [];
      if (snapshot.countries && typeof snapshot.countries === "object") countryBlocks.push(...Object.values(snapshot.countries));
      if (snapshot.economyCountries && typeof snapshot.economyCountries === "object") countryBlocks.push(...Object.values(snapshot.economyCountries));
      for (const c of countryBlocks) {
        if (c && typeof c.number === "number") latestCountryByNumber.set(c.number, c);
      }
      for (const c of snapshot.playerCountries || []) {
        if (!c || typeof c.number !== "number") continue;
        latestCountryByNumber.set(c.number, c);
        for (const player of c.players || []) {
          if (!playerCountries.has(c.number)) playerCountries.set(c.number, new Set());
          playerCountries.get(c.number).add(player);
          latestCountryByPlayer.set(player, c.number);
        }
      }
    }

    const latestSnapshot = snapshotsByDate[snapshotsByDate.length - 1] || null;
    const currentPlayers = new Map();
    for (const c of (latestSnapshot && latestSnapshot.playerCountries) || []) {
      if (typeof c.number === "number" && c.players && c.players.length) currentPlayers.set(c.number, c.players[0]);
    }

    const departedAt = buildDepartureDates(snapshotsByDate);
    function departedBy(country, byDate) {
      const d = departedAt.get(country);
      return typeof d === "string" && dateKey(d) <= dateKey(byDate);
    }

    // See excludeSubjectsOfPresentOverlords()'s comment - PVE mode only.
    // `.overlord` is only present on snapshots recorded after this field was
    // added to the recorder's countrySummary() - older ledger data simply
    // has no entry here, so this is a no-op (full participant count, same
    // as before) for any war scored from pre-existing snapshots.
    function overlordOf(country) {
      const info = latestCountryByNumber.get(country);
      return info && typeof info.overlord === "number" ? info.overlord : undefined;
    }

    const rows = [];
    const seen = new Set();
    // A war-disappeared event with no lastWar means the recorder never had a
    // chance to capture that war's state before it vanished from the save
    // (e.g. a restart lost in-memory tracking of it before hydrateStateFromSnapshots()
    // existed/ran) - unscoreable, not just uncertain, so it's counted
    // separately rather than silently dropped with no explanation.
    const disappearedEvents = events.filter((event) => event && event.type === "war-disappeared");
    const finishedEvents = disappearedEvents.filter((event) => event.lastWar);
    const unscoreableCount = disappearedEvents.length - finishedEvents.length;
    finishedEvents.sort((a, b) => dateKey(a.date) - dateKey(b.date));
    for (const event of finishedEvents) {
      const war = event.lastWar;
      const outcome = inferOutcome(war, event.economyDelta);
      if (outcome.winnerSide !== "Attacker" && outcome.winnerSide !== "Defender" && !outcome.whitePeace) continue;
      const keyBase = `${event.sourceHash || event.date}:${event.warNumber}`;
      if (seen.has(keyBase)) continue;
      seen.add(keyBase);

      for (const [country, players] of playerCountries.entries()) {
        const side = participantSide(war, country);
        if (side !== "Attacker" && side !== "Defender") continue;
        const candidates = [...players];
        const override = overrides[overrideKey(event.warNumber, country)] || {};
        const player = override.player || currentPlayers.get(country) || candidates[candidates.length - 1] || null;
        if (!player) continue;
        const enemySide = side === "Attacker" ? "Defender" : "Attacker";
        const enemyCountriesAll = sideCountries(war, enemySide);
        const enemyEverPlayer = [...enemyCountriesAll].filter((c) => playerCountries.has(c));
        const allyCountriesAll = sideCountries(war, side, country);
        const allyEverPlayer = [...allyCountriesAll].filter((c) => playerCountries.has(c));
        // Full side INCLUDING self - see excludeSubjectsOfPresentOverlords'
        // `presentList` param comment for why this is needed for A.
        const allySideFull = sideCountries(war, side);

        // A war only "counts" as PvP if the enemy side has at least one
        // country that was ever recorded as player-controlled in this
        // campaign - a player's coalition war against a purely-AI side
        // isn't a PvP result, just a big fight, so it shouldn't score for
        // Llama Points (confirmed against real data: scoring it inflated/
        // deflated players' totals off wars that had no actual opponent
        // player in them at all). Once confirmed PvP, E/A count ONLY the
        // player countries on each side too - an AI call-in tagging along
        // on a player's side shouldn't dilute their war score, and one
        // tagging along on the enemy's side shouldn't inflate it. A
        // non-PvP war still gets real E/A (the full participant counts)
        // so it stays useful as "player vs AI" reference data - it's just
        // not scored.
        const isPvP = enemyEverPlayer.length > 0;
        const matchesMode = mode === "pve" ? !isPvP : isPvP;
        // Keyed off the row's own true isPvP nature, NOT the requested
        // `mode` - see computeLlamaScores' identical comment above for why
        // (a real bug otherwise: the same war could show different E/A
        // depending on which tab you viewed it from). PvE mode's enemy side
        // is by definition all-AI, so E is the full enemy country count
        // instead of the (always-zero) ever-player count, minus any
        // vassal/subject whose own overlord is also present on that side
        // (excludeSubjectsOfPresentOverlords) - "the Ottomans + 3 vassals"
        // should read as one enemy, not four. A gets the same
        // subject-filtering (the player's own vassals joining shouldn't
        // count as extra allies).
        // Kept as the actual lists (not just their .length) so a PvE row can
        // show WHO the enemy/allies were - a PvE war has no opposing PLAYER
        // row to read that off of the way a PvP war's two rows can read
        // each other's countryTag, so summarizeWars() below needs this
        // spelled out explicitly per row.
        const enemyList = isPvP ? enemyEverPlayer : excludeSubjectsOfPresentOverlords([...enemyCountriesAll], overlordOf);
        const allyList = isPvP ? allyEverPlayer : excludeSubjectsOfPresentOverlords([...allyCountriesAll], overlordOf, [...allySideFull]);
        const E = enemyList.length;
        const A = allyList.length;
        // Three states now, not two: true (win), false (loss), or null (a
        // white peace - no score for either side). override.win encodes the
        // manual-override version of that same trio as true / false /
        // the literal string "whitepeace" (not null - null needs to mean
        // "no override set" here, distinct from "explicitly overridden to
        // white peace", so it can't double as the win value itself).
        const hasOverrideWin = override.win === true || override.win === false || override.win === "whitepeace";
        const overrideWin = override.win === "whitepeace" ? null : override.win;
        const win = hasOverrideWin ? overrideWin : outcome.whitePeace ? null : side === outcome.winnerSide;

        // Auto-exclude (overridable) unless this is a genuinely live PvP
        // matchup as of the war's end: "vs-ai" (no enemy was ever a player -
        // see isPvP above), "player-departed" (this row's own country had
        // already left by the war's end - see buildDepartureDates()), or
        // "opponent-departed" (every once-player enemy had already left OR
        // is now a hidden/excluded player by the war's end - the farming
        // case this was built to close off). "player-hidden" (the user's
        // manual Hide button) takes priority over all of the above -
        // buildDepartureDates() can only ever see a departure if a snapshot
        // actually recorded the country's players list going empty, which
        // never happens for a save-only "last known controller" (see
        // player_session_handling memory) unless someone else takes over
        // the seat, so a player who just stops showing up is otherwise
        // invisible to this data and keeps scoring (and keeps counting as
        // a live opponent for whoever's still fighting them) forever.
        function attributedPlayerFor(c) {
          const cands = [...(playerCountries.get(c) || [])];
          return currentPlayers.get(c) || cands[cands.length - 1] || null;
        }
        const selfDeparted = departedBy(country, event.date);
        const enemyActivePlayer = enemyEverPlayer.filter((c) => !departedBy(c, event.date) && !excludedPlayers.has(attributedPlayerFor(c)));
        const autoExcludeReason = excludedPlayers.has(player)
          ? "player-hidden"
          : !matchesMode
            ? mode === "pve"
              ? "vs-player"
              : "vs-ai"
            : selfDeparted
              ? "player-departed"
              : mode === "pvp" && enemyActivePlayer.length === 0
                ? "opponent-departed"
                : null;
        const hasOverrideExcluded = typeof override.excluded === "boolean";
        const excluded = hasOverrideExcluded ? override.excluded : autoExcludeReason !== null;

        const condottieri = override.condottieri === true;
        // A white peace (win === null, no override) scores a flat 0 for
        // both sides rather than running through warScoreFor(), which has
        // no concept of a tie - plugging in a fake W would either credit or
        // penalize a war that, as far as the data can tell, really did
        // nothing for anyone.
        const score = excluded ? null : win === null ? 0 : warScoreFor(E, A, win ? 1 : 0, condottieri);
        const countryInfo = latestCountryByNumber.get(country);
        rows.push({
          warNumber: event.warNumber,
          player,
          candidates,
          ambiguous: candidates.length > 1,
          country,
          countryTag: countryLabel(countryInfo, "#" + country),
          side,
          winnerSide: outcome.winnerSide,
          win,
          whitePeace: win === null,
          E,
          A,
          // Who E/A actually refer to - a PvE row's enemies have no player
          // row of their own for the UI to read a name/tag off of, so this
          // is the only place that information survives to the display
          // layer. Country info comes from this same snapshot ledger's
          // latestCountryByNumber, same source as this row's own countryTag.
          enemies: labelAndSortByLocationCount(enemyList, (c) => latestCountryByNumber.get(c)),
          allies: labelAndSortByLocationCount(allyList, (c) => latestCountryByNumber.get(c)),
          isPvP,
          condottieri,
          excluded,
          autoExcludeReason: hasOverrideExcluded ? null : autoExcludeReason,
          warScore: score,
          startDate: war.startDate,
          endDate: event.date,
          reason: outcome.reason || "unknown",
          confidence: outcome.confidence || "unknown",
          contributingFactors: outcome.contributingFactors || [],
          locationDelta: event.economyDelta && event.economyDelta[side] ? event.economyDelta[side].locationDelta : null,
          goldDelta: event.economyDelta && event.economyDelta[side] ? event.economyDelta[side].goldDelta : null,
        });
      }
    }

    const byPlayer = new Map();
    for (const players of playerCountries.values()) {
      for (const player of players) {
        if (byPlayer.has(player)) continue;
        // Use the player's LATEST known country (see latestCountryByPlayer
        // above), not whichever one this particular Map entry happens to be
        // - a player who's since formed a new nation would otherwise show
        // GP Score/tag frozen on their old, pre-formation country forever.
        const country = latestCountryByPlayer.get(player);
        const countryInfo = typeof country === "number" ? latestCountryByNumber.get(country) : null;
        byPlayer.set(player, {
          player,
          country,
          countryTag: countryLabel(countryInfo, typeof country === "number" ? "#" + country : "?"),
          // Only ever populated if the recorder's compact snapshot happens to
          // carry it (it doesn't today - see llama-log-machine.js) - the
          // leaderboard chart falls back to a neutral color when this is null.
          color: countryInfo ? countryInfo.color : null,
          // Alpaca Points (PVE mode) drop GP Score entirely - see the
          // matching comment in computeLlamaScores above.
          gpScore: mode === "pve" ? null : gpScoreFromRank(countryInfo && countryInfo.gpRank),
          vpTotal: 0,
          vpPositive: 0,
          vpNegative: 0,
          warCount: 0,
          scoredWarCount: 0,
          wins: 0,
          losses: 0,
          draws: 0,
        });
      }
    }
    for (const row of rows) {
      // Excluded rows (vs-ai when mode is "pvp", vs-player when mode is
      // "pve", departed-player/opponent, hidden) shouldn't count toward
      // THIS mode's win/loss/war-count record either - without this, a PVE
      // leaderboard would show the exact same W/L/D as the PVP one, since
      // every row was tallied here regardless of which mode excluded it.
      if (row.excluded) continue;
      let agg = byPlayer.get(row.player);
      if (!agg) {
        agg = { player: row.player, country: row.country, countryTag: row.countryTag, gpScore: 0, vpTotal: 0, vpPositive: 0, vpNegative: 0, warCount: 0, scoredWarCount: 0, wins: 0, losses: 0, draws: 0 };
        byPlayer.set(row.player, agg);
      }
      agg.warCount++;
      // Three states, not two - row.win === null is a white peace, not a
      // loss (it used to fall into the `else` branch here and get counted
      // as one, before white peace was a distinct outcome).
      if (row.win === true) agg.wins++;
      else if (row.win === false) agg.losses++;
      else agg.draws++;
      if (typeof row.warScore === "number") {
        agg.vpTotal += row.warScore;
        if (row.warScore >= 0) agg.vpPositive += row.warScore;
        else agg.vpNegative += row.warScore;
        agg.scoredWarCount++;
      }
    }

    const leaderboard = [...byPlayer.values()]
      .filter((p) => !excludedPlayers.has(p.player))
      .map((p) => ({
        ...p,
        llamaPoints: mode === "pve" ? p.vpTotal : (p.gpScore || 0) / 100 + p.vpTotal,
      }));
    leaderboard.sort((a, b) => b.llamaPoints - a.llamaPoints);
    rows.sort((a, b) => dateKey(b.endDate) - dateKey(a.endDate));

    return { leaderboard, rows, latestSnapshot, unscoreableCount };
  }

  // Groups the per-participant rows either scoring function returns (one row
  // per player per war) into one entry per WAR - a war with players on both
  // sides otherwise shows as two disconnected rows with no direct way to
  // see "who beat whom" at a glance. Also tallies white peace counts split
  // by player-war vs. AI-war, since those are worth tracking separately for
  // bookkeeping even though neither contributes to anyone's score. Works
  // against either computeLlamaScores' or computeFromLedger's row shape -
  // only fields both already share (warNumber, side, isPvP, win, excluded,
  // autoExcludeReason, warScore, player, countryTag) are used; ledger rows'
  // extra `whitePeace` flag is preferred when present, since per-save rows
  // don't have one (their `win === null` already only ever means "uncertain
  // outcome", close enough to treat the same way here).
  // `mode` ("pvp", the default, or "pve") picks which half of the rows
  // becomes the returned `wars` list - the white peace tally below always
  // reflects the true PvP/AI split regardless of `mode`, since "how many
  // real player wars ended in white peace" is meaningful information either
  // way you're looking at the panel.
  function summarizeWars(rows, mode) {
    mode = mode === "pve" ? "pve" : "pvp";
    const byWar = new Map();
    for (const r of rows || []) {
      if (!byWar.has(r.warNumber)) byWar.set(r.warNumber, []);
      byWar.get(r.warNumber).push(r);
    }

    const wars = [];
    let playerWhitePeaceCount = 0;
    let aiWhitePeaceCount = 0;
    for (const [warNumber, warRows] of byWar) {
      const isPvP = warRows.some((r) => r.isPvP);
      const matchesMode = mode === "pve" ? !isPvP : isPvP;
      const isWhitePeace = warRows.some((r) => (typeof r.whitePeace === "boolean" ? r.whitePeace : r.win === null));
      if (isWhitePeace) {
        if (isPvP) playerWhitePeaceCount++;
        else aiWhitePeaceCount++;
      }
      if (!matchesMode) continue; // this list is scoped to one mode - see the white-peace counts above for the rest
      let attackers = warRows.filter((r) => r.side === "Attacker");
      let defenders = warRows.filter((r) => r.side === "Defender");
      // A PvE war only ever has real rows for the player's OWN side - the
      // opposing side is pure AI, so no country there was ever player-
      // controlled and no row was ever created for it (rows only exist per
      // playerCountries entry). Without this, that side of the table would
      // just show nothing at all, which is what prompted this - the user
      // wants to see the enemy leader plus enemy/ally counts, not a blank
      // column. Every row on the player's side already recorded exactly who
      // it fought (`enemies`, built alongside E, since an AI opponent has
      // no row of its own to read a name/tag off of) - reuse that here as
      // placeholder entries for the side that has no real rows. A genuinely
      // PvP-matching war never hits this (both sides already have real
      // rows), and a war can only ever be missing rows on ONE side at a
      // time (see the module's isPvP/matchesMode logic), so there's no risk
      // of synthesizing both sides from each other.
      function aiSidePlaceholders(realRows) {
        const source = realRows.find((r) => r.enemies && r.enemies.length);
        return source ? source.enemies.map((e) => ({ isAiSide: true, countryTag: e.tag, country: e.number })) : [];
      }
      if (attackers.length === 0 && defenders.length > 0) attackers = aiSidePlaceholders(defenders);
      else if (defenders.length === 0 && attackers.length > 0) defenders = aiSidePlaceholders(attackers);
      wars.push({
        warNumber,
        startDate: warRows[0].startDate,
        endDate: warRows[0].endDate,
        whitePeace: isWhitePeace,
        winnerSide: warRows[0].winnerSide || null,
        // Same for every row of this war (inferOutcome() runs once per
        // war-disappeared event, not once per participant) - surfaced so a
        // UI can show/let the user spot-check HOW the winner was decided
        // (land transfer vs. treasury swing vs. battle losses, etc.), not
        // just the verdict itself.
        reason: warRows[0].reason || null,
        confidence: warRows[0].confidence || null,
        contributingFactors: warRows[0].contributingFactors || [],
        attackers,
        defenders,
      });
    }
    wars.sort((a, b) => dateKey(b.endDate) - dateKey(a.endDate));
    return { wars, playerWhitePeaceCount, aiWhitePeaceCount };
  }

  return {
    computeLlamaScores,
    computeFromLedger,
    summarizeWars,
    overrideKey,
    warScoreFor,
    heuristicWinnerSide,
    gpScoreFromRank,
    excludeSubjectsOfPresentOverlords,
  };
});
