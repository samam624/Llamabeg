// Small dependency-free SVG line chart for the historical trend panels
// (population / tax base over time). Not a general charting library - just
// enough for "N player-nation series over a shared year axis."
(function (root) {
  "use strict";

  // Dark-mode categorical palette (validated: worst adjacent CVD ~10.3,
  // clears 3:1 on a dark surface) - fixed order, never cycled per-series.
  const SERIES_COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

  const SURFACE = "#1c222c"; // --panel-bg
  const GRIDLINE = "#2a3240"; // --panel-border
  const AXIS_TEXT = "#9aa5b5"; // --text-dim

  function fmtCompact(n) {
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (abs >= 1000) return (n / 1000).toFixed(1) + "k";
    if (abs > 0 && abs < 1) return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    if (abs < 10) return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    if (abs < 100) return n.toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
    return n.toFixed(0);
  }

  // series: [{ label, color, points: number[] }], all points arrays the
  // same length, aligned to `years` (same length, ascending).
  function renderLineChart(container, { title, years, series }) {
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
    const span = Math.max(1e-9, dataMax - dataMin);
    const clusteredPositive = dataMin > 0 && dataMin / Math.max(dataMax, 1e-9) > 0.25;
    let minY = clusteredPositive ? Math.max(0, dataMin - span * 0.18) : 0;
    let maxY = dataMax + span * 0.18;
    if (maxY <= minY) maxY = minY + 1;

    const xAt = (i) => padL + (years.length <= 1 ? 0 : (i / (years.length - 1)) * plotW);
    const yAt = (v) => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

    const GRID_STEPS = 4;
    let gridLines = "";
    let yLabels = "";
    for (let g = 0; g <= GRID_STEPS; g++) {
      const v = minY + ((maxY - minY) / GRID_STEPS) * g;
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1" opacity="0.72"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${AXIS_TEXT}">${fmtCompact(v)}</text>`;
    }

    const xTickEvery = Math.max(1, Math.round(years.length / 8));
    let xLabels = "";
    for (let i = 0; i < years.length; i += xTickEvery) {
      xLabels += `<text x="${xAt(i)}" y="${H - padB + 18}" text-anchor="middle" font-size="10" fill="${AXIS_TEXT}">${years[i]}</text>`;
    }

    let lines = "";
    let dots = "";
    series.forEach((s, si) => {
      const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
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
        dots += `<circle cx="${xAt(lastIdx)}" cy="${yAt(lastVal)}" r="4.2" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;
      }
    });

    const legend = series
      .map((s, si) => {
        const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
        return `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${color}"></span>${escapeHtml(s.label)}</span>`;
      })
      .join("");

    const svgId = "chart-" + Math.random().toString(36).slice(2, 9);
    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg id="${svgId}" viewBox="0 0 ${W} ${H}" class="trend-chart" role="img" aria-label="${escapeHtml(title)}">
        <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(255,255,255,0.012)" rx="4"/>
        ${gridLines}
        ${yLabels}
        ${xLabels}
        ${lines}
        ${dots}
        <line class="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="${AXIS_TEXT}" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>
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
        .map((s, si) => {
          const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
          const v = s.points[idx];
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

    const GRID_STEPS = 4;
    let gridLines = "",
      yLabels = "";
    for (let g = 0; g <= GRID_STEPS; g++) {
      const v = minV + ((maxV - minV) / GRID_STEPS) * g;
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${AXIS_TEXT}">${fmtScore(v)}</text>`;
    }

    const barW = Math.min(60, slotW - 16);
    let bars = "",
      valueLabels = "";
    const legendItems = [];
    sorted.forEach((it, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const cx = padL + slotW * i + slotW / 2;
      const barX = cx - barW / 2;
      const positive = it.value >= 0;
      const barTop = yAt(Math.max(0, it.value));
      const barBottom = yAt(Math.min(0, it.value));
      const h = Math.max(0, barBottom - barTop);
      const titleTag = it.tooltip ? `<title>${escapeHtml(it.tooltip)}</title>` : "";
      bars += `<rect x="${barX}" y="${barTop}" width="${barW}" height="${h}" fill="${color}" rx="2">${titleTag}</rect>`;
      const labelY = positive ? barTop - 6 : barBottom + 14;
      valueLabels += `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="${AXIS_TEXT}">${fmtScore(it.value)}${titleTag}</text>`;
      legendItems.push({ color, label: it.label });
    });

    const legend = legendItems
      .map((l) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`)
      .join("");

    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="bar-chart" role="img" aria-label="${escapeHtml(title)}">
        ${gridLines}
        ${yLabels}
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${AXIS_TEXT}" stroke-width="1.5"/>
        ${bars}
        ${valueLabels}
      </svg>
      <div class="chart-legend">${legend}</div>
    `;
  }

  const LABEL_TEXT = "#e6e9ef"; // --text - primary ink for the identity label under each bar, kept off the series colors

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

  const TOTAL_BAR_COLOR = "#5b9dd9"; // --accent - a single neutral tone for the collapsed default bar; sign is already shown by which side of the zero line it's on

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

    const GRID_STEPS = 4;
    let gridLines = "",
      yLabels = "";
    for (let g = 0; g <= GRID_STEPS; g++) {
      const v = minV + ((maxV - minV) / GRID_STEPS) * g;
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${AXIS_TEXT}">${fmtScore(v)}</text>`;
    }

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
        segmentPaths += `<path d="${path}" fill="${seg.color}">${titleTag}</path>`;
      });

      // The default-visible layer: one plain bar, same rounding rule as a
      // single "outer" segment would get (rounded at the far-from-zero end,
      // square at the baseline).
      const totalPositive = it.total >= 0;
      const totalY1 = yAt(Math.max(0, it.total));
      const totalY2 = yAt(Math.min(0, it.total));
      const totalH = Math.max(1, totalY2 - totalY1);
      const totalPath = roundedBarSegment(barX, totalY1, barW, totalH, totalPositive, !totalPositive);
      const totalTitleTag = `<title>${escapeHtml(`${it.label}: total ${fmtScore(it.total)} - hover for the GP Score / War Score breakdown`)}</title>`;

      bars += `<g class="llama-score-bar">
        <path class="bar-total-shape" d="${totalPath}" fill="${TOTAL_BAR_COLOR}">${totalTitleTag}</path>
        <g class="bar-segments-shape">${segmentPaths}</g>
      </g>`;

      const totalY = yAt(it.total);
      const labelY = it.total >= 0 ? totalY - 6 : totalY + 14;
      valueLabels += `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="${AXIS_TEXT}">${fmtScore(it.total)}</text>`;

      const labelTop = padT + plotH + padB + labelGap;
      const rank = i + 1;
      const rankMark = rank <= 3 ? RANK_MEDALS[rank - 1] : `#${rank}`;
      const nameLine = it.player != null ? String(it.player) : it.label;
      const tagLine = it.countryTag ? ` (${it.countryTag})` : "";
      const nameFull = `${nameLine}${tagLine}`;
      const maxLabelW = slotW - 8;
      axisLabels += `<text x="${cx}" y="${labelTop + 13}" text-anchor="middle" font-size="13" fill="${AXIS_TEXT}">${escapeHtml(rankMark)}</text>`;
      axisLabels += `<text x="${cx}" y="${labelTop + 30}" text-anchor="middle" font-size="11" fill="${LABEL_TEXT}"${fitTextAttr(
        nameFull,
        maxLabelW,
        11
      )}>${escapeHtml(nameFull)}</text>`;
    });

    const segmentLegend = [
      { label: "GP contribution", color: "#5b9dd9" },
      { label: "War contribution", color: "#6fcf97" },
      { label: "Negative war score", color: "#eb5757" },
    ]
      .map((l) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`)
      .join("");

    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="bar-chart bar-chart-scoreboard" role="img" aria-label="${escapeHtml(title)}">
        ${gridLines}
        ${yLabels}
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${AXIS_TEXT}" stroke-width="1.5"/>
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
