const fs = require("fs");
const path = require("path");

const { createApp } = require("../src/app");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

function assertFile(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relativePath}`);
  }
}

function collectHtml(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectHtml(fullPath, files);
    else if (entry.name.endsWith(".html")) files.push(fullPath);
  }
  return files;
}

function validateStaticReferences() {
  const htmlFiles = collectHtml(PUBLIC);
  const assetPattern = /(?:href|src)="\/(assets\/[^"]+)"/g;
  const missing = [];

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    for (const match of html.matchAll(assetPattern)) {
      const assetPath = path.join(PUBLIC, match[1]);
      if (!fs.existsSync(assetPath)) {
        missing.push(`${path.relative(ROOT, file)} -> /${match[1]}`);
      }
    }
  }

  if (missing.length) {
    throw new Error(`Missing static assets:\n${missing.join("\n")}`);
  }

  return htmlFiles.length;
}

function validateDocs() {
  ["README.md", "AGENTS.md", ".env.example", "package.json"].forEach(assertFile);
}

createApp();
validateDocs();
const pageCount = validateStaticReferences();
console.log(`build: app booted and ${pageCount} HTML pages reference existing assets`);
