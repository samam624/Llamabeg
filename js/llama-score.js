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
      const participantByCountry = new Map((war.participants || []).map((p) => [p.country, p]));
      const fought = (c) => hasFoughtLosses(participantByCountry.get(c));
      for (const participant of war.participants) {
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
  // `war.originalAttacker`/`war.originalDefenders` record who the game
  // DECLARED as belligerents, not who actually showed up - a country invited/
  // targeted but never joining (status "Declined", see sideCountryList's
  // comment) still appears here. Real bug found on real data: a declined
  // defender's own (unrelated) location gain got summed together with the
  // REAL defender's real location LOSS in the same principal set, netting to
  // ~0 and masking a clean, decisive land transfer as a White Peace - the
  // declined country was never actually fighting, so whatever else was
  // happening to its territory that same month has nothing to do with this
  // war. Excluded here so a Declined "principal" contributes nothing to any
  // economic signal, the same way it's already excluded from the displayed
  // participant lists.
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
  // (confirmed by the user from real play - "the overlord will auto take
  // over if i attack a vassal") - the war's own participant list already
  // records this: the Overlord's own participant entry has `reason ===
  // "Overlord"` and `calledAlly` pointing at the vassal it's defending.
  // Looked up per-war (not from a country's current `.overlord` field,
  // which only reflects present-day status) since that's the actual
  // mechanic that pulled them in, self-contained in data already on the war
  // object.
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
    // overlord. `reason === "Subject"` participants (real subjects, called
    // in specifically because they belong to a principal already in this
    // set) get folded in, transitively - a subject can itself have its own
    // subjects fighting too, confirmed real in an actual campaign war (a
    // 3-level chain: a county subject of a duchy subject of the kingdom
    // itself). Deliberately does NOT pull in "InternationalOrganization" or
    // any other non-Subject call-in reason - those are genuinely separate
    // political entities dragged in by an alliance/league mechanic, not
    // part of the principal's own realm, and stay excluded per the original
    // coalition-vs-principal design (see the land-transfer signal's own
    // comment) - only a REAL subject counts here.
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
  // Gold is different: per the user's call, "you can never exchange money
  // with a vassal only with the overlord in a peace" - a vassal has no
  // treasury standing of its own in a peace deal, so when a principal has an
  // Overlord present, the Overlord REPLACES it for gold purposes rather than
  // being added alongside it (unlike location, this is not a union).
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
  // ID lists (locationsGained/locationsLost - see llama-log-machine.js's
  // locationSetDelta) instead of the net number - lets a war's real land
  // exchange be inspected directly rather than just trusting a spread, per
  // the user's explicit request. Union across every principal on the side
  // (a coalition-of-subjects can each contribute their own gained/lost
  // provinces). Only ever populated for wars recorded after the ownedLocations
  // data model existed - null (not an empty array) when nothing in this
  // side's principals carries it, so the UI can tell "no exchange" apart
  // from "no data for this older war".
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
  // ~10 in-game years, far longer than war_manager keeps a concluded war's
  // own record around. "first"/payer is the war's LOSER, "second"/receiver is
  // the WINNER - confirmed against a real save's already-independently-
  // validated outcome, not assumed (see llama-log-machine.js's copy of this
  // function, kept in sync deliberately, for the full derivation writeup).
  // Uses the same gold-principal substitution as the treasury-swing signal (a
  // vassal has no treasury standing in a peace), and only considers an
  // obligation that started on or after this war's own start date - one from
  // years earlier between the same two countries would be a leftover from a
  // DIFFERENT war.
  function reparationsSignal(war, warReparations, attackerGoldPrincipals, defenderGoldPrincipals) {
    if (!Array.isArray(warReparations) || !warReparations.length) return null;
    const startKey = dateKey(war.startDate);
    let best = null;
    let bestKey = null;
    for (const rep of warReparations) {
      if (typeof rep.payer !== "number" || typeof rep.receiver !== "number") continue;
      const repKey = dateKey(rep.startDate);
      if (repKey < startKey) continue;
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
      reason: "post-war-reparations-enforced",
      // Deliberately larger than any land/gold strength value so this always
      // wins the sort below when present.
      strength: Number.MAX_SAFE_INTEGER,
    };
  }

  // Reads a resolved-side-field's two values and reports a directional LEAN
  // only when both sides show real, opposite-signed movement of a real
  // (>=100) magnitude on whichever side is gaining - the exact same rigor
  // the old treasury-swing DECISIVE check used, just repurposed for a
  // non-decisive lean (see economicOutcomeSignal's big comment on why
  // treasury/prestige no longer get to crown a winner at all).
  function goldLikeLean(aValue, dValue) {
    if (typeof aValue !== "number" || typeof dValue !== "number") return null;
    if (aValue === 0 || dValue === 0 || Math.sign(aValue) === Math.sign(dValue)) return null;
    const gainerValue = aValue > 0 ? aValue : dValue;
    if (Math.abs(gainerValue) < 100) return null;
    return aValue > dValue ? "Attacker" : "Defender";
  }

  // A war whose own internal goal is literally "gain independence" - the
  // game tags this directly (war.warName === "INDEPENDENCE_WAR_NAME", see
  // js/clausewitz.js's extractWarFields and test/debug-war-name.js for the
  // derivation), and by definition of this war type the ATTACKER is always
  // the vassal fighting to break free, with the (former) overlord auto-
  // joining the DEFENDER side. Land/gold rarely change hands in an
  // independence peace (confirmed on real data: a real independence war
  // showed 0/0 land and only a modest, non-decisive treasury swing, even
  // though the outcome was completely unambiguous) - without this signal,
  // that shape falls through to White Peace despite a real, decisive result.
  //
  // Deliberately does NOT need "before the war" snapshot data - EU5 already
  // guarantees the pre-war relationship (that's what this war type means),
  // so the only thing left to check is whether the vassal is STILL subject
  // to one of the war's original defenders by the time the war disappears -
  // if the AFTER snapshot's dependency data is gone (or points elsewhere),
  // the vassal achieved independence; if it still points at one of the
  // defenders, they lost and remain subjugated. (An earlier, more complex
  // design compared dependency status before vs. after the war, using
  // multi-snapshot history - abandoned once this simpler, more direct check
  // was found: the vassal's own `overlord` field reads null almost
  // immediately upon DECLARING an independence war, not just upon winning
  // it, which would have made a before/after comparison unreliable for
  // exactly the case this exists to catch.)
  // `war.revolt` covers BOTH INDEPENDENCE_WAR_NAME (a vassal fighting to
  // break free) and CIVIL_WAR_NAME (a pretender contesting the throne) - the
  // rebel/pretender is always the ATTACKER (confirmed on real data: 7/7
  // revolt wars in a real campaign had `revolter: true` on the Attacker
  // side, never the Defender).
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
  // comment) with `overlord` already cleared, the OLD `stillSubjugated`
  // check read that as "independence achieved" and credited the ATTACKER
  // with a win - the exact inverted-outcome bug the user reported (full
  // annexation of a rebel scored as a loss). Fixed: a rebel with no land
  // left (vanished OR `locationCount === 0`) is checked FIRST and is always
  // a Defender win (crushed), regardless of what its `overlord` field says -
  // only a rebel that's still a going concern with real land afterward falls
  // through to the subjugation check below.
  function revoltOutcomeSignal(war, afterCountries) {
    if (!war.revolt) return null;
    const attacker = war.originalAttacker;
    const defenders = war.originalDefenders || [];
    if (typeof attacker !== "number" || !afterCountries) return null;
    const info = afterCountries[attacker];
    const crushed = !info || (typeof info.locationCount === "number" && info.locationCount === 0);
    if (crushed) {
      return { winnerSide: "Defender", reason: "post-war-revolt-crushed", strength: Number.MAX_SAFE_INTEGER };
    }
    // The "still subjugated to a defender = they lost, independence not
    // granted" check only makes sense for an actual INDEPENDENCE_WAR_NAME (a
    // real vassal/overlord relationship to test) - a CIVIL_WAR_NAME
    // pretender that's still around with land afterward has no equivalent
    // relationship to check, so it falls through to land-transfer/
    // reparations instead of guessing here.
    if (war.warName !== "INDEPENDENCE_WAR_NAME") return null;
    const stillSubjugated = typeof info.overlord === "number" && defenders.includes(info.overlord);
    return {
      winnerSide: stillSubjugated ? "Defender" : "Attacker",
      reason: "post-war-independence-granted",
      // Same tier as reparations - a direct state check, not an inferred delta.
      strength: Number.MAX_SAFE_INTEGER,
    };
  }

  // Returns { decisive, contributing, breakdown }: `decisive` is the single
  // strongest qualifying DECISIVE signal (or null - only reparations, land
  // transfer, and independence are eligible, see below), `contributing` is
  // every OTHER DECISIVE-eligible signal that also qualified but lost out,
  // and `breakdown` is a full numeric account of every factor this function
  // looked at (decisive or not) for the UI's expandable "how was this
  // decided" detail view.
  //
  // Per the user's explicit call: treasury swing, like prestige before it,
  // is being DEMOTED from decisive to informational-only. Real data this
  // session found repeated false positives from it even after two rounds of
  // tightening the threshold (a big campaigning army outspending a defender
  // regardless of outcome; one side hemorrhaging money on unrelated war
  // costs while the other only incidentally gained a little) - the user's
  // read is that gold, like prestige, has too many reasons to swing that
  // have nothing to do with who actually won THIS war. Only land transfer (a
  // real before/after territory comparison), enforced war reparations, and
  // granted independence (both literal, non-inferred peace-treaty facts) are
  // trusted to crown a winner now. Treasury and prestige are still computed
  // and surfaced - as contributingFactors/breakdown entries, same tier as
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
    // Prestige reuses the gold-principal substitution (an overlord replaces
    // a vassal, per the same "a vassal has no standing of its own in a
    // peace" reasoning) - it's informational only, so this is a judgment
    // call, not a load-bearing one.
    const aPrestigeR = resolveSideField(economy.Attacker, attackerGoldPrincipals, "prestigeDelta");
    const dPrestigeR = resolveSideField(economy.Defender, defenderGoldPrincipals, "prestigeDelta");

    const aLocations = aLoc.value;
    const dLocations = dLoc.value;
    const aGold = aGoldR.value;
    const dGold = dGoldR.value;
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
      const winnerSide = spread > 0 ? "Attacker" : "Defender";
      if (
        aLocations !== 0 &&
        dLocations !== 0 &&
        Math.abs(spread) >= 2 &&
        Math.sign(aLocations) !== Math.sign(dLocations)
      ) {
        const clean = aLoc.usedPrincipal && dLoc.usedPrincipal;
        landApplies = true;
        landWinner = winnerSide;
        signals.push({
          winnerSide,
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
      // The actual location IDs behind the numbers above, when available
      // (see principalFieldUnion's comment) - null for a war recorded before
      // this data existed, not an empty array, so the UI can tell the two
      // apart.
      attackerLocationsGained: principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsGained"),
      attackerLocationsLost: principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsLost"),
      defenderLocationsGained: principalFieldUnion(economy.Defender, defenderPrincipals, "locationsGained"),
      defenderLocationsLost: principalFieldUnion(economy.Defender, defenderPrincipals, "locationsLost"),
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

  // Maps an economicOutcomeSignal reason code to the short label used in
  // contributingFactors, so a land signal that LOST out to reparations (see
  // economicOutcomeSignal's `contributing`) still shows up as "considered
  // but not decisive" the same way war-score/battle-losses do.
  const CONTRIBUTING_SIGNAL_FROM_REASON = {
    "post-war-reparations-enforced": "reparations",
    "post-war-independence-granted": "independence",
    "post-war-revolt-crushed": "independence",
    "post-war-land-transfer": "land-transfer",
    "post-war-land-transfer-coalition": "land-transfer",
  };

  function inferOutcome(war, economy, warReparations, afterCountries) {
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

    // Per your explicit call: war score, battle losses, occupation,
    // treasury, and prestige never decide a winner on their own - each one
    // moves for reasons that don't reliably track who actually won THIS
    // specific war (a two-sided war score is frequently a partial-clear
    // artifact from EU5's own end-of-war cleanup; a winning invader can
    // still rack up heavy battle losses; occupying land mid-war isn't the
    // same as keeping it; treasury and prestige both swing from
    // battles/events/unrelated spending as often as from the war's actual
    // outcome). Only land transfer (a real before/after territory
    // comparison) and enforced war reparations (economicOutcomeSignal, a
    // literal peace-treaty term) decide who won; everything else is
    // attached below as contributingFactors/breakdown so the reasoning stays
    // visible/auditable without ever being trusted to pick a side by itself
    // - not even when several of them happen to agree.
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
      return { ...result, confidence, lossSignalAgrees, contributingFactors, breakdown: fullBreakdown };
    }

    // The only decisive checks in this function: an enforced reparations
    // obligation (strongest - see reparationsSignal) and before/after
    // territory change, restricted to the war's two original principals
    // (see economicOutcomeSignal's own comments for the nonzero-both-sides
    // fix and the principal/coalition split). Both get "high" confidence
    // (about as unambiguous as this game's data gets).
    if (economicSignal.decisive) {
      return finalize(
        {
          winnerSide: economicSignal.decisive.winnerSide,
          confidence: "high",
          reason: economicSignal.decisive.reason,
        },
        economicSignal.contributing
      );
    }

    // Deliberately NOT falling back to war.occupation (who's occupying more
    // contested territory at the moment the war disappears) to DECIDE
    // anything here - confirmed wrong on real data twice now: the module
    // comment above already found it called 4 of 5 real wars for the wrong
    // side even as the PRIMARY signal. Occupying land mid-war is not the
    // same as keeping it - only land TRANSFER (a real before/after
    // comparison) and enforced reparations can tell those apart. Occupation
    // is still surfaced above as a breakdown/contributingFactors entry
    // (informational only, same tier as war-score/battle-losses/treasury/
    // prestige), just never used to pick a winner.

    // No reparations were enforced and no land actually changed hands
    // between the two principals - default to White Peace. Confirmed on
    // real data that this genuinely happens (a real war fought entirely
    // against non-player countries near "Strasinet" ended with no
    // score/occupation/economic signal at all pointing either way, and
    // really was a white peace in game), and per your call it's also the
    // right default when the ONLY things pointing either way are war
    // score/battle-losses/occupation/treasury/prestige - those are still
    // attached as contributingFactors/breakdown above for anyone auditing
    // the call, but a white peace costs nothing to get right, and the
    // per-row manual override still corrects it if this genuinely was
    // decisive.
    return finalize({ winnerSide: null, confidence: "medium", reason: "white-peace", whitePeace: true }, economicSignal.contributing);
  }

  // Automatic "who actually controlled this country when THIS war ended"
  // detection for the ledger view - a country's controlling player can
  // change more than once over a campaign (departs, reconnects, or a
  // different human takes over the same seat entirely - confirmed real in
  // the user's own data, see player_session_handling memory), and a war's
  // outcome must be attributed to whoever was actually playing it at the
  // time, not whoever happens to be playing it NOW. A single save can never
  // tell "no longer played" apart from "still played, just not by anyone
  // we've seen a session for" (see player_session_handling) - but the
  // recorder takes a snapshot every time it notices a new autosave, so
  // walking that real history in date order and recording every point where
  // a country's `players` list actually changes builds a genuine per-country
  // control TIMELINE, not just a guess.
  //
  // This deliberately replaced an earlier design that tracked only a single
  // "currently departed as of the latest snapshot" Map per country - that
  // shape is fundamentally wrong for a country that changes hands more than
  // once: the moment ANY later snapshot showed a new/returning player, the
  // whole departure record for that country was deleted, silently
  // un-excluding every war that concluded during the genuinely-abandoned
  // window in between (confirmed via a synthetic repro: a reconnect at a
  // LATER date retroactively made an earlier "farmed while abandoned" war
  // score again, credited to the WRONG, later player who never fought it).
  // A timeline of segments, queried by "who was in control as of date X",
  // fixes both problems at once - see controlTimelineAsOf() below.
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
  function computeFromLedger(snapshots, events, overrides, excludedPlayers, mode) {
    overrides = overrides || {};
    snapshots = snapshots || [];
    events = events || [];
    excludedPlayers = excludedPlayers || new Set();
    mode = mode === "pve" ? "pve" : "pvp";

    // `excludedPlayers` accepts either a bare Set<name> (legacy/manual "hide
    // this name, no date info" - what the web app's own localStorage list
    // has always been) or a Map<name, departedAsOfDate> (the shared hide
    // list - see hidden-players.json/[[player_session_handling]]) - a
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
      const afterSnapshot = event.sourceHash ? snapshotBySourceHash.get(event.sourceHash) : null;
      const afterCountries = afterSnapshot ? Object.assign({}, afterSnapshot.countries, afterSnapshot.economyCountries) : null;
      const outcome = inferOutcome(war, event.economyDelta, afterSnapshot ? afterSnapshot.warReparations : null, afterCountries);
      if (outcome.winnerSide !== "Attacker" && outcome.winnerSide !== "Defender" && !outcome.whitePeace) continue;
      const keyBase = `${event.sourceHash || event.date}:${event.warNumber}`;
      if (seen.has(keyBase)) continue;
      seen.add(keyBase);

      const participantByCountry = new Map((war.participants || []).map((p) => [p.country, p]));
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
        const selfDeparted = !activePlayerAt(country, war.startDate);
        const enemyActivePlayer = enemyEverPlayer.filter(
          (c) => activePlayerAt(c, war.startDate) && !isDepartedAsOf(attributedPlayerFor(c), war.startDate)
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

  // The exact set of automation-delegation options EU5 exposes as of this
  // writing (confirmed empirically against real save data spanning multiple
  // campaigns, not guessed - see player_session_handling memory / the
  // comment on `automatedSystems` in js/clausewitz.js): every genuinely
  // AI-only country in a real, unmodified save carries ONLY
  // "ProductionMethods", the single default, with zero exceptions across a
  // full ~2500-country population. A human player can selectively enable
  // any subset of the rest for convenience. The length check alongside the
  // name check is a deliberate belt-and-suspenders: if a future game patch
  // adds new automation options, a country with "every flag that exists in
  // THIS save, whatever they're named" still trips the length threshold
  // even before this constant gets updated for the new names.
  const FULL_AUTOMATION_FLAGS = new Set([
    "ProductionMethods",
    "ArmyBuilder",
    "Buildings",
    "Cabinet",
    "CabinetMembers",
    "CloseBuildings",
    "Credit",
    "CultureAcceptance",
    "DestroyBuildings",
    "DestroyEstateBuildings",
    "Estates",
    "ExpandBuildings",
    "ExpandRGO",
    "Exploration",
    "Finances",
    "GovernmentReforms",
    "Laws",
    "NavyBuilder",
    "Privateers",
    "ReligiousDoctrines",
    "ReplaceAdmirals",
    "ReplaceGenerals",
    "Research",
    "Rgo",
    "Rivals",
  ]);
  function isFullyAutomated(automatedSystems) {
    if (!Array.isArray(automatedSystems) || automatedSystems.length < FULL_AUTOMATION_FLAGS.size) return false;
    for (const flag of FULL_AUTOMATION_FLAGS) if (!automatedSystems.includes(flag)) return false;
    return true;
  }

  // Per the user's explicit call: "if you see every automation flag on then
  // they are AI [...] auto exclude from metrics maps and future scoring."
  // Returns Map<playerName, departedAsOfDate> - the SAME shape as the
  // shared hidden-players.json list (see [[player_session_handling]]'s
  // 2026-07-15 update), so it merges into the exact same date-aware
  // exclusion pipeline computeFromLedger already has for the manual Hide
  // button, no separate code path needed. `departedAsOf` is the EARLIEST
  // snapshot where the country has been continuously fully-automated
  // through to the latest snapshot (walking backward from the end) - a war
  // that concluded before automation kicked in still counts as a real fight
  // by whoever was actually playing then, only a later one fighting a
  // phantom gets excluded, same reasoning as every other departure signal
  // in this file. Only ever fires on a country's CURRENT state (the last
  // snapshot must still be fully-automated) - a player who briefly toggled
  // everything on and then reverted is not flagged.
  function computeAutomationDepartures(snapshots) {
    const sorted = (snapshots || []).slice().sort((a, b) => dateKey(a.date) - dateKey(b.date));
    const byCountry = new Map();
    for (const snapshot of sorted) {
      for (const c of snapshot.playerCountries || []) {
        if (!c || typeof c.number !== "number") continue;
        if (!byCountry.has(c.number)) byCountry.set(c.number, []);
        byCountry.get(c.number).push({ date: snapshot.date, automatedSystems: c.automatedSystems, players: c.players || [] });
      }
    }
    const result = new Map();
    for (const history of byCountry.values()) {
      if (!history.length) continue;
      const last = history[history.length - 1];
      if (!isFullyAutomated(last.automatedSystems)) continue;
      let departedAsOf = last.date;
      for (let i = history.length - 1; i >= 0; i--) {
        if (!isFullyAutomated(history[i].automatedSystems)) break;
        departedAsOf = history[i].date;
      }
      for (const name of last.players) if (!result.has(name)) result.set(name, departedAsOf);
    }
    return result;
  }

  return {
    computeLlamaScores,
    computeFromLedger,
    computeDepartedPlayers,
    computeAutomationDepartures,
    summarizeWars,
    overrideKey,
    warScoreFor,
    heuristicWinnerSide,
    gpScoreFromRank,
    excludeSubjectsOfPresentOverlords,
  };
});
