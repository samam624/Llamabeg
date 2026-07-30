// Small dependency-free SVG line chart for the historical trend panels
// (population / tax base over time). Not a general charting library - just
// enough for "N player-nation series over a shared year axis."
(function (root) {
  "use strict";

  // Dark-surface categorical palette (validated against the chart surface
  // #2b2015) - used only as a fallback if the CSS custom properties below
  // are somehow missing; the light-mode equivalent (also validated) lives in
  // css/style.css as --chart-series-1..8 under :root[data-theme="light"],
  // not duplicated here - see chartTokens(). Dark is this app's default
  // theme (a product choice, not tied to OS preference).
  const SERIES_COLORS_FALLBACK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

  // Reads the *current* theme's chart tokens from CSS custom properties
  // (css/style.css's :root / :root[data-theme="light"]) at the moment a
  // chart is rendered, rather than hardcoding two parallel JS palettes that
  // could drift out of sync with the CSS ones - toggling the theme just
  // means re-running whichever render function last drew a given chart (see
  // js/app.js's theme toggle handler).
  function chartTokens() {
    const cs = getComputedStyle(document.documentElement);
    const g = (name) => (cs.getPropertyValue(name) || "").trim();
    const series = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g(`--chart-series-${i}`) || SERIES_COLORS_FALLBACK[i - 1]);
    const isDark = document.documentElement.dataset.theme !== "light";
    return {
      surface: g("--chart-surface") || "#2b2015",
      gridline: g("--chart-gridline") || "#b7a877",
      axisText: g("--chart-axis-text") || "#c9b98c",
      labelText: g("--chart-label-text") || "#f1e6c8",
      totalBar: g("--chart-total-bar") || "#c25b4f",
      series,
      isDark,
    };
  }

  function fmtCompact(n) {
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (abs >= 1000) return (n / 1000).toFixed(1) + "k";
    if (abs > 0 && abs < 1) return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    if (abs < 10) return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    if (abs < 100) return n.toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
    return n.toFixed(0);
  }

  // Rounds a raw "span / target count" step up to the nearest 1/2/5/10 (at
  // whatever power of ten it falls in) - the standard "nice axis" trick, so
  // gridlines land on round numbers (0, 5, 10, 15...) instead of whatever an
  // even division of the padded data range happens to produce (22.7, 17.0,
  // 11.3...) - the latter is exactly what makes a chart read as an
  // un-styled spreadsheet default rather than something someone designed.
  function niceStep(rawStep) {
    if (!(rawStep > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return niceNorm * mag;
  }

  // Nice round tick VALUES that fall inside [min, max] - doesn't change the
  // chart's own scale/domain (each chart's own headroom-padding logic stays
  // as-is), just picks better values within it to draw gridlines/labels at.
  function pickNiceTicks(min, max, targetCount) {
    if (!(max > min)) return [min];
    const step = niceStep((max - min) / (targetCount || 4));
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.round(v / step) * step);
    }
    return ticks.length ? ticks : [min];
  }

  function parseCssColor(str) {
    if (!str) return null;
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
  }

  // A country's real flag/map color can be pale enough (cream, light tan,
  // off-white) to nearly vanish against this app's own light parchment
  // chart surface - darken it just enough to stay legible as a line or a
  // filled bar, leave already-dark colors untouched. In dark mode the risk
  // runs the other way (a near-black color vanishing against the dark
  // surface), so the direction this pushes a color flips with the theme.
  // Chart-local concern (the map itself, and the country-tag color swatches
  // elsewhere in the UI, still show the real unmodified color).
  function legibleChartColor(cssColor, isDark) {
    const rgb = parseCssColor(cssColor);
    if (!rgb) return null;
    const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    if (isDark) {
      const MIN_LUMINANCE = 95;
      if (luminance >= MIN_LUMINANCE) return cssColor;
      const blend = Math.min(0.65, ((MIN_LUMINANCE - luminance) / 255) * 1.3);
      return `rgb(${rgb.map((c) => Math.round(c + (255 - c) * blend)).join(",")})`;
    }
    const MAX_LUMINANCE = 190;
    if (luminance <= MAX_LUMINANCE) return cssColor;
    const factor = MAX_LUMINANCE / luminance;
    return `rgb(${rgb.map((c) => Math.round(c * factor)).join(",")})`;
  }

  // A fixed-fraction-darker shade of a color, for a bar/segment's own
  // hairline border - keeps every bar visually defined against the chart
  // surface and its neighbors regardless of how light or dark its own fill
  // happens to be, without introducing an unrelated border color.
  function darkenColor(cssColor, amount) {
    const rgb = parseCssColor(cssColor);
    if (!rgb) return cssColor;
    return `rgb(${rgb.map((c) => Math.round(c * (1 - amount))).join(",")})`;
  }

  // series: [{ label, color, points: number[] }], all points arrays the
  // same length, aligned to `years` (same length, ascending).
  function renderLineChart(container, { title, years, series, yScale, yMin, yMax }) {
    const theme = chartTokens();
    const W = 720,
      H = 300;
    const padL = 52,
      padR = 18,
      padT = 18,
      padB = 32;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const s of series) {
      for (const v of s.points) {
        if (typeof v === "number") {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
      }
    }
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
      dataMin = 0;
      dataMax = 1;
    }
    if (Number.isFinite(yMin) && Number.isFinite(yMax) && yMax > yMin) {
      dataMin = yMin;
      dataMax = yMax;
    }
    const span = Math.max(1e-9, dataMax - dataMin);
    const tightScale = yScale === "tight";
    const clusteredPositive = dataMin > 0 && dataMin / Math.max(dataMax, 1e-9) > 0.25;
    let minY = tightScale || clusteredPositive ? dataMin - span * 0.18 : 0;
    let maxY = dataMax + span * 0.18;
    if (!tightScale) minY = Math.max(0, minY);
    if (maxY <= minY) {
      const pad = Math.max(Math.abs(dataMax || 0) * 0.08, 0.001);
      minY = tightScale ? dataMin - pad : 0;
      maxY = dataMax + pad;
    }

    const xAt = (i) => padL + (years.length <= 1 ? 0 : (i / (years.length - 1)) * plotW);
    const yAt = (v) => {
      const raw = (v - minY) / (maxY - minY);
      const t = tightScale ? Math.max(0, Math.min(1, raw)) : raw;
      return padT + plotH - t * plotH;
    };

    let gridLines = "";
    let yLabels = "";
    pickNiceTicks(minY, maxY, 4).forEach((v) => {
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${theme.gridline}" stroke-width="1" opacity="0.72"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${theme.axisText}">${fmtCompact(v)}</text>`;
    });

    const xTickEvery = Math.max(1, Math.round(years.length / 8));
    let xLabels = "";
    for (let i = 0; i < years.length; i += xTickEvery) {
      xLabels += `<text x="${xAt(i)}" y="${H - padB + 18}" text-anchor="middle" font-size="10" fill="${theme.axisText}">${years[i]}</text>`;
    }

    let lines = "";
    let dots = "";
    series.forEach((s, si) => {
      const color = legibleChartColor(s.color, theme.isDark) || theme.series[si % theme.series.length];
      const segments = [];
      let current = [];
      s.points.forEach((v, i) => {
        if (typeof v === "number") current.push(`${xAt(i)},${yAt(v)}`);
        else if (current.length) {
          segments.push(current);
          current = [];
        }
      });
      if (current.length) segments.push(current);
      lines += segments
        .filter((pts) => pts.length > 1)
        .map((pts) => `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" data-series="${si}"/>`)
        .join("");
      const lastIdx = s.points.map((v, i) => (typeof v === "number" ? i : -1)).filter((i) => i >= 0).pop();
      const lastVal = lastIdx !== undefined ? s.points[lastIdx] : undefined;
      if (typeof lastVal === "number") {
        dots += `<circle cx="${xAt(lastIdx)}" cy="${yAt(lastVal)}" r="4.2" fill="${color}" stroke="${theme.surface}" stroke-width="2"/>`;
      }
    });

    const legend = series
      .map((s, si) => {
        const color = legibleChartColor(s.color, theme.isDark) || theme.series[si % theme.series.length];
        return `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${color}"></span>${escapeHtml(s.label)}</span>`;
      })
      .join("");

    const svgId = "chart-" + Math.random().toString(36).slice(2, 9);
    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg id="${svgId}" viewBox="0 0 ${W} ${H}" class="trend-chart" role="img" aria-label="${escapeHtml(title)}">
        <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(46,42,34,0.025)" rx="4"/>
        ${gridLines}
        ${yLabels}
        ${xLabels}
        ${lines}
        ${dots}
        <line class="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="${theme.axisText}" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>
      </svg>
      <div class="chart-tooltip" hidden></div>
      <div class="chart-legend">${legend}</div>
    `;

    const svg = container.querySelector("svg");
    const crosshair = svg.querySelector(".chart-crosshair");
    const tooltip = container.querySelector(".chart-tooltip");

    svg.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      const idx = Math.max(0, Math.min(years.length - 1, Math.round(((svgX - padL) / plotW) * (years.length - 1))));
      const cx = xAt(idx);
      crosshair.setAttribute("x1", cx);
      crosshair.setAttribute("x2", cx);
      crosshair.setAttribute("visibility", "visible");

      const rows = series
        .map((s, si) => ({ s, si, v: s.points[idx] }))
        .sort((a, b) => {
          const av = typeof a.v === "number" ? a.v : -Infinity;
          const bv = typeof b.v === "number" ? b.v : -Infinity;
          return bv - av;
        })
        .map(({ s, si, v }) => {
          const color = legibleChartColor(s.color, theme.isDark) || theme.series[si % theme.series.length];
          return `<div class="chart-tooltip-row"><span class="chart-legend-swatch" style="background:${color}"></span>${escapeHtml(s.label)}: <b>${
            typeof v === "number" ? fmtCompact(v) : "—"
          }</b></div>`;
        })
        .join("");
      tooltip.innerHTML = `<div class="chart-tooltip-year">${years[idx]}</div>${rows}`;
      tooltip.hidden = false;
      tooltip.style.left = Math.min(e.clientX - rect.left + 12, rect.width - 180) + "px";
      tooltip.style.top = e.clientY - rect.top + 12 + "px";
    });
    svg.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });
  }

  // Values in this app's one bar-chart use case (Llama Points) are tens to
  // low hundreds - fmtCompact's 0-decimal rounding erases the precision the
  // scores are actually computed to (e.g. 62.8 vs 63), so use 1 decimal
  // below the range where fmtCompact's k/M suffixes start being useful.
  function fmtScore(n) {
    return Math.abs(n) >= 1000 ? fmtCompact(n) : n.toFixed(1);
  }

  // Ranked vertical bar chart (the Llama score leaderboard) - one bar per
  // player, sorted descending, gridlines + a zero baseline, value printed
  // above (or below, for negative scores) each bar, color key in a legend
  // underneath rather than axis labels (player names can be long).
  function renderBarChart(container, { title, items }) {
    const theme = chartTokens();
    const sorted = (items || []).slice().sort((a, b) => b.value - a.value);
    const n = Math.max(1, sorted.length);

    const padL = 44,
      padR = 16,
      padT = 20,
      padB = 24;
    const H = 280;
    const plotH = H - padT - padB;
    // The SVG has no width/height attribute, so the browser scales the
    // whole viewBox to fill the container width and derives height from
    // that - meaning a viewBox area that shrinks with fewer bars (varying
    // width against a fixed H) changes the effective aspect ratio, and with
    // few bars stretches into a comically tall chart. Keep a fixed minimum
    // plot width regardless of bar count; only grow past it (with the
    // container scrolling horizontally, same as the wide data tables) once
    // there are enough bars that a fixed minimum slot width needs more room.
    const minPlotW = 580;
    const minSlotW = 60;
    const plotW = Math.max(minPlotW, n * minSlotW);
    const slotW = plotW / n;
    const W = padL + plotW + padR;

    let maxV = 0,
      minV = 0;
    for (const it of sorted) {
      if (it.value > maxV) maxV = it.value;
      if (it.value < minV) minV = it.value;
    }
    const span = Math.max(1, maxV - minV);
    maxV += span * 0.12;
    if (minV < 0) minV -= span * 0.12;

    const yAt = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
    const zeroY = yAt(0);

    let gridLines = "",
      yLabels = "";
    pickNiceTicks(minV, maxV, 4).forEach((v) => {
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${theme.gridline}" stroke-width="1"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${theme.axisText}">${fmtScore(v)}</text>`;
    });

    const barW = Math.min(60, slotW - 16);
    let bars = "",
      valueLabels = "";
    const legendItems = [];
    sorted.forEach((it, i) => {
      const color = theme.series[i % theme.series.length];
      const cx = padL + slotW * i + slotW / 2;
      const barX = cx - barW / 2;
      const positive = it.value >= 0;
      const barTop = yAt(Math.max(0, it.value));
      const barBottom = yAt(Math.min(0, it.value));
      const h = Math.max(0, barBottom - barTop);
      const titleTag = it.tooltip ? `<title>${escapeHtml(it.tooltip)}</title>` : "";
      bars += `<rect x="${barX}" y="${barTop}" width="${barW}" height="${h}" fill="${color}" stroke="${darkenColor(color, 0.25)}" stroke-width="1" rx="2">${titleTag}</rect>`;
      const labelY = positive ? barTop - 6 : barBottom + 14;
      valueLabels += `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="${theme.axisText}">${fmtScore(it.value)}${titleTag}</text>`;
      legendItems.push({ color, label: it.label });
    });

    const legend = legendItems
      .map((l) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`)
      .join("");

    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="bar-chart" role="img" aria-label="${escapeHtml(title)}">
        <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(46,42,34,0.025)" rx="4"/>
        ${gridLines}
        ${yLabels}
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${theme.axisText}" stroke-width="1.5"/>
        ${bars}
        ${valueLabels}
      </svg>
      <div class="chart-legend">${legend}</div>
    `;
  }

  const RANK_MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"]; // gold/silver/bronze, ranks 1-3 only

  // A rounded rect with radius only on the two corners at the OUTER (away
  // from the zero baseline) end of a stacked segment - the baseline end and
  // any edge touching a neighboring segment stay square, per the "4px
  // rounded data-end, square at the baseline" mark spec. Two segments
  // stacked flush would otherwise look like one shape; combined with the
  // small gap left between segments below, the rounding is reserved for the
  // one edge that's actually a data end.
  function roundedBarSegment(x, y, w, h, roundTop, roundBottom) {
    const rTop = roundTop ? Math.min(4, w / 2, h) : 0;
    const rBottom = roundBottom ? Math.min(4, w / 2, h) : 0;
    if (!rTop && !rBottom) return `M${x},${y} h${w} v${h} h${-w} Z`;
    return (
      `M${x},${y + rTop} ` +
      `a${rTop},${rTop} 0 0 1 ${rTop},${-rTop} ` +
      `h${w - 2 * rTop} ` +
      `a${rTop},${rTop} 0 0 1 ${rTop},${rTop} ` +
      `v${h - rTop - rBottom} ` +
      `a${rBottom},${rBottom} 0 0 1 ${-rBottom},${rBottom} ` +
      `h${-(w - 2 * rBottom)} ` +
      `a${rBottom},${rBottom} 0 0 1 ${-rBottom},${-rBottom} Z`
    );
  }

  // A label that's too long to sit comfortably under its bar gets
  // compressed to fit (SVG textLength/spacingAndGlyphs) rather than clipped
  // or left to overflow into the neighboring bar's column - character-count
  // estimate, not a real text measurement, but this file has no canvas/DOM
  // measurement dependency anywhere else and slotW-wide overflow is rare
  // enough (a handful of players) not to warrant adding one.
  function fitTextAttr(text, maxWidth, fontSize) {
    const estWidth = text.length * fontSize * 0.58;
    return estWidth > maxWidth ? ` textLength="${maxWidth.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : "";
  }

  // Final ranking as a scoreboard: one plain bar per player by default (just
  // the total Llama Score, so the ranking itself reads at a glance without
  // three colors competing for attention) - hovering a bar swaps it for the
  // GP Score / War Score breakdown (see js/llama-score.js's vpPositive/
  // vpNegative) via a pure CSS opacity crossfade between two SVG layers
  // drawn for every bar (no JS mouse-tracking needed). Medal + name + country
  // tag ride directly under each bar instead of a same-color-swatch legend
  // row - the bar's own x-position already is the identity axis, so the
  // label rides it rather than duplicating it in a separate legend the
  // reader has to cross-reference.
  function renderStackedBarChart(container, { title, items }) {
    const theme = chartTokens();
    const sorted = (items || []).slice().sort((a, b) => b.total - a.total);
    const n = Math.max(1, sorted.length);
    const padL = 44,
      padR = 16,
      padT = 20,
      padB = 8;
    const plotH = 200;
    const labelGap = 10;
    const labelBandH = 40;
    const H = padT + plotH + padB + labelGap + labelBandH;
    const minPlotW = 620;
    const minSlotW = 80;
    const plotW = Math.max(minPlotW, n * minSlotW);
    const slotW = plotW / n;
    const W = padL + plotW + padR;

    let maxV = 0,
      minV = 0;
    for (const it of sorted) {
      let pos = 0,
        neg = 0;
      for (const seg of it.segments || []) {
        if (seg.value >= 0) pos += seg.value;
        else neg += seg.value;
      }
      maxV = Math.max(maxV, pos, it.total || 0);
      minV = Math.min(minV, neg, it.total || 0);
    }
    const span = Math.max(1, maxV - minV);
    maxV += span * 0.12;
    if (minV < 0) minV -= span * 0.12;

    const yAt = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
    const zeroY = yAt(0);

    let gridLines = "",
      yLabels = "";
    pickNiceTicks(minV, maxV, 4).forEach((v) => {
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${theme.gridline}" stroke-width="1"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${theme.axisText}">${fmtScore(v)}</text>`;
    });

    const barW = Math.min(36, slotW - 30);
    const SEGMENT_GAP = 2;
    let bars = "",
      valueLabels = "",
      axisLabels = "";
    sorted.forEach((it, i) => {
      const cx = padL + slotW * i + slotW / 2;
      const barX = cx - barW / 2;
      const segs = (it.segments || []).filter((s) => s.value);
      const posSegs = segs.filter((s) => s.value > 0);
      const negSegs = segs.filter((s) => s.value < 0);
      const topPosSeg = posSegs[posSegs.length - 1];
      const bottomNegSeg = negSegs[negSegs.length - 1];

      let posBase = 0;
      let negBase = 0;
      let segmentPaths = "";
      segs.forEach((seg) => {
        const from = seg.value >= 0 ? posBase : negBase;
        const to = from + seg.value;
        if (seg.value >= 0) posBase = to;
        else negBase = to;
        let y1 = yAt(Math.max(from, to));
        let y2 = yAt(Math.min(from, to));
        // Leave a sliver of surface color between touching segments (top/
        // bottom pair) instead of a stroke - shrink the far-from-zero edge
        // only, so the gap doesn't eat into the zero baseline itself.
        if (seg.value >= 0 && from > 0) y1 += SEGMENT_GAP;
        if (seg.value < 0 && from < 0) y2 -= SEGMENT_GAP;
        const h = Math.max(1, y2 - y1);
        const isTop = seg === topPosSeg;
        const isBottom = seg === bottomNegSeg;
        const titleTag = `<title>${escapeHtml(`${it.label}: ${seg.label} ${fmtScore(seg.value)}; total ${fmtScore(it.total)}`)}</title>`;
        const path = seg.value >= 0 ? roundedBarSegment(barX, y1, barW, h, isTop, false) : roundedBarSegment(barX, y1, barW, h, false, isBottom);
        segmentPaths += `<path d="${path}" fill="${seg.color}" stroke="${darkenColor(seg.color, 0.25)}" stroke-width="1">${titleTag}</path>`;
      });

      // The default-visible layer: one plain bar per player, colored by that
      // player's own country (falling back to the neutral accent when no
      // country color is available, e.g. a ledger-only campaign) - a hairline
      // border a shade darker than the fill keeps every bar visually defined
      // regardless of how light or dark its own color happens to be. Same
      // rounding rule as a single "outer" segment would get (rounded at the
      // far-from-zero end, square at the baseline).
      const barColor = legibleChartColor(it.color, theme.isDark) || theme.totalBar;
      const totalPositive = it.total >= 0;
      const totalY1 = yAt(Math.max(0, it.total));
      const totalY2 = yAt(Math.min(0, it.total));
      const totalH = Math.max(1, totalY2 - totalY1);
      const totalPath = roundedBarSegment(barX, totalY1, barW, totalH, totalPositive, !totalPositive);
      const totalTitleTag = `<title>${escapeHtml(`${it.label}: total ${fmtScore(it.total)} - hover for the GP Score / War Score breakdown`)}</title>`;

      bars += `<g class="llama-score-bar">
        <path class="bar-total-shape" d="${totalPath}" fill="${barColor}" stroke="${darkenColor(barColor, 0.25)}" stroke-width="1">${totalTitleTag}</path>
        <g class="bar-segments-shape">${segmentPaths}</g>
      </g>`;

      const totalY = yAt(it.total);
      const labelY = it.total >= 0 ? totalY - 6 : totalY + 14;
      valueLabels += `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="${theme.axisText}">${fmtScore(it.total)}</text>`;

      const labelTop = padT + plotH + padB + labelGap;
      const rank = i + 1;
      const rankMark = rank <= 3 ? RANK_MEDALS[rank - 1] : `#${rank}`;
      const nameLine = it.player != null ? String(it.player) : it.label;
      const tagLine = it.countryTag ? ` (${it.countryTag})` : "";
      const nameFull = `${nameLine}${tagLine}`;
      const maxLabelW = slotW - 8;
      axisLabels += `<text x="${cx}" y="${labelTop + 13}" text-anchor="middle" font-size="13" fill="${theme.axisText}">${escapeHtml(rankMark)}</text>`;
      axisLabels += `<text x="${cx}" y="${labelTop + 30}" text-anchor="middle" font-size="11" fill="${theme.labelText}"${fitTextAttr(
        nameFull,
        maxLabelW,
        11
      )}>${escapeHtml(nameFull)}</text>`;
    });

    const segmentLegend = [
      { label: "GP contribution", color: "#a9822f" },
      { label: "War contribution", color: "#1f7a3d" },
      { label: "Negative war score", color: "#a1442f" },
    ]
      .map((l) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`)
      .join("");

    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="bar-chart bar-chart-scoreboard" role="img" aria-label="${escapeHtml(title)}">
        <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(46,42,34,0.025)" rx="4"/>
        ${gridLines}
        ${yLabels}
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${theme.axisText}" stroke-width="1.5"/>
        ${bars}
        ${valueLabels}
        ${axisLabels}
      </svg>
      <p class="panel-note chart-hover-hint">Hover a bar to see its GP Score / War Score breakdown.</p>
      <div class="chart-legend">${segmentLegend}</div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  root.Charts = { renderLineChart, renderBarChart, renderStackedBarChart };
})(typeof self !== "undefined" ? self : this);
