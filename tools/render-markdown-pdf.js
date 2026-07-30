const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const [, , markdownPathArg, pdfPathArg] = process.argv;
if (!markdownPathArg || !pdfPathArg) {
  console.error("Usage: node tools/render-markdown-pdf.js <input.md> <output.pdf>");
  process.exit(2);
}

const markdownPath = path.resolve(markdownPathArg);
const pdfPath = path.resolve(pdfPathArg);
const htmlPath = pdfPath.replace(/\.pdf$/i, "") + ".print.html";
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePath = chromeCandidates.find(fs.existsSync);
if (!chromePath) {
  console.error("Chrome or Edge was not found.");
  process.exit(3);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(value) {
  let output = escapeHtml(value);
  output = output.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1])
    ) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        lines[index].includes("|")
      ) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      html.push("<table><thead><tr>");
      headers.forEach((cell) => html.push(`<th>${inlineMarkdown(cell)}</th>`));
      html.push("</tr></thead><tbody>");
      rows.forEach((row) => {
        html.push("<tr>");
        row.forEach((cell) => html.push(`<td>${inlineMarkdown(cell)}</td>`));
        html.push("</tr>");
      });
      html.push("</tbody></table>");
      continue;
    }

    const unordered = line.match(/^\s*-\s+(.+)$/);
    if (unordered) {
      html.push("<ul>");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*-\s+(.+)$/);
        if (!item) break;
        html.push(`<li>${inlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      html.push("</ul>");
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      html.push("<ol>");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+\.\s+(.+)$/);
        if (!item) break;
        const itemParts = [item[1].trim()];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index].match(/^\s{2,}(.+)$/);
          if (continuation) {
            itemParts.push(continuation[1].trim());
            index += 1;
            continue;
          }
          if (!lines[index].trim()) {
            let nextIndex = index + 1;
            while (nextIndex < lines.length && !lines[nextIndex].trim()) {
              nextIndex += 1;
            }
            if (
              nextIndex < lines.length &&
              /^\s*\d+\.\s+/.test(lines[nextIndex])
            ) {
              index = nextIndex;
            }
          }
          break;
        }
        html.push(`<li>${inlineMarkdown(itemParts.join(" "))}</li>`);
      }
      html.push("</ol>");
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index];
      if (
        /^(#{1,6})\s+/.test(next) ||
        /^\s*-\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next) ||
        /^\s*---+\s*$/.test(next) ||
        (next.includes("|") &&
          index + 1 < lines.length &&
          isTableDivider(lines[index + 1]))
      ) {
        break;
      }
      paragraph.push(next.trim());
      index += 1;
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return html.join("\n");
}

const markdown = fs.readFileSync(markdownPath, "utf8");
const body = renderMarkdown(markdown);
const documentHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pancakes — EU5 1.3.11 Slave Raiding Report</title>
<style>
  @page { size: Letter; margin: 0.62in 0.68in 0.68in; }
  * { box-sizing: border-box; }
  html { color: #1c2530; font-family: "Segoe UI", Arial, sans-serif; font-size: 10.25pt; line-height: 1.43; }
  body { margin: 0 auto; max-width: 7.1in; }
  h1, h2, h3 { color: #233d54; break-after: avoid; }
  h1 { font-size: 23pt; line-height: 1.12; margin: 0 0 9pt; padding-bottom: 8pt; border-bottom: 3px solid #c8a457; }
  h2 { font-size: 15pt; line-height: 1.2; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #d8dde2; }
  h3 { font-size: 11.8pt; margin: 13pt 0 4pt; }
  p { margin: 4pt 0 7pt; orphans: 3; widows: 3; }
  ul, ol { margin: 4pt 0 8pt 20pt; padding-left: 9pt; }
  li { margin: 2.5pt 0; }
  strong { color: #162b3d; }
  code { font-family: Consolas, "Courier New", monospace; font-size: 8.8pt; color: #6f2e2e; background: #f3f4f5; border: 1px solid #e2e5e8; border-radius: 3px; padding: 0.5pt 2.5pt; overflow-wrap: anywhere; }
  a { color: #245d85; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9pt; break-inside: avoid; }
  th { color: #fff; background: #34556f; font-weight: 650; text-align: left; }
  th, td { border: 1px solid #cbd2d8; padding: 4pt 5pt; vertical-align: top; }
  tbody tr:nth-child(even) { background: #f5f7f8; }
  hr { border: 0; border-top: 1px solid #d8dde2; margin: 12pt 0; }
  h1 + p { color: #596672; font-size: 9.5pt; }
</style>
</head>
<body>
${body}
</body>
</html>`;

fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
fs.writeFileSync(htmlPath, documentHtml, "utf8");

const result = spawnSync(
  chromePath,
  [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    new URL(`file:///${htmlPath.replaceAll("\\", "/")}`).href,
  ],
  { encoding: "utf8", timeout: 120000 },
);

if (result.status !== 0 || !fs.existsSync(pdfPath)) {
  process.stderr.write(result.stderr || "");
  process.stdout.write(result.stdout || "");
  process.exit(result.status || 4);
}

console.log(pdfPath);
