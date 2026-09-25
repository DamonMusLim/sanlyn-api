import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROUTE_FILES = ["routes-core.js", "routes-tail.js", "server.js", "routes-rfq.js"];

function normalizeManifestPath(filePath) {
  const normalized = path.posix.normalize(filePath.trim().replace(/\\/g, "/"));
  return normalized.replace(/^\.?\//, "");
}

function displayPath(filePath) {
  return `./${filePath}`;
}

function parseManifest(filePath) {
  const rows = readFileSync(filePath, "utf8").split(/\r?\n/);
  const manifest = new Map();

  for (const row of rows) {
    if (!row.trim()) continue;
    const [rawPath, md5] = row.split("\t");
    if (!rawPath || !md5) continue;
    manifest.set(normalizeManifestPath(rawPath), md5.trim());
  }

  return manifest;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

function collectRunningFiles(repoRoot = process.cwd()) {
  const running = new Set();
  const importPattern = /import\(\s*(["'])(\.\/[^"']+)\1\s*\)/g;

  for (const routeFile of ROUTE_FILES) {
    const routePath = path.join(repoRoot, routeFile);
    if (!existsSync(routePath)) continue;

    const source = stripComments(readFileSync(routePath, "utf8"));
    const sourceDir = path.posix.dirname(routeFile);
    let match;

    while ((match = importPattern.exec(source)) !== null) {
      const resolved = path.posix.normalize(path.posix.join(sourceDir, match[2]));
      running.add(normalizeManifestPath(resolved));
    }
  }

  return running;
}

function classifyManifests(prodManifest, gitManifest, runningFiles) {
  const identical = [];
  const differs = [];
  const prodOnly = [];
  const gitOnly = [];
  const allPaths = new Set([...prodManifest.keys(), ...gitManifest.keys()]);

  for (const filePath of [...allPaths].sort()) {
    const prodMd5 = prodManifest.get(filePath);
    const gitMd5 = gitManifest.get(filePath);
    const row = {
      path: filePath,
      prodMd5: prodMd5 || "",
      gitMd5: gitMd5 || "",
      running: runningFiles.has(filePath),
    };

    if (prodMd5 && gitMd5 && prodMd5 === gitMd5) identical.push(row);
    else if (prodMd5 && gitMd5) differs.push(row);
    else if (prodMd5) prodOnly.push(row);
    else gitOnly.push(row);
  }

  return { identical, differs, prodOnly, gitOnly };
}

function renderRows(rows, columns) {
  if (!rows.length) return "_None_\n";

  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines = rows.map((row) => {
    const values = columns.map((column) => {
      if (column === "path") return displayPath(row.path);
      if (column === "running") return row.running ? "yes" : "no";
      return row[column] || "";
    });
    return `| ${values.join(" | ")} |`;
  });

  return [header, separator, ...lines, ""].join("\n");
}

function renderReport(classified) {
  const lines = [
    "# prod drift report",
    "",
    `## identical (${classified.identical.length})`,
    "",
    "Only count is reported by design.",
    "",
    `## differs (${classified.differs.length})`,
    "",
    renderRows(classified.differs, ["path", "prodMd5", "gitMd5", "running"]),
    `## prod_only (${classified.prodOnly.length})`,
    "",
    renderRows(classified.prodOnly, ["path", "prodMd5", "running"]),
    `## git_only (${classified.gitOnly.length})`,
    "",
    renderRows(classified.gitOnly, ["path", "gitMd5", "running"]),
  ];

  return lines.join("\n");
}

export function prodDriftReport(prodManifestPath, gitManifestPath, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const prodManifest = parseManifest(prodManifestPath);
  const gitManifest = parseManifest(gitManifestPath);
  const runningFiles = collectRunningFiles(repoRoot);
  return renderReport(classifyManifests(prodManifest, gitManifest, runningFiles));
}

function main() {
  const [, scriptPath, prodManifestPath, gitManifestPath] = process.argv;

  if (!prodManifestPath || !gitManifestPath) {
    console.log([
      "# prod drift report",
      "",
      "Usage: node scripts/prod-drift-report.mjs <prod-manifest.tsv> <git-manifest.tsv>",
    ].join("\n"));
    return;
  }

  try {
    console.log(prodDriftReport(prodManifestPath, gitManifestPath));
  } catch (err) {
    console.log([
      "# prod drift report",
      "",
      "Report generation failed.",
      "",
      `Error: ${err.message}`,
    ].join("\n"));
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
