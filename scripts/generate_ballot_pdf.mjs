import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const dashboardPath = path.join(rootDir, "site", "data", "oscars_2026_dashboard.json");
const outputDir = path.join(rootDir, "exports");

const rawJson = await fsp.readFile(dashboardPath, "utf8");
const dashboard = JSON.parse(rawJson.replace(/^\uFEFF/, ""));
const htmlPath = path.join(outputDir, `oscars_${dashboard.year}_ballot.html`);
const pdfPath = path.join(outputDir, `oscars_${dashboard.year}_ballot.pdf`);

await fsp.mkdir(outputDir, { recursive: true });
await fsp.writeFile(htmlPath, renderBallotHtml(dashboard), "utf8");

const browserPath = findBrowserPath();
if (!browserPath) {
  throw new Error("Unable to find Microsoft Edge or Google Chrome to print the ballot PDF.");
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oscars-ballot-"));

try {
  const result = spawnSync(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-pdf-header-footer",
      `--user-data-dir=${userDataDir}`,
      `--print-to-pdf=${pdfPath}`,
      "--virtual-time-budget=3000",
      pathToFileURL(htmlPath).href,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Browser exited with status ${result.status}`);
  }
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`HTML ballot: ${htmlPath}`);
console.log(`PDF ballot: ${pdfPath}`);

function findBrowserPath() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function renderBallotHtml(data) {
  const snapshotLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(data.fetchedAt));

  const printedLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
  }).format(new Date());

  const categoryCards = data.categories
    .map((category, index) => {
      const featuredClass = category.nominees.length > 5 ? " category-card-featured" : "";
      const nomineeListClass = category.nominees.length > 5 ? "nominee-list nominee-list-split" : "nominee-list";
      const nomineeItems = category.nominees
        .map(
          (nominee) => `
            <li class="nominee">
              <span class="nominee-mark" aria-hidden="true"></span>
              <span class="nominee-name">${escapeHtml(nominee.nominee)}</span>
            </li>`,
        )
        .join("");

      return `
        <section class="category-card${featuredClass}">
          <div class="category-index">${String(index + 1).padStart(2, "0")}</div>
          <h2>${escapeHtml(category.category)}</h2>
          <ul class="${nomineeListClass}">
            ${nomineeItems}
          </ul>
        </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Oscars ${data.year} Ballot</title>
  <style>
    :root {
      --paper: #f6efde;
      --panel: rgba(255, 252, 246, 0.94);
      --ink: #1b1611;
      --muted: #685d4f;
      --gold: #b58a2d;
      --line: rgba(27, 22, 17, 0.12);
      --shadow: 0 10px 24px rgba(41, 30, 9, 0.08);
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    @page {
      size: letter landscape;
      margin: 0.25in;
    }

    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      background:
        radial-gradient(circle at top left, rgba(181, 138, 45, 0.16), transparent 26%),
        linear-gradient(135deg, #fbf6ea 0%, #efe3c8 100%);
      color: var(--ink);
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      font-size: 10px;
      line-height: 1.25;
    }

    .sheet {
      position: relative;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 8px;
      height: 8in;
      padding: 0.16in 0.18in 0.14in;
      border: 1.5px solid rgba(181, 138, 45, 0.45);
      background: rgba(255, 251, 244, 0.92);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .sheet::before,
    .sheet::after {
      content: "";
      position: absolute;
      inset: 12px;
      border: 1px solid rgba(174, 138, 57, 0.18);
      pointer-events: none;
    }

    .sheet::after {
      inset: 18px;
      border-style: dashed;
      border-color: rgba(24, 21, 18, 0.08);
    }

    .masthead {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1.9fr) minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding-bottom: 8px;
      border-bottom: 2px solid rgba(24, 21, 18, 0.14);
    }

    .kicker {
      margin: 0 0 4px;
      color: var(--gold);
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-family: "Palatino Linotype", "Book Antiqua", Georgia, serif;
      font-size: 21px;
      line-height: 0.96;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .dek {
      max-width: 54ch;
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 10px;
    }

    .meta-panel {
      align-self: stretch;
      padding: 8px 10px;
      border: 1px solid rgba(24, 21, 18, 0.14);
      background: linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(245, 237, 223, 0.95));
    }

    .meta-panel p {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .line-row {
      display: grid;
      grid-template-columns: 38px 1fr;
      gap: 6px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 9px;
    }

    .line-row:last-child {
      margin-bottom: 0;
    }

    .line {
      border-bottom: 1px solid rgba(24, 21, 18, 0.35);
      min-height: 11px;
    }

    .category-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      grid-template-rows: repeat(5, minmax(0, 1fr));
      gap: 6px;
      min-height: 0;
    }

    .category-card {
      position: relative;
      min-height: 0;
      padding: 8px 8px 7px 27px;
      border: 1px solid var(--line);
      background: var(--panel);
    }

    .category-card-featured {
      grid-column: span 2;
    }

    .category-index {
      position: absolute;
      top: 8px;
      left: 8px;
      color: rgba(174, 138, 57, 0.95);
      font-family: "Palatino Linotype", "Book Antiqua", Georgia, serif;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
    }

    h2 {
      margin: 0 0 5px;
      font-family: "Palatino Linotype", "Book Antiqua", Georgia, serif;
      font-size: 10.5px;
      line-height: 1.1;
      letter-spacing: 0.01em;
    }

    .nominee-list {
      display: grid;
      gap: 3px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .nominee-list-split {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 8px;
    }

    .nominee {
      display: grid;
      grid-template-columns: 9px 1fr;
      gap: 6px;
      align-items: start;
    }

    .nominee-mark {
      width: 9px;
      height: 9px;
      border: 1.25px solid rgba(24, 21, 18, 0.78);
      border-radius: 2px;
      margin-top: 1px;
      background: rgba(255, 255, 255, 0.72);
    }

    .nominee-name {
      font-size: 7.6px;
      line-height: 1.18;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-top: 6px;
      border-top: 1px solid rgba(24, 21, 18, 0.14);
      color: var(--muted);
      font-size: 8px;
    }

    @media print {
      body {
        background: none;
      }

      .sheet {
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <header class="masthead">
      <div>
        <p class="kicker">Academy Awards Forecast Ballot</p>
        <h1>Oscars ${escapeHtml(String(data.year))} Ballot</h1>
        <p class="dek">Select one nominee per category.</p>
      </div>
      <aside class="meta-panel" aria-label="Ballot details">
        <p>Ballot info</p>
        <div class="line-row"><span>Name</span><span class="line"></span></div>
        <div class="line-row"><span>Date</span><span class="line"></span></div>
       </aside>
    </header>

    <section class="category-grid" aria-label="Oscar categories">
      ${categoryCards}
    </section>

    <footer class="footer">
     <p style="font-size: 1.8em;"> Tiebreaker: How many people will appear in the In Memoriam montage?</p>
    </footer>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
