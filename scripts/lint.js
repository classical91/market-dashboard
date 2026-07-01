const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "data"]);
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (JS_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

const files = walk(ROOT);
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax check failed: ${path.relative(ROOT, file)}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

if (failed) process.exit(1);
console.log(`lint: checked ${files.length} JavaScript files`);
