import fs from 'fs';
import path from 'path';
import LZString from 'lz-string';
import { JSDOM } from 'jsdom';

// Initialize headless DOM environment for Excalidraw SVG generation
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.XMLSerializer = dom.window.XMLSerializer;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.SVGElement = dom.window.SVGElement;

// Dynamically import @excalidraw/utils
const { exportToSvg } = await import('@excalidraw/utils');

const args = process.argv.slice(2);
const isWatchMode = args.includes('--watch');
const filteredArgs = args.filter(a => a !== '--watch');

const SRC_DIR = filteredArgs[0] || process.env.SRC_DIR || '/vault-input';
const DEST_DIR = filteredArgs[1] || process.env.DEST_DIR || '/usr/src/app/content';

console.log(`[Converter] Starting incremental converter (Watch: ${isWatchMode})`);
console.log(`[Converter] Source: "${SRC_DIR}" -> Destination: "${DEST_DIR}"`);

fs.mkdirSync(DEST_DIR, { recursive: true });

const ALLOWED_ASSET_EXTS = new Set([
  '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'
]);

function walkDirectory(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file.startsWith('.')) continue; // skip hidden files
    const fullPath = path.join(dir, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(walkDirectory(fullPath));
      } else {
        results.push(fullPath);
      }
    } catch {
      // ignore unreadable files
    }
  }
  return results;
}

function cleanEmptyDirectories(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        cleanEmptyDirectories(fullPath);
      }
    } catch {}
  }
  // If directory is now empty, remove it (unless it's DEST_DIR)
  if (dir !== DEST_DIR && fs.readdirSync(dir).length === 0) {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

function isExcalidrawContent(content) {
  return content.includes('excalidraw-plugin:') ||
         content.includes('```compressed-json') ||
         (content.includes('```json') && content.includes('"type": "excalidraw"'));
}

async function processExcalidrawFile(filePath, destPath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let jsonString = null;

  // 1. Check for compressed-json block (LZString) with CRLF resilience
  const compMatch = content.match(/```compressed-json\r?\n([\s\S]*?)\r?\n```/);
  if (compMatch) {
    try {
      jsonString = LZString.decompressFromBase64(compMatch[1].trim());
    } catch (err) {
      console.warn(`[Converter] Failed to decompress LZString for: ${filePath}`);
    }
  }

  // 2. Check for standard json block with CRLF resilience
  if (!jsonString) {
    const rawMatch = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
    if (rawMatch) {
      jsonString = rawMatch[1];
    }
  }

  if (!jsonString) {
    // Normal markdown note without drawing: copy as-is
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf-8');
    return false;
  }

  try {
    const data = JSON.parse(jsonString);
    if (!data.elements || !Array.isArray(data.elements)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content, 'utf-8');
      return false;
    }

    // Render vector SVG using Excalidraw engine
    const svgElement = await exportToSvg({
      elements: data.elements,
      appState: {
        exportWithTheme: true,
        exportBackground: true,
        exportPadding: 15,
        ...(data.appState || {})
      },
      files: data.files || {}
    });

    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const baseName = path.basename(filePath, path.extname(filePath));
    const svgFileName = `${baseName}.svg`;
    const svgPath = path.join(destDir, svgFileName);

    // Write SVG file
    fs.writeFileSync(svgPath, svgElement.outerHTML, 'utf-8');

    // Extract any existing text notes / elements
    const textMatch = content.match(/## Text Elements([\s\S]*?)%%/);
    let extractedText = '';
    if (textMatch && textMatch[1].trim()) {
      extractedText = textMatch[1]
        .split('\n')
        .map(line => line.replace(/\^[a-zA-Z0-9_\-]+/g, '').trim())
        .filter(line => line.length > 0)
        .join('\n\n');
    }

    // Extract any embedded links or files (e.g. references to lecture PDFs)
    const filesMatch = content.match(/## Embedded Files([\s\S]*?)%%/);
    let embeddedLinks = '';
    if (filesMatch && filesMatch[1].trim()) {
      const rawLinks = filesMatch[1].match(/\[\[[^\]]+\]\]/g) || [];
      const uniqueLinks = [...new Set(rawLinks)];
      if (uniqueLinks.length > 0) {
        embeddedLinks = '\n\n### Riferimenti collegati\n' + uniqueLinks.map(l => `- ${l}`).join('\n');
      }
    }

    // Build companion Markdown page for Quartz
    const mdWrapper = `---
title: "${baseName.replace(/"/g, '\\"')}"
tags:
  - excalidraw
---

# ${baseName}

![[${svgFileName}]]
${extractedText ? `\n\n### Note trascritte\n\n${extractedText}` : ''}${embeddedLinks}
`;

    fs.writeFileSync(destPath, mdWrapper, 'utf-8');
    return true;
  } catch (err) {
    console.error(`[Converter] Error rendering ${filePath}:`, err.message);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf-8');
    return false;
  }
}

async function convertFileIncremental(srcFile) {
  const relPath = path.relative(SRC_DIR, srcFile);
  const destFile = path.join(DEST_DIR, relPath);
  const ext = path.extname(srcFile).toLowerCase();

  let srcStat;
  try {
    srcStat = fs.statSync(srcFile);
  } catch {
    return false;
  }

  if (ext === '.md') {
    const baseName = path.basename(srcFile, ext);
    const destSvg = path.join(path.dirname(destFile), `${baseName}.svg`);

    // Read a quick snippet to determine if it is an Excalidraw note
    let isExcalidraw = false;
    try {
      const fd = fs.openSync(srcFile, 'r');
      const buf = Buffer.alloc(512);
      fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      isExcalidraw = buf.toString('utf-8').includes('excalidraw-plugin:');
    } catch {}

    // Bulletproof incremental check:
    if (isExcalidraw) {
      // For Excalidraw drawings: BOTH destFile (.md) AND destSvg (.svg) must exist and be up to date
      if (fs.existsSync(destFile) && fs.existsSync(destSvg)) {
        const destStat = fs.statSync(destFile);
        const svgStat = fs.statSync(destSvg);
        if (destStat.mtimeMs >= srcStat.mtimeMs && svgStat.mtimeMs >= srcStat.mtimeMs) {
          return false; // CACHED
        }
      }
    } else {
      // For normal markdown notes: destFile must exist and be up to date
      if (fs.existsSync(destFile)) {
        const destStat = fs.statSync(destFile);
        if (destStat.mtimeMs >= srcStat.mtimeMs) {
          return false; // CACHED
        }
      }
    }

    return await processExcalidrawFile(srcFile, destFile);
  } else if (ALLOWED_ASSET_EXTS.has(ext)) {
    if (fs.existsSync(destFile)) {
      const destStat = fs.statSync(destFile);
      if (destStat.mtimeMs >= srcStat.mtimeMs) {
        return false; // CACHED
      }
    }
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    return false;
  } else {
    // Unwanted file types (.ods, .docx, .xopp, etc.) are strictly ignored
    return false;
  }
}

function pruneOrphans() {
  console.log(`[Converter] Checking for deleted notes/drawings to prune...`);
  const destFiles = walkDirectory(DEST_DIR);
  let prunedCount = 0;

  for (const destFile of destFiles) {
    const relPath = path.relative(DEST_DIR, destFile);
    if (relPath === 'index.md') continue; // keep root index

    const ext = path.extname(destFile).toLowerCase();
    const srcFile = path.join(SRC_DIR, relPath);

    if (ext === '.svg') {
      const baseName = path.basename(destFile, '.svg');
      const candidateMd = path.join(SRC_DIR, path.dirname(relPath), `${baseName}.md`);
      // If neither matching .svg nor source .md exists in source, prune it
      if (!fs.existsSync(srcFile) && !fs.existsSync(candidateMd)) {
        try {
          fs.unlinkSync(destFile);
          prunedCount++;
        } catch {}
      }
      continue;
    }

    // For any other file (.md, .pdf, .png): if source was deleted, delete it
    if (!fs.existsSync(srcFile)) {
      try {
        fs.unlinkSync(destFile);
        prunedCount++;
      } catch {}
    }
  }

  // Clean any remaining empty directories
  cleanEmptyDirectories(DEST_DIR);

  if (prunedCount > 0) {
    console.log(`[Converter] Pruned ${prunedCount} deleted orphan files.`);
  }
}

async function runInitialSweep() {
  pruneOrphans();

  const allFiles = walkDirectory(SRC_DIR);
  let convertedCount = 0;
  let cachedCount = 0;

  for (const srcFile of allFiles) {
    const converted = await convertFileIncremental(srcFile);
    if (converted) {
      convertedCount++;
    } else {
      cachedCount++;
    }
  }

  // Ensure default root index.md exists
  const indexFile = path.join(DEST_DIR, 'index.md');
  if (!fs.existsSync(indexFile)) {
    const rootItems = fs.readdirSync(DEST_DIR).filter(item => {
      if (item.startsWith('.')) return false;
      try {
        return fs.statSync(path.join(DEST_DIR, item)).isDirectory();
      } catch {
        return false;
      }
    });

    const links = rootItems.map(dir => `- [[${dir}/index|${dir}]]`).join('\n');
    const indexContent = `---
title: "Appunti Universitari"
---

# Appunti Universitari

Benvenuto nella raccolta note. Scegli una cartella per iniziare:

${links}
`;
    fs.writeFileSync(indexFile, indexContent, 'utf-8');
  }

  console.log(`[Converter] Sweep complete: ${convertedCount} rendered, ${cachedCount} verified up-to-date from cache.`);
}

async function startWatcher() {
  const { default: chokidar } = await import('chokidar');
  console.log(`[Converter] Watching "${SRC_DIR}" for file updates...`);

  const watcher = chokidar.watch(SRC_DIR, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 200
    }
  });

  watcher
    .on('add', async (filePath) => {
      console.log(`[Converter] Note added: ${filePath}`);
      await convertFileIncremental(filePath);
    })
    .on('change', async (filePath) => {
      console.log(`[Converter] Note updated: ${filePath}`);
      await convertFileIncremental(filePath);
    })
    .on('unlink', (filePath) => {
      console.log(`[Converter] Note deleted: ${filePath}`);
      const relPath = path.relative(SRC_DIR, filePath);
      const destFile = path.join(DEST_DIR, relPath);
      const baseName = path.basename(filePath, path.extname(filePath));
      const destSvg = path.join(path.dirname(destFile), `${baseName}.svg`);

      if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
      if (fs.existsSync(destSvg)) fs.unlinkSync(destSvg);
      cleanEmptyDirectories(DEST_DIR);
    })
    .on('unlinkDir', () => {
      cleanEmptyDirectories(DEST_DIR);
    });
}

async function main() {
  await runInitialSweep();
  if (isWatchMode) {
    await startWatcher();
  }
}

main().catch(err => {
  console.error('[Converter] Fatal error:', err);
  process.exit(1);
});
