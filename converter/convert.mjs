#!/usr/bin/env node
/**
 * Excalidraw Publisher converter.
 *
 * Mirrors an Obsidian vault into a Quartz content directory, rendering
 * Excalidraw notes to self-contained SVG files.
 *
 * Usage:
 *   node convert.mjs [--watch] [--sweep] <src> <dest>
 *
 * Environment:
 *   SRC_DIR, DEST_DIR, STATE_FILE, SITE_TITLE
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import LZString from 'lz-string';
import { Image, Path2D, createCanvas } from '@napi-rs/canvas';

const CONVERTER_VERSION = '2.0.0';
const LOG_PREFIX = '[Converter]';

// ---------------------------------------------------------------------------
// Headless DOM / canvas environment for Excalidraw's SVG renderer
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.HTMLImageElement = dom.window.HTMLImageElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.SVGSVGElement = dom.window.SVGSVGElement;
globalThis.Path2D = Path2D;
globalThis.Image = Image;

// Node 22 exposes `navigator` as a getter-only global, so a plain assignment
// throws. Re-define the property instead, and fall back to Node's navigator.
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
} catch {
  // Node's built-in navigator is good enough if it cannot be replaced.
}

// jsdom has no FontFace implementation. Excalidraw only uses the object to
// build @font-face CSS; the actual Woff2 data is embedded by the renderer.
if (!globalThis.FontFace) {
  globalThis.FontFace = class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = String(family).replace(/^["']|["']$/g, '');
      this.source = source;
      this.style = descriptors.style ?? 'normal';
      this.weight = descriptors.weight ?? '400';
      this.display = descriptors.display ?? 'swap';
      this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
      this.status = 'loaded';
    }

    load() {
      return Promise.resolve(this);
    }
  };
}

const { exportScene } = await import('@excalidraw/utils');

const renderEnvironment = {
  document: dom.window.document,
  createCanvas: (width, height) =>
    createCanvas(Math.max(1, Math.floor(width || 1)), Math.max(1, Math.floor(height || 1))),
  createImage: () => new Image(),
  createPath: (d) => new Path2D(d),
  // Excalidraw embeds the fonts in the SVG itself, so no browser font loading
  // is required for the exported file.
  loadFonts: async () => {},
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
let isWatch = false;
const positionalArgs = [];

for (const arg of rawArgs) {
  if (arg === '--watch') {
    isWatch = true;
  } else if (arg === '--sweep') {
    // Default behaviour; accepted for explicitness.
  } else if (arg.startsWith('--')) {
    console.warn(`${LOG_PREFIX} Ignoring unknown flag: ${arg}`);
  } else {
    positionalArgs.push(arg);
  }
}

const SRC_DIR = path.resolve(
  positionalArgs[0] || process.env.SRC_DIR || '/vault-input',
);
const DEST_DIR = path.resolve(
  positionalArgs[1] || process.env.DEST_DIR || '/usr/src/app/content',
);
const STATE_FILE = path.resolve(
  process.env.STATE_FILE || path.join(DEST_DIR, '.converter-state.json'),
);
const SITE_TITLE = process.env.SITE_TITLE || 'Appunti Uni';

const ALLOWED_ASSET_EXTS = new Set([
  '.pdf',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
]);

const EXCLUDED_NAMES = new Set([
  'private',
  'templates',
  '.obsidian',
  '.trash',
  '.git',
]);

let SRC_REAL = null;
let DEST_REAL = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function toKey(relPath) {
  return relPath.split(path.sep).join('/').toLowerCase();
}

function isInside(rootReal, candidate) {
  const rel = path.relative(rootReal, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function isExcludedRel(relPath) {
  if (!relPath) return false;
  return relPath.split(path.sep).some((part) => {
    if (!part || part === '.') return false;
    return part.startsWith('.') || EXCLUDED_NAMES.has(part.toLowerCase());
  });
}

function sha256String(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function tempPathFor(dest) {
  return path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${process.pid}.${crypto
      .randomBytes(4)
      .toString('hex')}.tmp`,
  );
}

function writeAtomic(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tempPathFor(dest);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function copyAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tempPathFor(dest);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function safeUnlink(file) {
  const resolved = path.resolve(file);
  if (!DEST_REAL) return false;
  try {
    const parentReal = fs.realpathSync(path.dirname(resolved));
    if (!isInside(DEST_REAL, parentReal)) return false;
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    fs.unlinkSync(resolved);
    return true;
  } catch {
    return false;
  }
}

function cleanEmptyDirectories(dir) {
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (!DEST_REAL || !isInside(DEST_REAL, realDir)) return;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) cleanEmptyDirectories(full);
  }

  if (realDir === DEST_REAL) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

/**
 * Walk a directory without following symlinks. Returns regular files and any
 * unreadable paths encountered along the way.
 */
function walkDirectory(root) {
  const files = [];
  const errors = [];

  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (err) {
    return { files, errors: [`${root}: ${err.message}`] };
  }

  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      errors.push(`${dir}: ${err.message}`);
      return;
    }

    for (const name of entries) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);

      if (isExcludedRel(rel)) continue;

      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        errors.push(`${full}: ${err.message}`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        log(`Skipping symlink: ${path.relative(SRC_DIR, full)}`);
        continue;
      }

      let real;
      try {
        real = fs.realpathSync(full);
      } catch (err) {
        errors.push(`${full}: ${err.message}`);
        continue;
      }

      if (!isInside(rootReal, real)) {
        log(`Skipping path escaping source root: ${path.relative(SRC_DIR, full)}`);
        continue;
      }

      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile()) {
        files.push(full);
      }
    }
  };

  visit(root);
  return { files, errors };
}

function isSafeSourceFile(file) {
  if (!SRC_REAL) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return false;
    const real = fs.realpathSync(file);
    return isInside(SRC_REAL, real);
  } catch {
    return false;
  }
}

/**
 * Resolve a source path case-insensitively without following symlinks.
 */
function findSourcePath(relPath) {
  if (!relPath || isExcludedRel(relPath)) return null;
  const direct = path.join(SRC_DIR, relPath);
  try {
    if (fs.lstatSync(direct).isFile()) return direct;
  } catch {}

  const dir = path.dirname(direct);
  const wanted = path.basename(direct).toLowerCase();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase() !== wanted) continue;
      const full = path.join(dir, name);
      try {
        if (fs.lstatSync(full).isFile()) return full;
      } catch {}
    }
  } catch {}
  return null;
}

function sourceExists(relPath) {
  return findSourcePath(relPath) !== null;
}

function normalizeMdRel(relPath) {
  const ext = path.extname(relPath);
  if (ext.toLowerCase() !== '.md') return relPath;
  return `${relPath.slice(0, relPath.length - ext.length)}.md`;
}

function svgRelFor(mdRel) {
  const ext = path.extname(mdRel);
  return `${mdRel.slice(0, mdRel.length - ext.length)}.svg`;
}

function sameOutputs(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function allOutputsExist(outputs) {
  return outputs.every((rel) => {
    try {
      return fs.lstatSync(path.join(DEST_DIR, rel)).isFile();
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Excalidraw note parsing
// ---------------------------------------------------------------------------

function parseDrawing(content) {
  if (
    !content.includes('excalidraw-plugin:') &&
    !content.includes('```compressed-json') &&
    !content.includes('```json')
  ) {
    return null;
  }

  const blockPattern = /```(compressed-json|json)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let match;

  while ((match = blockPattern.exec(content)) !== null) {
    const language = match[1];
    let jsonText = match[2].trim();

    if (language === 'compressed-json') {
      try {
        jsonText = LZString.decompressFromBase64(jsonText);
      } catch {
        continue;
      }
      if (!jsonText) continue;
    }

    try {
      const data = JSON.parse(jsonText);
      if (Array.isArray(data.elements)) return data;
    } catch {
      // Not a valid drawing block; keep looking.
    }
  }

  return null;
}

function extractSection(content, heading) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';

  const section = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line) || line.trim() === '%%') break;
    section.push(line);
  }
  return section.join('\n').trim();
}

function cleanExtractedText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+\^[\w-]+\s*$/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function buildCompanionMarkdown(relPath, content) {
  const ext = path.extname(relPath);
  const baseName = path.basename(relPath, ext);
  const svgFileName = `${baseName}.svg`;

  const text = cleanExtractedText(extractSection(content, 'Text Elements'));
  const embeddedSection = extractSection(content, 'Embedded Files');
  const rawLinks = embeddedSection.match(/\[\[[^\]]+\]\]/g) || [];
  const uniqueLinks = [...new Set(rawLinks)];

  const textBlock = text ? `\n\n### Note trascritte\n\n${text}` : '';
  const linksBlock = uniqueLinks.length
    ? `\n\n### Riferimenti collegati\n\n${uniqueLinks
        .map((link) => `- ${link}`)
        .join('\n')}`
    : '';

  const altText = baseName.replace(/[[\]]/g, '');

  return `---
title: ${JSON.stringify(baseName)}
---

# ${baseName}

![${altText}](<${svgFileName}>)${textBlock}${linksBlock}
`;
}

async function renderDrawing({ relPath, content, mdRel, svgRel, data }) {
  const appState = data.appState || {};
  const exportBackground = appState.exportBackground !== false;

  const svg = await exportScene({
    type: 'svg',
    data: {
      elements: data.elements,
      appState,
      files: data.files || {},
    },
    config: {
      padding: 15,
      theme: appState.exportWithDarkMode ? 'dark' : 'light',
      canvasBackgroundColor: exportBackground
        ? appState.viewBackgroundColor || '#ffffff'
        : false,
      environment: renderEnvironment,
    },
  });

  writeAtomic(path.join(DEST_DIR, svgRel), svg.outerHTML);
  writeAtomic(
    path.join(DEST_DIR, mdRel),
    buildCompanionMarkdown(relPath, content),
  );
}

// ---------------------------------------------------------------------------
// State manifest
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (
      parsed &&
      parsed.converterVersion === CONVERTER_VERSION &&
      parsed.files &&
      typeof parsed.files === 'object'
    ) {
      return parsed;
    }
  } catch {}
  return { converterVersion: CONVERTER_VERSION, files: {} };
}

let state = loadState();
let stateDirty = false;
let stateTimer = null;

function markStateDirty() {
  stateDirty = true;
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    saveState();
  }, 500);
  stateTimer.unref?.();
}

function saveState(force = false) {
  if (!force && !stateDirty) return;
  try {
    writeAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    stateDirty = false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Could not write state file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function assertSourceReady(files, errors) {
  if (errors.length > 0) {
    throw new Error(
      `Refusing to prune: ${errors.length} source path(s) could not be read ` +
        `(first: ${errors[0]}). The vault mount may be broken.`,
    );
  }

  if (files.length === 0) {
    throw new Error(
      'Refusing to prune: source vault is empty. The mount may be missing or not ready.',
    );
  }

  const markdownCount = files.filter(
    (file) => path.extname(file).toLowerCase() === '.md',
  ).length;
  if (markdownCount === 0) {
    throw new Error(
      'Refusing to prune: source vault contains no Markdown files. The mount may be missing or not ready.',
    );
  }
}

async function convertOne(srcFile) {
  const relPath = path.relative(SRC_DIR, srcFile);
  if (!relPath || relPath === '' || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return 'skipped';
  }

  if (isExcludedRel(relPath)) {
    await unpublish(relPath);
    return 'skipped';
  }

  if (!isSafeSourceFile(srcFile)) {
    log(`Skipping unsafe source path: ${relPath}`);
    return 'skipped';
  }

  const ext = path.extname(srcFile).toLowerCase();
  const key = toKey(relPath);

  if (ext === '.md') {
    let content;
    try {
      content = fs.readFileSync(srcFile, 'utf8');
    } catch (err) {
      console.error(`${LOG_PREFIX} Cannot read ${relPath}: ${err.message}`);
      return 'skipped';
    }

    const hash = sha256String(content);
    const mdRel = normalizeMdRel(relPath);
    const svgRel = svgRelFor(mdRel);
    const drawing = parseDrawing(content);
    const expectedOutputs = drawing ? [mdRel, svgRel] : [mdRel];
    const previous = state.files[key];

    if (
      previous &&
      previous.hash === hash &&
      sameOutputs(previous.outputs, expectedOutputs) &&
      allOutputsExist(expectedOutputs)
    ) {
      return 'cached';
    }

    if (drawing) {
      try {
        await renderDrawing({
          relPath,
          content,
          mdRel,
          svgRel,
          data: drawing,
        });
        state.files[key] = {
          hash,
          kind: 'drawing',
          outputs: expectedOutputs,
        };
        markStateDirty();
        return 'converted';
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Error rendering ${relPath}: ${err.message}`,
        );
        writeAtomic(path.join(DEST_DIR, mdRel), content);
        if (!sourceExists(svgRel)) {
          safeUnlink(path.join(DEST_DIR, svgRel));
        }
        state.files[key] = { hash, kind: 'markdown', outputs: [mdRel] };
        markStateDirty();
        return 'converted';
      }
    }

    writeAtomic(path.join(DEST_DIR, mdRel), content);
    if (
      previous?.kind === 'drawing' ||
      (fs.existsSync(path.join(DEST_DIR, svgRel)) && !sourceExists(svgRel))
    ) {
      safeUnlink(path.join(DEST_DIR, svgRel));
    }
    state.files[key] = { hash, kind: 'markdown', outputs: [mdRel] };
    markStateDirty();
    return 'converted';
  }

  if (ALLOWED_ASSET_EXTS.has(ext)) {
    // A drawing note generates <base>.svg. If the vault also contains a
    // source <base>.svg, the drawing wins and the source asset is skipped.
    if (ext === '.svg') {
      const baseRel = relPath.slice(0, relPath.length - path.extname(relPath).length);
      const mdRel = `${baseRel}.md`;
      const mdSource = findSourcePath(mdRel);
      if (mdSource) {
        try {
          if (parseDrawing(fs.readFileSync(mdSource, 'utf8'))) {
            log(`Skipping source SVG ${relPath}: drawing ${mdRel} generates it`);
            return 'skipped';
          }
        } catch {}
      }
    }

    const hash = sha256File(srcFile);
    const previous = state.files[key];
    if (
      previous &&
      previous.hash === hash &&
      sameOutputs(previous.outputs, [relPath]) &&
      allOutputsExist([relPath])
    ) {
      return 'cached';
    }

    copyAtomic(srcFile, path.join(DEST_DIR, relPath));
    state.files[key] = { hash, kind: 'asset', outputs: [relPath] };
    markStateDirty();
    return 'converted';
  }

  if (state.files[key]) {
    await unpublish(relPath);
  }
  return 'skipped';
}

async function unpublish(relPath) {
  const key = toKey(relPath);
  const entry = state.files[key];
  const ext = path.extname(relPath).toLowerCase();

  if (entry?.outputs?.length) {
    for (const output of entry.outputs) {
      if (
        ext === '.md' &&
        output.toLowerCase().endsWith('.svg') &&
        sourceExists(output)
      ) {
        continue;
      }
      safeUnlink(path.join(DEST_DIR, output));
    }
    delete state.files[key];
    markStateDirty();
  } else {
    if (ext === '.md') {
      const mdRel = normalizeMdRel(relPath);
      const svgRel = svgRelFor(mdRel);
      safeUnlink(path.join(DEST_DIR, mdRel));
      if (!sourceExists(svgRel)) {
        safeUnlink(path.join(DEST_DIR, svgRel));
      }
    } else {
      safeUnlink(path.join(DEST_DIR, relPath));
    }
    delete state.files[key];
    markStateDirty();
  }

  cleanEmptyDirectories(
    path.dirname(
      path.join(DEST_DIR, ext === '.md' ? normalizeMdRel(relPath) : relPath),
    ),
  );
}

async function unpublishDir(relPath) {
  const key = toKey(relPath);
  if (!key) return;

  const destDir = path.join(DEST_DIR, relPath);
  if (!DEST_REAL || !isInside(DEST_REAL, path.resolve(destDir))) return;

  const outputs = new Set();
  for (const [entryKey, entry] of Object.entries(state.files)) {
    if (entryKey === key || entryKey.startsWith(`${key}/`)) {
      for (const output of entry.outputs || []) outputs.add(output);
      delete state.files[entryKey];
    }
  }
  if (outputs.size > 0) markStateDirty();

  for (const output of outputs) {
    safeUnlink(path.join(DEST_DIR, output));
  }

  const walked = walkDirectory(destDir);
  for (const file of walked.files) safeUnlink(file);

  cleanEmptyDirectories(destDir);
}

function pruneOrphans(sourceFiles) {
  const sourceByKey = new Map();
  for (const file of sourceFiles) {
    sourceByKey.set(toKey(path.relative(SRC_DIR, file)), file);
  }

  const destWalk = walkDirectory(DEST_DIR);
  for (const error of destWalk.errors) {
    console.error(`${LOG_PREFIX} Could not inspect destination: ${error}`);
  }

  let pruned = 0;
  for (const destFile of destWalk.files) {
    const relPath = path.relative(DEST_DIR, destFile);
    const key = toKey(relPath);
    if (key === 'index.md') continue;

    const ext = path.extname(relPath).toLowerCase();

    if (ext === '.svg') {
      if (sourceByKey.has(key)) continue; // a real source .svg asset

      const mdKey = `${key.slice(0, -'.svg'.length)}.md`;
      const mdSource = sourceByKey.get(mdKey);
      if (mdSource) {
        try {
          if (parseDrawing(fs.readFileSync(mdSource, 'utf8'))) continue;
        } catch {}
      }

      if (safeUnlink(destFile)) pruned += 1;
      continue;
    }

    if (sourceByKey.has(key)) continue;
    if (safeUnlink(destFile)) pruned += 1;
  }

  cleanEmptyDirectories(DEST_DIR);
  if (pruned > 0) {
    log(`Pruned ${pruned} orphaned file(s).`);
  }
}

function ensureRootIndex() {
  const indexFile = path.join(DEST_DIR, 'index.md');
  if (fs.existsSync(indexFile)) return;

  const directories = [];
  let entries = [];
  try {
    entries = fs.readdirSync(DEST_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(DEST_DIR, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) directories.push(entry.name);
  }

  directories.sort();
  const links = directories
    .map((dir) => `- [[${dir}/index|${dir}]]`)
    .join('\n');

  const content = `---
title: ${JSON.stringify(SITE_TITLE)}
---

# ${SITE_TITLE}

Benvenuto nella raccolta note. Scegli una cartella per iniziare:

${links}
`;
  writeAtomic(indexFile, content);
}

async function runSweep() {
  const { files, errors } = walkDirectory(SRC_DIR);
  assertSourceReady(files, errors);

  pruneOrphans(files);

  // Markdown first so a drawing can claim <base>.svg before an asset copy.
  files.sort((left, right) => {
    const leftMd = path.extname(left).toLowerCase() === '.md' ? 0 : 1;
    const rightMd = path.extname(right).toLowerCase() === '.md' ? 0 : 1;
    return leftMd - rightMd || left.localeCompare(right);
  });

  let converted = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const result = await convertOne(file);
      if (result === 'converted') converted += 1;
      else if (result === 'cached') cached += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `${LOG_PREFIX} Failed to process ${path.relative(SRC_DIR, file)}: ${err.message}`,
      );
    }
  }

  ensureRootIndex();
  saveState(true);

  log(
    `Sweep complete: ${converted} converted, ${cached} cached, ` +
      `${skipped} skipped, ${failed} failed.`,
  );
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

let watcher = null;
let shuttingDown = false;
const queues = new Map();

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .then(task, task)
    .catch((err) => {
      console.error(`${LOG_PREFIX} Watch task failed for ${key}: ${err.message}`);
    })
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
  return next;
}

async function startWatcher() {
  const { watch } = await import('chokidar');

  watcher = watch(SRC_DIR, {
    persistent: true,
    ignoreInitial: false,
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
    ignored: (candidate) => {
      const relPath = path.relative(SRC_DIR, candidate);
      return relPath !== '' && isExcludedRel(relPath);
    },
  });

  const onFile = (event) => (filePath) => {
    const relPath = path.relative(SRC_DIR, filePath);
    enqueue(toKey(relPath), async () => {
      log(`[${event}] ${relPath}`);
      if (event === 'unlink') {
        await unpublish(relPath);
      } else {
        await convertOne(filePath);
      }
    });
  };

  watcher.on('add', onFile('add'));
  watcher.on('change', onFile('change'));
  watcher.on('unlink', onFile('unlink'));
  watcher.on('unlinkDir', (dirPath) => {
    const relPath = path.relative(SRC_DIR, dirPath);
    enqueue(toKey(relPath), async () => {
      log(`[unlinkDir] ${relPath}`);
      await unpublishDir(relPath);
    });
  });
  watcher.on('error', async (err) => {
    console.error(`${LOG_PREFIX} Watcher error: ${err.message}`);
    try {
      await watcher.close();
    } catch {}
    process.exit(1);
  });
  watcher.on('ready', () => log('Watcher ready.'));

  log(`Watching "${SRC_DIR}" for changes...`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}; shutting down.`);
  try {
    await watcher?.close();
  } catch {}
  saveState();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('uncaughtException', (err) => {
  console.error(`${LOG_PREFIX} Uncaught exception:`, err);
  saveState();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`${LOG_PREFIX} Unhandled rejection:`, err);
  saveState();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  DEST_REAL = fs.realpathSync(DEST_DIR);

  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Source directory does not exist: ${SRC_DIR}`);
  }
  const sourceStat = fs.statSync(SRC_DIR);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${SRC_DIR}`);
  }
  SRC_REAL = fs.realpathSync(SRC_DIR);

  log(`Starting converter v${CONVERTER_VERSION} (watch: ${isWatch})`);
  log(`Source: "${SRC_DIR}" -> Destination: "${DEST_DIR}"`);
  log(`State: "${STATE_FILE}"`);

  await runSweep();

  if (isWatch) {
    await startWatcher();
  } else {
    saveState();
  }
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  saveState();
  process.exit(1);
});
