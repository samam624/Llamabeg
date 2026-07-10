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

  function distinctSideCountries(participants, side, excludeCountry) {
    const set = new Set();
    for (const p of participants) {
      if (p.side === side && p.country !== excludeCountry) set.add(p.country);
    }
    return set.size;
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
  // save).
  function computeLlamaScores(result, overrides) {
    overrides = overrides || {};
    const wars = result.wars || [];
    const candidatesByCountry = buildPlayerCandidatesByCountry(result.playerSessions);
    const currentPlayerByCountry = new Map(
      (result.players || []).filter((p) => typeof p.countryNumber === "number").map((p) => [p.countryNumber, p.name])
    );
    const countryByNumber = new Map((result.countries || []).map((c) => [c.number, c]));

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
        const E = distinctSideCountries(war.participants, enemySide);
        const A = distinctSideCountries(war.participants, participant.side, country);

        const active = !war.concluded;
        const excluded = override.excluded === true || active;
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
          win,
          uncertain,
          heuristicReason: heuristic.reason,
          condottieri,
          excluded,
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
      byPlayer.set(p.name, { player: p.name, vpTotal: 0, warCount: 0, scoredWarCount: 0, uncertainCount: 0 });
    }
    for (const row of rows) {
      if (!row.player) continue;
      let agg = byPlayer.get(row.player);
      if (!agg) {
        agg = { player: row.player, vpTotal: 0, warCount: 0, scoredWarCount: 0, uncertainCount: 0 };
        byPlayer.set(row.player, agg);
      }
      agg.warCount++;
      if (row.uncertain && !row.excluded) agg.uncertainCount++;
      if (typeof row.warScore === "number") {
        agg.vpTotal += row.warScore;
        agg.scoredWarCount++;
      }
    }

    const leaderboard = [];
    for (const [name, agg] of byPlayer) {
      const player = (result.players || []).find((p) => p.name === name);
      const country = player && typeof player.countryNumber === "number" ? countryByNumber.get(player.countryNumber) : null;
      const gpScore = country ? gpScoreFromRank(country.greatPowerRank) : null;
      leaderboard.push({
        player: name,
        countryTag: country ? country.tag : null,
        gpScore,
        vpTotal: agg.vpTotal,
        llamaPoints: (gpScore || 0) / 100 + agg.vpTotal,
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

  function computeFromLedger(snapshots, events, overrides) {
    overrides = overrides || {};
    snapshots = snapshots || [];
    events = events || [];

    const latestCountryByNumber = new Map();
    const playerCountries = new Map();
    for (const snapshot of snapshots) {
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
        }
      }
    }

    const latestSnapshot = snapshots.slice().sort((a, b) => dateKey(b.date) - dateKey(a.date))[0] || null;
    const currentPlayers = new Map();
    for (const c of (latestSnapshot && latestSnapshot.playerCountries) || []) {
      if (typeof c.number === "number" && c.players && c.players.length) currentPlayers.set(c.number, c.players[0]);
    }

    const rows = [];
    const seen = new Set();
    const finishedEvents = events.filter((event) => event && event.type === "war-disappeared" && event.lastWar);
    finishedEvents.sort((a, b) => dateKey(a.date) - dateKey(b.date));
    for (const event of finishedEvents) {
      const war = event.lastWar;
      const outcome = event.inferredOutcome || war.outcome || {};
      if (outcome.winnerSide !== "Attacker" && outcome.winnerSide !== "Defender") continue;
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
        const E = sideCountries(war, enemySide).size;
        const A = sideCountries(war, side, country).size;
        const win = typeof override.win === "boolean" ? override.win : side === outcome.winnerSide;
        const excluded = override.excluded === true;
        const condottieri = override.condottieri === true;
        const score = excluded ? null : warScoreFor(E, A, win ? 1 : 0, condottieri);
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
          E,
          A,
          condottieri,
          excluded,
          warScore: score,
          startDate: war.startDate,
          endDate: event.date,
          reason: outcome.reason || "unknown",
          confidence: outcome.confidence || "unknown",
          locationDelta: event.economyDelta && event.economyDelta[side] ? event.economyDelta[side].locationDelta : null,
          goldDelta: event.economyDelta && event.economyDelta[side] ? event.economyDelta[side].goldDelta : null,
        });
      }
    }

    const byPlayer = new Map();
    for (const [country, players] of playerCountries.entries()) {
      const countryInfo = latestCountryByNumber.get(country);
      for (const player of players) {
        if (!byPlayer.has(player)) {
          byPlayer.set(player, {
            player,
            country,
            countryTag: countryLabel(countryInfo, "#" + country),
            gpScore: gpScoreFromRank(countryInfo && countryInfo.gpRank),
            vpTotal: 0,
            warCount: 0,
            scoredWarCount: 0,
            wins: 0,
            losses: 0,
          });
        }
      }
    }
    for (const row of rows) {
      let agg = byPlayer.get(row.player);
      if (!agg) {
        agg = { player: row.player, country: row.country, countryTag: row.countryTag, gpScore: 0, vpTotal: 0, warCount: 0, scoredWarCount: 0, wins: 0, losses: 0 };
        byPlayer.set(row.player, agg);
      }
      agg.warCount++;
      if (row.win) agg.wins++;
      else agg.losses++;
      if (typeof row.warScore === "number") {
        agg.vpTotal += row.warScore;
        agg.scoredWarCount++;
      }
    }

    const leaderboard = [...byPlayer.values()].map((p) => ({
      ...p,
      llamaPoints: (p.gpScore || 0) / 100 + p.vpTotal,
    }));
    leaderboard.sort((a, b) => b.llamaPoints - a.llamaPoints);
    rows.sort((a, b) => dateKey(b.endDate) - dateKey(a.endDate));

    return { leaderboard, rows, latestSnapshot };
  }

  return { computeLlamaScores, computeFromLedger, overrideKey, warScoreFor, heuristicWinnerSide, gpScoreFromRank };
});
