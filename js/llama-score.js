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
    module.exports = factory(require("./llama-score-outcome.js"));
  } else {
    root.LlamaScore = factory(root.LlamaScoreOutcome);
  }
})(typeof self !== "undefined" ? self : this, function (Outcome) {
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

  // A "Declined" participant was invited/targeted (present in war.participants,
  // often even in originalAttacker/originalDefenders) but never actually
  // joined the fight - confirmed on real data: a country listed as an
  // original Target with status "Declined" had a DIFFERENT country join in
  // its place as a called-ally ("calledAlly" pointing at the declined one),
  // meaning the declined country itself was never a real belligerent. Left
  // untouched everywhere else (still counts as "unfought" is a valid state,
  // and "Left" - someone who genuinely joined then departed mid-war - is
  // deliberately NOT filtered here, only "Declined" is) - excluding it from
  // every side/enemy/ally derivation fixes a real user-reported bug where a
  // declined-but-listed country's tag showed up as if it were fighting in
  // TWO different wars at once (impossible in EU5) - it was never really in
  // the first one at all.
  function sideCountryList(participants, side, excludeCountry) {
    const set = new Set();
    for (const p of participants) {
      if (p.side === side && p.country !== excludeCountry && p.status !== "Declined") set.add(p.country);
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

  // Returns null for a "Declined" participant, same as if they weren't in
  // the war at all - see sideCountryList's comment above for why. Every
  // caller already treats a null side as "not really in this war" (row
  // generation skips it), so this is the single point that keeps a country
  // that declined a call-in from ever generating a row for itself.
  function participantSide(war, country) {
    const p = (war.participants || []).find((part) => part.country === country);
    return p && p.status !== "Declined" ? p.side : null;
  }

  function sideCountries(war, side, excludeCountry) {
    const set = new Set();
    for (const p of war.participants || []) {
      if (p.side === side && p.country !== excludeCountry && p.status !== "Declined") set.add(p.country);
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
  // A participant who joined a war (or got auto-added via a calledAlly
  // chain) but never recorded a single Battle or Capture loss never actually
  // fought - per the user's call, they shouldn't score (win or lose) for
  // that war, and shouldn't count toward anyone else's E/A either. Attrition
  // losses (marching/sieging/disease, not combat) deliberately don't count -
  // same battle+capture distinction battleLossSignal already uses, for the
  // same reason (attrition accrues to armies stationed in a warzone without
  // ever fighting). Returns true (count them) when there's no losses data to
  // check at all - older ledger data predates this field, and "unknown"
  // shouldn't retroactively exclude someone who may well have fought.
  function hasFoughtLosses(participant) {
    const losses = participant && participant.losses;
    if (!losses) return true;
    return (losses.battle || 0) + (losses.capture || 0) > 0;
  }

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
      // Real bug found reviewing this function: it used to loop over every
      // RAW entry in war.participants unconditionally, so a country that
      // appears more than once (left-then-rejoined the same war is a real,
      // coded status per extractWarFields' Left handling) got a row - and a
      // full score - for each entry, double-counting that player. Dedup to
      // one entry per country first, keeping the FIRST occurrence to match
      // participantSide()/sideCountries() above, which already use
      // .find()/a Set and would silently disagree with a "last entry wins"
      // choice here otherwise.
      const seenCountries = new Set();
      const dedupedParticipants = (war.participants || []).filter((p) => {
        if (typeof p.country !== "number" || seenCountries.has(p.country)) return false;
        seenCountries.add(p.country);
        return true;
      });
      // Built from the deduped list, not the raw array - a second real bug
      // found reviewing this: Map construction keeps the LAST entry for a
      // repeated key, which used to silently disagree with the FIRST-
      // occurrence choice above, so a rejoined player's fought() status
      // (and therefore their no-battle-losses auto-exclude) could read from
      // a different stint than the one actually being scored.
      const participantByCountry = new Map(dedupedParticipants.map((p) => [p.country, p]));
      const fought = (c) => hasFoughtLosses(participantByCountry.get(c));
      for (const participant of dedupedParticipants) {
        const country = participant.country;
        if (typeof country !== "number") continue;
        // Never actually joined this war (invited/targeted, declined) - see
        // sideCountryList's comment for the real bug this closes.
        if (participant.status === "Declined") continue;
        const candidates = candidatesByCountry.get(country) || [];
        const currentPlayer = currentPlayerByCountry.get(country) || null;
        if (!currentPlayer && !candidates.length) continue; // never player-controlled - AI, skip

        const key = overrideKey(war.number, country);
        const override = overrides[key] || {};
        const player = override.player || currentPlayer || candidates[candidates.length - 1] || null;
        const ambiguous = candidates.length > 1;

        const enemySide = participant.side === "Attacker" ? "Defender" : "Attacker";
        // NOT fought-filtered here - isPvP below has to be computed from the
        // real, full participant lists first (see its own comment for why),
        // so fought-filtering only ever gets applied AFTER isPvP is already
        // settled, never as an input to it.
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
        // later got hidden. Deliberately computed BEFORE any fought-status
        // filtering (see hasFoughtLosses/fought below) - a real player who
        // let their vassals do 100% of the actual fighting is still a real
        // player, and folding fought-status into this check would have
        // silently reclassified a real PvP war as PvE (or vice versa)
        // whenever the deciding side's own troops never personally engaged.
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
        // score) - and, per the user's call, only those who actually fought
        // (hasFoughtLosses) count toward that PvP total either, so a called
        // ally who joined and left without a single battle doesn't inflate
        // someone's PvP score. PvE's enemy side is by definition all-AI, so
        // E is the full enemy country count instead - minus any
        // vassal/subject whose own overlord is fighting alongside it on the
        // same side (see excludeSubjectsOfPresentOverlords) so "the Ottomans
        // + 3 vassals" reads as one fight against one empire, not four
        // separate enemies; A gets the same subject-filtering treatment.
        // Fought-status is deliberately NOT applied in PvE (unlike PvP
        // above): a PvE win is very often engineered by having vassals do
        // the actual fighting while the player's own troops never need to -
        // that's still a real, deliberate win the player should get credit
        // for, not something to exclude for lacking personal battle losses.
        // Kept as the actual lists (not just their .length) so a PvE row can
        // show WHO the enemy/allies were - see the identical comment in
        // computeFromLedger below for why.
        const enemyList = isPvP ? enemyEverPlayer.filter(fought) : excludeSubjectsOfPresentOverlords(enemyCountriesAll, overlordOf);
        const allyList = isPvP
          ? allyEverPlayer.filter(fought)
          : excludeSubjectsOfPresentOverlords(allyCountriesAll, overlordOf, allySideFull);
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
          : isPvP && !fought(country)
            ? "no-battle-losses"
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
        // Kept in the array rather than dropped (see computeFromLedger's
        // identical treatment) - a single save has no per-war dates to
        // recompute against, so a hidden player's row here may already be
        // zeroed by the "player-hidden" auto-exclude above; `hidden` is
        // still surfaced so the UI can collapse it by default without
        // pretending the row never existed.
        hidden: excludedPlayers.has(name),
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

  // principalCountrySet/overlordFor/principalsWithOverlords/
  // principalsForGold/principalFieldSum/resolveSideField/
  // principalFieldUnion/reparationsSignal/goldLikeLean/revoltOutcomeSignal/
  // economicOutcomeSignal/battleLossSignal/shiftConfidence/inferOutcome now
  // live in js/llama-score-outcome.js (Outcome, passed in above) -
  // previously duplicated here and in llama-log-machine.js as two
  // independently-maintained ~600-line copies that a whole-repo review
  // found had already drifted apart in real ways (a missing defensive
  // null-check, a loserSide field only one copy populated, a signature
  // difference). See that file's own header comment for the full
  // reasoning. Recomputed fresh from the war's own raw fields here (not
  // trusting a war-event's stored `inferredOutcome` at face value), so a
  // fix to the shared logic retroactively corrects every campaign already
  // on disk without needing to delete and re-record any of it.

  function buildControlTimeline(snapshots) {
    const sorted = (snapshots || []).slice().sort((a, b) => dateKey(a.date) - dateKey(b.date));
    const timeline = new Map(); // country -> [{date, players: string[]}], ascending
    const sameRoster = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
    for (const snapshot of sorted) {
      // A snapshot the recorder itself flagged as parsed from a broken/
      // partial read (see llama-log-machine.js's parseWarning field) reports
      // an empty or truncated countries block that looks exactly like every
      // player having simultaneously vanished. Trusting that produced a real
      // false "departed" verdict: a save-parser bug damaged 28 recorded
      // autosaves' worth of snapshots for one campaign, and the last of
      // those bad snapshots (not the last GOOD one) became "active at end"
      // for every country, permanently marking a still-actively-playing
      // player as departed with no way to un-hide them (2026-07-23).
      // Skipping flagged snapshots entirely here means the timeline's last
      // segment is always the last snapshot that actually captured real data.
      if (snapshot.parseWarning) continue;
      const countryBlocks = {};
      if (snapshot.countries && typeof snapshot.countries === "object") Object.assign(countryBlocks, snapshot.countries);
      if (snapshot.economyCountries && typeof snapshot.economyCountries === "object") Object.assign(countryBlocks, snapshot.economyCountries);
      for (const [numStr, info] of Object.entries(countryBlocks)) {
        const num = Number(numStr);
        if (!Number.isFinite(num) || !info) continue;
        const players = Array.isArray(info.players) ? info.players : [];
        const segments = timeline.get(num);
        const last = segments && segments.length ? segments[segments.length - 1] : null;
        if (!last || !sameRoster(last.players, players)) {
          if (!segments) timeline.set(num, [{ date: snapshot.date, players }]);
          else segments.push({ date: snapshot.date, players });
        }
      }
    }
    return timeline;
  }

  // `mode` ("pvp", the default, or "pve") - see the identical parameter on
  // computeLlamaScores above for the full rationale; this is the same split
  // applied to the campaign-ledger data source instead of a single save.
  function computeFromLedger(snapshots, events, overrides, excludedPlayers, mode, absentRanges) {
    overrides = overrides || {};
    snapshots = snapshots || [];
    events = events || [];
    excludedPlayers = excludedPlayers || new Set();
    mode = mode === "pve" ? "pve" : "pvp";

    // `excludedPlayers` accepts either a bare Set<name> (legacy/manual "hide
    // this name, no date info" - what the web app's own localStorage list
    // has always been) or a Map<name, departedAsOfDate> (the shared hide
    // list - see hidden-players.json/player_session_handling memory) - a
    // player marked departed as of a specific in-game date should still
    // score normally for anything that happened before that date; only a
    // Set entry (no date known at all) falls back to the old all-or-nothing
    // behavior. `departedDateFor` returns undefined (never hidden), null
    // (hidden, no date - blanket), or a date string (hidden from that point
    // on). `isDepartedAsOf` answers "should this player be treated as gone
    // by the time `atDate` happened" - the actual check every call site
    // below needs, instead of the old unconditional `excludedPlayers.has()`.
    function departedDateFor(name) {
      if (!name) return undefined;
      if (excludedPlayers instanceof Map) return excludedPlayers.has(name) ? excludedPlayers.get(name) || null : undefined;
      return excludedPlayers.has(name) ? null : undefined;
    }
    function isDepartedAsOf(name, atDate) {
      const d = departedDateFor(name);
      if (d === undefined) return false;
      if (d === null || !atDate) return true;
      return dateKey(atDate) >= dateKey(d);
    }

    // `absentRanges` (Map<name, Array<{from, to}>>, optional) is a
    // DIFFERENT, deliberately separate mechanism from the departed-as-of
    // cutoff above: a per-session attendance check ("who missed the stretch
    // since I last looked") records a BOUNDED window per miss, not a
    // one-way "gone forever" cutoff - a player who missed one session but
    // came back the next should score normally again once they return,
    // which a single cutoff date can't express. Kept as its own map/check
    // rather than folded into excludedPlayers/isDepartedAsOf so the
    // well-tested one-way-cutoff semantics of manual/shared Hide stay
    // exactly as they were - see the 2026-08-13 farming-prevention
    // investigation for why this exists (real signal was found that a
    // country IS actively customized, but nothing proves the reverse:
    // "currently AI-piloted" can't be detected from save data alone, so
    // this closes the gap with a lightweight per-session prompt instead).
    // Both ends inclusive - `to` is stored as exactly the latest snapshot's own
    // date at the moment the range was recorded (see js/app.js's
    // maybePromptSessionAttendance), a real day the review covers, not an
    // exclusive boundary. An exclusive `to` (an earlier version of this
    // function used `k < dateKey(r.to)`) let a war starting on that exact
    // last-reviewed day slip through unexcluded - the whole point of marking
    // that day absent. Matches isDepartedAsOf's inclusive cutoff above.
    function isAbsentDuring(name, atDate) {
      if (!name || !absentRanges || !atDate) return false;
      const ranges = absentRanges instanceof Map ? absentRanges.get(name) : absentRanges[name];
      if (!Array.isArray(ranges) || !ranges.length) return false;
      const k = dateKey(atDate);
      return ranges.some((r) => r && k >= dateKey(r.from) && k <= dateKey(r.to));
    }

    // The recorder can now persist a snapshot that arrived chronologically
    // out of order (a fast-saving source can hand it content out of turn
    // relative to when it actually gets read - see llama-log-machine.js's
    // processParsedFile) rather than dropping it, so every "last value
    // wins" accumulation below needs to walk snapshots in DATE order, not
    // raw file/array order, or an out-of-order straggler appearing later
    // in the file could overwrite genuinely-latest data with stale values.
    const snapshotsByDate = snapshots.slice().sort((a, b) => dateKey(a.date) - dateKey(b.date));
    // A war-disappeared event's own economyDelta is a pre-computed diff, but
    // reparationsSignal (see inferOutcome below) needs the raw enforced-
    // reparations list from the AFTER snapshot itself - looked up by
    // sourceHash, the same identifier the event already carries for its own
    // dedup key below.
    const snapshotBySourceHash = new Map();
    for (const snapshot of snapshotsByDate) {
      if (snapshot && snapshot.sourceHash) snapshotBySourceHash.set(snapshot.sourceHash, snapshot);
    }

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

    // Looks up the country's control timeline for the last segment at-or-
    // before `atDate` (falling back to the EARLIEST known segment if every
    // segment postdates `atDate` - a war that concluded before the recorder
    // ever captured this country has no better evidence to go on). Returns
    // the roster active at that point, `[]` meaning AI-controlled/departed.
    const controlTimeline = buildControlTimeline(snapshotsByDate);
    function rosterAt(country, atDate) {
      const segments = controlTimeline.get(country);
      if (!segments || !segments.length) return [];
      const atKey = dateKey(atDate);
      let result = segments[0].players;
      for (const seg of segments) {
        if (dateKey(seg.date) > atKey) break;
        result = seg.players;
      }
      return result;
    }
    function activePlayerAt(country, atDate) {
      const roster = rosterAt(country, atDate);
      return roster.length ? roster[0] : null;
    }
    // Display-only fallback for an excluded (nobody-in-control) row: "who
    // used to play this country, most recently as of atDate" rather than
    // "who plays it today" - so a war a departed player got farmed on shows
    // THEIR name (why it's excluded), not a successor's who hadn't joined
    // yet at the time. Falls back to the earliest-ever known controller only
    // if the country had no live player at all by atDate.
    function lastControllerAt(country, atDate) {
      const segments = controlTimeline.get(country);
      if (!segments || !segments.length) return null;
      const atKey = dateKey(atDate);
      let result = null;
      for (const seg of segments) {
        if (dateKey(seg.date) > atKey) break;
        if (seg.players.length) result = seg.players[0];
      }
      if (result) return result;
      const firstActive = segments.find((seg) => seg.players.length);
      return firstActive ? firstActive.players[0] : null;
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
    // A war-disappeared event with no lastWar means the recorder never had a
    // chance to capture that war's state before it vanished from the save
    // (e.g. a restart lost in-memory tracking of it before hydrateStateFromSnapshots()
    // existed/ran) - unscoreable, not just uncertain, so it's counted
    // separately rather than silently dropped with no explanation.
    const disappearedEvents = events.filter((event) => event && event.type === "war-disappeared");
    let finishedEvents = disappearedEvents.filter((event) => event.lastWar);
    let unscoreableCount = disappearedEvents.length - finishedEvents.length;
    finishedEvents.sort((a, b) => dateKey(a.date) - dateKey(b.date));
    // Real bug found on real data: the SAME war can get more than one
    // war-disappeared event if the recorder loses track of it for one
    // snapshot and reacquires it the next (confirmed real: a war vanished at
    // one date, a war-start RE-DETECTION fired shortly after for the same
    // warNumber, then it vanished again later - both disappearance events
    // carry the identical `lastWar.startDate`, proving it's one underlying
    // war, not two). The old dedup key was `sourceHash:warNumber`, which
    // doesn't catch this - each duplicate comes from a different snapshot,
    // so every participant silently got scored TWICE for the same real war.
    // Dedup on warNumber+startDate instead (startDate as a defensive check
    // against warNumber ever being reused for a genuinely different war,
    // not observed but cheap to guard), keeping the LATEST disappearance -
    // an earlier one followed by a war-start re-detection was a transient
    // tracking loss, not the war's real end; if it had been the real end,
    // no re-detection would have followed it. A war whose startDate never
    // parsed (rare, but extractWarFields can leave it null) falls back to
    // keying on sourceHash/date instead of the literal string "null" - a
    // real bug found reviewing this: two DIFFERENT wars that both lack a
    // startDate and happen to reuse the same warNumber would otherwise
    // collapse into one, silently discarding one war's outcome entirely.
    const latestByWar = new Map();
    for (const event of finishedEvents) {
      const key = event.lastWar.startDate
        ? `${event.warNumber}:${event.lastWar.startDate}`
        : `${event.warNumber}:sh:${event.sourceHash || event.date}`;
      const existing = latestByWar.get(key);
      if (!existing || dateKey(event.date) >= dateKey(existing.date)) latestByWar.set(key, event);
    }
    finishedEvents = [...latestByWar.values()].sort((a, b) => dateKey(a.date) - dateKey(b.date));
    for (const event of finishedEvents) {
      const war = event.lastWar;
      const afterSnapshot = event.sourceHash ? snapshotBySourceHash.get(event.sourceHash) : null;
      const afterCountries = afterSnapshot ? Object.assign({}, afterSnapshot.countries, afterSnapshot.economyCountries) : null;
      // Every event here came from `war-disappeared` (finishedEvents, above)
      // - disappeared is always true for this call site, matching the
      // recorder's own equivalent call when it first builds this same event.
      const outcome = Outcome.inferOutcome(war, true, event.economyDelta, afterSnapshot ? afterSnapshot.warReparations : null, afterCountries);
      // Real bug found reviewing this: this dedup now runs BEFORE this
      // decisiveness check (it used to run after), so if the true latest
      // event for a war can't be scored (e.g. its snapshot was pruned), the
      // war used to still have a chance via an earlier duplicate - now it
      // silently produces zero rows instead. Deliberately NOT falling back
      // to an earlier duplicate's outcome here: per the comment above, an
      // earlier duplicate is a transient tracking-loss event, not the war's
      // real end, so its own "decisive" outcome would be computed from a
      // truncated/wrong window - using it would trade a loud gap for a
      // quiet wrong answer. Counting it alongside the existing
      // no-recorded-state case instead keeps the loss visible in the UI
      // rather than silent.
      if (outcome.winnerSide !== "Attacker" && outcome.winnerSide !== "Defender" && !outcome.whitePeace) {
        unscoreableCount++;
        continue;
      }

      // First occurrence wins (Map.set only when unseen), matching
      // participantSide()'s .find() semantics just above - a country that
      // left and rejoined this war (two entries) must resolve fought() from
      // the same stint participantSide() itself is already keying off of,
      // not whichever entry happens to be last in the raw array.
      const participantByCountry = new Map();
      for (const p of war.participants || []) {
        if (typeof p.country === "number" && !participantByCountry.has(p.country)) participantByCountry.set(p.country, p);
      }
      const fought = (c) => hasFoughtLosses(participantByCountry.get(c));

      for (const [country, players] of playerCountries.entries()) {
        const side = participantSide(war, country);
        if (side !== "Attacker" && side !== "Defender") continue;
        const candidates = [...players];
        const override = overrides[overrideKey(event.warNumber, country)] || {};
        // Attributed to whoever actually controlled this country as of THIS
        // war's own end date, not whoever controls it now - see
        // buildControlTimeline's comment for why "now" was wrong for a
        // country that's changed human hands more than once.
        const player = override.player || activePlayerAt(country, event.date) || lastControllerAt(country, event.date) || candidates[candidates.length - 1] || null;
        if (!player) continue;
        const enemySide = side === "Attacker" ? "Defender" : "Attacker";
        // NOT fought-filtered here - isPvP below has to be computed from the
        // real, full participant lists first (see its own comment for why).
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
        // Computed from the full, unfiltered lists above - see their own
        // comment for why fought-status can't be an input to this without
        // risking a real PvP war (where the deciding side's own troops never
        // personally engaged, only their vassals) silently reclassifying as
        // PvE.
        const isPvP = enemyEverPlayer.length > 0;
        const matchesMode = mode === "pve" ? !isPvP : isPvP;
        // Keyed off the row's own true isPvP nature, NOT the requested
        // `mode` - see computeLlamaScores' identical comment above for why
        // (a real bug otherwise: the same war could show different E/A
        // depending on which tab you viewed it from). PvP counts only
        // ever-player enemies/allies who also actually fought
        // (hasFoughtLosses) - a called-in ally who joined and left without a
        // single battle doesn't inflate someone's PvP score. PvE mode's
        // enemy side is by definition all-AI, so E is the full enemy country
        // count instead of the (always-zero) ever-player count, minus any
        // vassal/subject whose own overlord is also present on that side
        // (excludeSubjectsOfPresentOverlords) - "the Ottomans + 3 vassals"
        // should read as one enemy, not four. A gets the same
        // subject-filtering (the player's own vassals joining shouldn't
        // count as extra allies). Fought-status is deliberately NOT applied
        // in PvE (unlike PvP): a PvE win is very often engineered by having
        // vassals do the actual fighting while the player's own troops never
        // need to - that's still a real win the player should get credit
        // for, not something to exclude for lacking personal battle losses.
        // Kept as the actual lists (not just their .length) so a PvE row can
        // show WHO the enemy/allies were - a PvE war has no opposing PLAYER
        // row to read that off of the way a PvP war's two rows can read
        // each other's countryTag, so summarizeWars() below needs this
        // spelled out explicitly per row.
        const enemyList = isPvP ? enemyEverPlayer.filter(fought) : excludeSubjectsOfPresentOverlords([...enemyCountriesAll], overlordOf);
        const allyList = isPvP
          ? allyEverPlayer.filter(fought)
          : excludeSubjectsOfPresentOverlords([...allyCountriesAll], overlordOf, [...allySideFull]);
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
        // matchup as of the war's START: "vs-ai" (no enemy was ever a
        // player - see isPvP above), "player-departed" (this row's own
        // country already had nobody actively controlling it - reverted to
        // AI - by the time THIS war BEGAN, see buildControlTimeline()), or
        // "opponent-departed" (every once-player enemy had already left OR
        // is now a hidden/excluded player by the time THIS war BEGAN - the
        // farming case this was built to close off).
        //
        // Deliberately keyed to the war's START, not its end (an earlier
        // version checked the end date instead): a player who was actively
        // playing when a war began and only disconnected partway through it
        // fought a real fight, and that fight should still count for (or
        // against) them - per the user's explicit call, only a LATER war,
        // one that didn't even begin until after they'd already left for
        // good, is fighting a phantom and should be excluded. Checking at
        // the war's end wrongly zeroed out a war's entire score the moment
        // a player disconnected anywhere near its conclusion, even after
        // playing out the whole thing up to that point - confirmed as a
        // real bug, not just a theoretical one, and the same fix applies
        // symmetrically to "opponent-departed" (a war whose enemy stuck
        // around for the start still counts, even if they too vanish
        // before it concludes).
        //
        // "player-hidden" (the user's manual Hide button, or the automatic
        // shared hidden-players list) takes priority over all of the above -
        // the timeline can only ever see a departure if a snapshot actually
        // recorded the country's players list going empty, which never
        // happens for a save-only "last known controller" (see
        // player_session_handling memory) unless someone else takes over
        // the seat, so a player who just stops showing up with no successor
        // is otherwise invisible to this data. `isDepartedAsOf` scopes this
        // to the war's START date, same as the timeline-based checks below -
        // a war that had already begun before the hide-date still counts
        // (real fight, real score), only a LATER war fighting a phantom
        // gets excluded. A legacy bare-Set entry (no date attached) has no
        // such cutoff and excludes every war, same as before this existed.
        function attributedPlayerFor(c) {
          const cands = [...(playerCountries.get(c) || [])];
          return activePlayerAt(c, war.startDate) || lastControllerAt(c, war.startDate) || cands[cands.length - 1] || null;
        }
        // Departed-as-of (permanent, one-way) and absent-during (a bounded
        // per-session miss) are two different DATA SOURCES for the same
        // question - "was this player really available to fight as of this
        // date" - so every exclusion check below treats them the same way.
        function isUnavailableAsOf(name, atDate) {
          return isDepartedAsOf(name, atDate) || isAbsentDuring(name, atDate);
        }
        const selfDeparted = !activePlayerAt(country, war.startDate);
        const selfAbsent = isAbsentDuring(player, war.startDate);
        const enemyActivePlayer = enemyEverPlayer.filter(
          (c) => activePlayerAt(c, war.startDate) && !isUnavailableAsOf(attributedPlayerFor(c), war.startDate)
        );
        // A revolt war (INDEPENDENCE_WAR_NAME/CIVIL_WAR_NAME, `war.revolt`)
        // is fighting your own rebels/pretender, not a foreign AI nation -
        // per the user's explicit call, this shouldn't move PVE/Alpaca
        // Points either direction regardless of who won, so it's excluded
        // outright rather than folded into "vs-ai" (which still scores
        // normally). Checked before the mode/vs-ai split since it applies
        // the same way in both modes (a revolt is never PvP in practice -
        // confirmed on real data, every revolter is AI - so this is a no-op
        // for PVP mode either way).
        // Real bug found reviewing this: isUnavailableAsOf() folds together
        // TWO different causes (the old Hide/departed cutoff AND the new
        // attendance-based absence), but this used to route BOTH to
        // "player-hidden" unconditionally - the "player-departed" tooltip
        // text was edited this session to explicitly describe the
        // attendance case ("...or was marked absent for this session"), yet
        // no code path could ever actually produce that reason for it. Only
        // the Hide/departed-cutoff cause (isDepartedAsOf) still maps to
        // "player-hidden"; attendance-absence now joins selfDeparted under
        // "player-departed", matching what the tooltip already claims.
        const autoExcludeReason = isDepartedAsOf(player, war.startDate)
          ? "player-hidden"
          : war.revolt
            ? "revolt"
            : isPvP && !fought(country)
              ? "no-battle-losses"
              : !matchesMode
                ? mode === "pve"
                  ? "vs-player"
                  : "vs-ai"
                : selfDeparted || selfAbsent
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
          warName: war.warName || null,
          reason: outcome.reason || "unknown",
          confidence: outcome.confidence || "unknown",
          contributingFactors: outcome.contributingFactors || [],
          breakdown: outcome.breakdown || [],
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

    // A hidden/departed player's row STAYS in the leaderboard array (not
    // dropped) - their vpTotal/gpScore above already reflects only the wars
    // that happened before their departure date (or their real total, for a
    // legacy blanket hide), so this is real earned/lost score, not noise.
    // `hidden: true` is how the UI defaults them out of view (same collapse-
    // by-default pattern as "Hide checked-off wars") without deleting the
    // number - see [[player_session_handling]].
    const leaderboard = [...byPlayer.values()].map((p) => ({
      ...p,
      hidden: departedDateFor(p.player) !== undefined,
      hiddenSince: departedDateFor(p.player) || null,
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
        warName: warRows[0].warName || null,
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
        breakdown: warRows[0].breakdown || [],
        attackers,
        defenders,
      });
    }
    wars.sort((a, b) => dateKey(b.endDate) - dateKey(a.endDate));
    return { wars, playerWhitePeaceCount, aiWhitePeaceCount };
  }

  // "Which player names has the desktop tracker actually seen leave, as of
  // the latest snapshot" - for auto-hiding a departed player from the map/
  // Players table without the user needing to click Hide themselves (that
  // button remains the MANUAL override; this is the automatic companion,
  // per user request). Reuses the same control timeline computeFromLedger
  // already builds for war-scoring's "player-departed" categorization
  // (buildControlTimeline above) - a name counts as departed if it appears
  // in ANY country's control timeline (it was really played by someone,
  // not a parser artifact) but is absent from every country's LATEST known
  // roster (nobody currently in control anywhere is that name). A player
  // who switched countries mid-campaign still shows up in their new
  // country's latest roster, so they're correctly NOT flagged departed.
  function computeDepartedPlayers(snapshots) {
    const timeline = buildControlTimeline(snapshots);
    const everSeen = new Set();
    const activeAtEnd = new Set();
    for (const segments of timeline.values()) {
      if (!segments.length) continue;
      for (const seg of segments) for (const name of seg.players) everSeen.add(name);
      for (const name of segments[segments.length - 1].players) activeAtEnd.add(name);
    }
    const departed = new Set();
    for (const name of everSeen) if (!activeAtEnd.has(name)) departed.add(name);
    return departed;
  }

  // Automatic "fully automated = departed" detection (an "every automation
  // flag enabled at once" heuristic) was tried and removed: `automatedSystems`
  // can prove a country IS actively customized by a human (2026-08-13 - no
  // real AI country in a real ~2500-country population ever shows anything
  // but exactly ["ProductionMethods"]), but it can't prove the reverse - a
  // real, present player who simply never touches any automation toggle
  // (confirmed on real data: a real player showed that exact same
  // ["ProductionMethods"]-only signature) is indistinguishable from AI by
  // this field alone. No other candidate signal in the save format
  // (per-unit `activity_type`, `played_country`'s UI-state counters, a
  // broad keyword sweep for anything session/connection-shaped) held up
  // either once checked against real data. Manual "Fix players"/Hide remain
  // the only mechanism for this.

  return {
    computeLlamaScores,
    computeFromLedger,
    computeDepartedPlayers,
    summarizeWars,
    overrideKey,
    warScoreFor,
    heuristicWinnerSide,
    gpScoreFromRank,
    excludeSubjectsOfPresentOverlords,
    dateKey,
  };
});
