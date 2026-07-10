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
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return n.toFixed(0);
  }

  // series: [{ label, color, points: number[] }], all points arrays the
  // same length, aligned to `years` (same length, ascending).
  function renderLineChart(container, { title, years, series }) {
    const W = 640,
      H = 260;
    const padL = 44,
      padR = 12,
      padT = 16,
      padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let minY = 0;
    let maxY = 1;
    for (const s of series) {
      for (const v of s.points) {
        if (typeof v === "number" && v > maxY) maxY = v;
      }
    }
    maxY *= 1.08;

    const xAt = (i) => padL + (years.length <= 1 ? 0 : (i / (years.length - 1)) * plotW);
    const yAt = (v) => padT + plotH - (v / maxY) * plotH;

    const GRID_STEPS = 4;
    let gridLines = "";
    let yLabels = "";
    for (let g = 0; g <= GRID_STEPS; g++) {
      const v = (maxY / GRID_STEPS) * g;
      const y = yAt(v);
      gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1"/>`;
      yLabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${AXIS_TEXT}">${fmtCompact(v)}</text>`;
    }

    const xTickEvery = Math.max(1, Math.round(years.length / 8));
    let xLabels = "";
    for (let i = 0; i < years.length; i += xTickEvery) {
      xLabels += `<text x="${xAt(i)}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="${AXIS_TEXT}">${years[i]}</text>`;
    }

    let lines = "";
    let dots = "";
    series.forEach((s, si) => {
      const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
      const pts = s.points.map((v, i) => `${xAt(i)},${yAt(typeof v === "number" ? v : 0)}`).join(" ");
      lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" data-series="${si}"/>`;
      const lastIdx = s.points.length - 1;
      const lastVal = s.points[lastIdx];
      if (typeof lastVal === "number") {
        dots += `<circle cx="${xAt(lastIdx)}" cy="${yAt(lastVal)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;
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

  // Ranked horizontal bar chart (e.g. the Llama score leaderboard).
  // items: [{ label, value }], any order - sorted descending here. Bars
  // scale to the largest absolute value so negative scores render as a
  // bar of the same visual weight on the opposite side of a zero line.
  function renderBarChart(container, { title, items }) {
    const sorted = (items || []).slice().sort((a, b) => b.value - a.value);
    const maxAbs = Math.max(1, ...sorted.map((it) => Math.abs(it.value)));
    const rowH = 28;
    const H = Math.max(rowH, sorted.length * rowH);
    const W = 640;
    const labelW = 150;
    const zeroX = labelW + (W - labelW) / 2;
    const plotW = (W - labelW) / 2;

    const rows = sorted
      .map((it, i) => {
        const color = SERIES_COLORS[i % SERIES_COLORS.length];
        const y = i * rowH;
        const w = (Math.abs(it.value) / maxAbs) * plotW;
        const barX = it.value >= 0 ? zeroX : zeroX - w;
        const titleTag = it.tooltip ? `<title>${escapeHtml(it.tooltip)}</title>` : "";
        return `
          <text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="${AXIS_TEXT}">${escapeHtml(it.label)}${titleTag}</text>
          <rect x="${barX}" y="${y + 4}" width="${w}" height="${rowH - 8}" fill="${color}" rx="2">${titleTag}</rect>
          <text x="${it.value >= 0 ? barX + w + 6 : barX - 6}" y="${y + rowH / 2 + 4}" text-anchor="${it.value >= 0 ? "start" : "end"}" font-size="12" fill="${AXIS_TEXT}">${fmtCompact(it.value)}${titleTag}</text>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="bar-chart" role="img" aria-label="${escapeHtml(title)}">
        <line x1="${zeroX}" y1="0" x2="${zeroX}" y2="${H}" stroke="${GRIDLINE}" stroke-width="1"/>
        ${rows}
      </svg>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  root.Charts = { renderLineChart, renderBarChart };
})(typeof self !== "undefined" ? self : this);
