#!/usr/bin/env node
/**
 * Excalidraw Publisher converter.
 *
 * Mirrors an Obsidian vault into a Quartz content directory, rendering
 * Excalidraw notes to self-contained SVG files.
 *
 * Usage:
 *   node convert.mjs [--watch] [--sweep] [--force] <src> <dest>
 *
 *   --force  Ignore the size/mtime cache and hash every source file.
 *
 * Environment:
 *   SRC_DIR, DEST_DIR, STATE_FILE, SITE_TITLE
 *   STARTUP_HASH_CHECK  Set to 1 to hash every file at startup instead of
 *                       trusting size/mtime (slow; verification only).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import LZString from 'lz-string';

// Bumped whenever converted output changes: loadState() drops the whole
// manifest on a mismatch, which forces a full rebuild.
const CONVERTER_VERSION = '2.2.1';
const LOG_PREFIX = '[Converter]';

// ---------------------------------------------------------------------------
// Headless DOM / canvas environment for Excalidraw's SVG renderer
// ---------------------------------------------------------------------------

/**
 * Loading jsdom, the native canvas binding and the Excalidraw bundle costs
 * noticeable CPU and memory, and a start where every note is cached never
 * needs them. Import them on first use instead of at module load.
 */
let rendererPromise = null;

async function getRenderer() {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const { JSDOM } = await import('jsdom');
      const { Image, Path2D, createCanvas } = await import('@napi-rs/canvas');

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

      // Node 22 exposes `navigator` as a getter-only global, so a plain
      // assignment throws. Re-define the property instead, and fall back to
      // Node's navigator.
      try {
        Object.defineProperty(globalThis, 'navigator', {
          value: dom.window.navigator,
          configurable: true,
        });
      } catch {
        // Node's built-in navigator is good enough if it cannot be replaced.
      }

      // jsdom has no FontFace implementation. Excalidraw only uses the object
      // to build @font-face CSS; the actual Woff2 data is embedded by the
      // renderer.
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
      const { getStroke } = await import('perfect-freehand');

      const renderEnvironment = {
        document: dom.window.document,
        createCanvas: (width, height) =>
          createCanvas(
            Math.max(1, Math.floor(width || 1)),
            Math.max(1, Math.floor(height || 1)),
          ),
        createImage: () => new Image(),
        createPath: (d) => new Path2D(d),
        // Excalidraw embeds the fonts in the SVG itself, so no browser font
        // loading is required for the exported file.
        loadFonts: async () => {},
      };

      return { exportScene, renderEnvironment, getStroke };
    })().catch((err) => {
      // Allow a later attempt instead of caching the rejection forever.
      rendererPromise = null;
      throw err;
    });
  }
  return rendererPromise;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
let isWatch = false;
// Only the literal "1" enables it, so `STARTUP_HASH_CHECK=false` in .env stays
// off instead of becoming a truthy string.
let isForce = (process.env.STARTUP_HASH_CHECK || '').trim() === '1';
// Seconds between background reconciliation sweeps in watch mode; 0 disables
// them. Writes made outside the container never reach its inotify when the
// vault comes from a network or FUSE-backed share. Polling every watched file
// costs thousands of stats per pass, so a periodic sweep that reuses the mtime
// cache is the cheap alternative.
const sweepSeconds = (() => {
  const raw = (process.env.SWEEP_INTERVAL || '').trim();
  if (raw === '') return 3600;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logWarn(`Ignoring invalid SWEEP_INTERVAL "${raw}".`);
    return 3600;
  }
  return Math.floor(parsed);
})();
const positionalArgs = [];

for (const arg of rawArgs) {
  if (arg === '--watch') {
    isWatch = true;
  } else if (arg === '--force') {
    isForce = true;
  } else if (arg === '--sweep') {
    // Default behaviour; accepted for explicitness.
  } else if (arg.startsWith('--')) {
    logWarn(`Ignoring unknown flag: ${arg}`);
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
const PDF_CACHE_DIR = path.join(DEST_DIR, '.pdf-cache');
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

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function logPrefix() {
  return `[${formatTimestamp()}] ${LOG_PREFIX}`;
}

function log(message) {
  console.log(`${logPrefix()} ${message}`);
}

function logWarn(message) {
  console.warn(`${logPrefix()} ${message}`);
}

function logError(message, ...args) {
  console.error(`${logPrefix()} ${message}`, ...args);
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
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
  const dirs = [];
  const errors = [];

  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (err) {
    return { files, dirs, errors: [`${root}: ${err.message}`] };
  }

  const visit = (dir) => {
    dirs.push(dir);
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
  return { files, dirs, errors };
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
  if (!relPath || path.isAbsolute(relPath) || isExcludedRel(relPath)) return null;
  const parts = relPath.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return null;

  const direct = path.join(SRC_DIR, ...parts);
  if (isSafeSourceFile(direct)) return direct;

  let current = SRC_DIR;
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    const wanted = parts[i].toLowerCase();
    const exact = path.join(current, parts[i]);
    let next = null;

    try {
      const stat = fs.lstatSync(exact);
      if (isLast ? stat.isFile() : stat.isDirectory()) next = exact;
    } catch {}

    if (!next) {
      let entries;
      try {
        entries = fs.readdirSync(current);
      } catch {
        return null;
      }
      for (const name of entries) {
        if (name.toLowerCase() !== wanted) continue;
        const candidate = path.join(current, name);
        try {
          const stat = fs.lstatSync(candidate);
          if (isLast ? stat.isFile() : stat.isDirectory()) {
            next = candidate;
            break;
          }
        } catch {}
      }
    }

    if (!next) return null;
    current = next;
  }

  return isSafeSourceFile(current) ? current : null;
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

/**
 * Cheap change detector: size plus mtime, without reading the file. Editing a
 * file updates its mtime, so an unchanged signature means the cached hash is
 * still valid and the file never has to be read at all.
 */
function fileSignature(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function signatureUnchanged(entry, sig) {
  return Boolean(
    entry && sig && entry.size === sig.size && entry.mtimeMs === sig.mtimeMs,
  );
}

function outputsIntact(entry) {
  return (
    Boolean(entry) &&
    Array.isArray(entry.outputs) &&
    allOutputsExist(entry.outputs)
  );
}

function withSignature(entry, sig) {
  return sig ? { ...entry, size: sig.size, mtimeMs: sig.mtimeMs } : entry;
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
        // Some editors wrap the base64 payload across lines; the decoder
        // rejects any whitespace, so drop it before decompressing.
        jsonText = LZString.decompressFromBase64(jsonText.replace(/\s+/g, ''));
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

const IMAGE_MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);

// PDF pages imported into a drawing are referenced as `file.pdf#page=N`; they
// have to be rasterized before they can be inlined.
const PDF_RENDER_DPI = 150;
const PDF_RENDER_QUALITY = 80;

/**
 * Render one PDF page to a cached JPEG and return its bytes. The cache lives
 * inside the content directory (Quartz ignores dot-directories) so restarts
 * and note edits do not rasterize the same page again.
 */
function renderPdfPage(pdfFile, page) {
  const cacheKey = `${crypto
    .createHash('sha1')
    .update(`${pdfFile}:${page}:${PDF_RENDER_DPI}:${PDF_RENDER_QUALITY}`)
    .digest('hex')}.jpg`;
  const cacheFile = path.join(PDF_CACHE_DIR, cacheKey);

  try {
    return fs.readFileSync(cacheFile);
  } catch {}

  const tmpPrefix = path.join(PDF_CACHE_DIR, `.tmp-${process.pid}-${cacheKey}`);
  try {
    fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
    execFileSync(
      'pdftoppm',
      [
        '-f',
        String(page),
        '-l',
        String(page),
        '-r',
        String(PDF_RENDER_DPI),
        '-jpeg',
        '-jpegopt',
        `quality=${PDF_RENDER_QUALITY}`,
        '-singlefile',
        pdfFile,
        tmpPrefix,
      ],
      { stdio: 'ignore', timeout: 120000 },
    );
    fs.renameSync(`${tmpPrefix}.jpg`, cacheFile);
    return fs.readFileSync(cacheFile);
  } catch (err) {
    try {
      fs.unlinkSync(`${tmpPrefix}.jpg`);
    } catch {}
    logError(
      `Cannot render page ${page} of ${path.relative(SRC_DIR, pdfFile)}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Excalidraw notes keep image data outside the drawing JSON: the
 * `## Embedded Files` section maps each element's `fileId` to a vault path.
 * Inline the ones that exist as data URLs, because an SVG displayed through
 * an `<img>` tag cannot load external files. PDF imports are rasterized first.
 * Missing images are left out and render empty, just like in Obsidian.
 */
function resolveEmbeddedFiles(data, relPath, content) {
  const files = { ...(data.files || {}) };
  const section = extractSection(content, 'Embedded Files');
  const noteDir = path.dirname(path.join(SRC_DIR, relPath));

  if (!section) return files;

  for (const line of section.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}):\s*\[\[([^\]|]+)/i.exec(line.trim());
    if (!match) continue;

    const id = match[1];
    const link = match[2];
    const target = link.split('#')[0].trim();
    if (!target) continue;

    const rel = path.relative(SRC_DIR, path.resolve(noteDir, target));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (isExcludedRel(rel)) continue;

    const source = findSourcePath(rel);
    if (!source) continue;

    const ext = path.extname(source).toLowerCase();

    if (ext === '.pdf') {
      const page = Number(/[#&]page=(\d+)/.exec(link)?.[1] || 0);
      if (page < 1) continue;
      const jpeg = renderPdfPage(source, page);
      if (!jpeg) continue;
      files[id] = {
        id,
        mimeType: 'image/jpeg',
        dataURL: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        created: Date.now(),
      };
      continue;
    }

    const mimeType = IMAGE_MIME_TYPES.get(ext);
    if (!mimeType) continue;

    try {
      files[id] = {
        id,
        mimeType,
        dataURL: `data:${mimeType};base64,${fs.readFileSync(source).toString('base64')}`,
        created: Date.now(),
      };
    } catch {}
  }

  return files;
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

![${altText}](<${svgFileName}>)${textBlock}${linksBlock}
`;
}

// ---------------------------------------------------------------------------
// Custom freedraw pens
// ---------------------------------------------------------------------------

// Obsidian's Excalidraw plugin stores the pen used for every stroke in
// `element.customData.strokeOptions`, and its Excalidraw fork renders freedraw
// with those options. Upstream Excalidraw only knows its own defaults
// (thinning 0.6, smoothing 0.5, easeOutSine, no taper), so exporting with it
// gives every stroke the default pen shape regardless of what was drawn.
//
// The renderer has no hook for a precomputed path, so the drawing is exported
// once and the `d` of each freedraw path is replaced with the outline the pen
// describes. The math below is the fork's `freedrawPath.ts`, ported verbatim.
const EASING_FUNCTIONS = (() => {
  const pow = Math.pow;
  const sqrt = Math.sqrt;
  const sin = Math.sin;
  const cos = Math.cos;
  const PI = Math.PI;
  const c1 = 1.70158;
  const c2 = c1 * 1.525;
  const c3 = c1 + 1;
  const c4 = (2 * PI) / 3;
  const c5 = (2 * PI) / 4.5;

  const bounceOut = (x) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  };

  return {
    linear: (x) => x,
    easeInQuad: (x) => x * x,
    easeOutQuad: (x) => 1 - (1 - x) * (1 - x),
    easeInOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - pow(-2 * x + 2, 2) / 2),
    easeInCubic: (x) => x * x * x,
    easeOutCubic: (x) => 1 - pow(1 - x, 3),
    easeInOutCubic: (x) =>
      x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2,
    easeInQuart: (x) => x * x * x * x,
    easeOutQuart: (x) => 1 - pow(1 - x, 4),
    easeInOutQuart: (x) =>
      x < 0.5 ? 8 * x * x * x * x : 1 - pow(-2 * x + 2, 4) / 2,
    easeInQuint: (x) => x * x * x * x * x,
    easeOutQuint: (x) => 1 - pow(1 - x, 5),
    easeInOutQuint: (x) =>
      x < 0.5 ? 16 * x * x * x * x * x : 1 - pow(-2 * x + 2, 5) / 2,
    easeInSine: (x) => 1 - cos((x * PI) / 2),
    easeOutSine: (x) => sin((x * PI) / 2),
    easeInOutSine: (x) => -(cos(PI * x) - 1) / 2,
    easeInExpo: (x) => (x === 0 ? 0 : pow(2, 10 * x - 10)),
    easeOutExpo: (x) => (x === 1 ? 1 : 1 - pow(2, -10 * x)),
    easeInOutExpo: (x) =>
      x === 0
        ? 0
        : x === 1
          ? 1
          : x < 0.5
            ? pow(2, 20 * x - 10) / 2
            : (2 - pow(2, -20 * x + 10)) / 2,
    easeInCirc: (x) => 1 - sqrt(1 - pow(x, 2)),
    easeOutCirc: (x) => sqrt(1 - pow(x - 1, 2)),
    easeInOutCirc: (x) =>
      x < 0.5
        ? (1 - sqrt(1 - pow(2 * x, 2))) / 2
        : (sqrt(1 - pow(-2 * x + 2, 2)) + 1) / 2,
    easeInBack: (x) => c3 * x * x * x - c1 * x * x,
    easeOutBack: (x) => 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2),
    easeInOutBack: (x) =>
      x < 0.5
        ? (pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
        : (pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
    easeInElastic: (x) =>
      x === 0
        ? 0
        : x === 1
          ? 1
          : -pow(2, 10 * x - 10) * sin((x * 10 - 10.75) * c4),
    easeOutElastic: (x) =>
      x === 0
        ? 0
        : x === 1
          ? 1
          : pow(2, -10 * x) * sin((x * 10 - 0.75) * c4) + 1,
    easeInOutElastic: (x) =>
      x === 0
        ? 0
        : x === 1
          ? 1
          : x < 0.5
            ? -(pow(2, 20 * x - 10) * sin((20 * x - 11.125) * c5)) / 2
            : (pow(2, -20 * x + 10) * sin((20 * x - 11.125) * c5)) / 2 + 1,
    easeInBounce: (x) => 1 - bounceOut(1 - x),
    easeOutBounce: bounceOut,
    easeInOutBounce: (x) =>
      x < 0.5
        ? (1 - bounceOut(1 - 2 * x)) / 2
        : (1 + bounceOut(2 * x - 1)) / 2,
  };
})();

const SVG_PATH_PRECISION =
  /(\s?[A-Z]?,?-?[0-9]*\.[0-9]{0,2})(([0-9]|e|-)*)/g;

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function svgPathFromStroke(points) {
  if (!points.length) return '';
  const lastIndex = points.length - 1;
  return points
    .reduce(
      (acc, point, index, all) => {
        if (index === lastIndex) {
          acc.push(point, midpoint(point, all[0]), 'L', all[0], 'Z');
        } else {
          acc.push(point, midpoint(point, all[index + 1]));
        }
        return acc;
      },
      ['M', points[0], 'Q'],
    )
    .join(' ')
    .replace(SVG_PATH_PRECISION, '$1');
}

function freedrawInputPoints(element) {
  if (element.simulatePressure) return element.points;
  if (element.points.length === 0) return [[0, 0, 0.5]];
  return element.points.map(([x, y], index) => [
    x,
    y,
    element.pressures[index],
  ]);
}

function freedrawPath(element, getStroke, useCustomPen) {
  const customOptions = useCustomPen
    ? element.customData?.strokeOptions?.options
    : null;
  const inputPoints = freedrawInputPoints(element);

  if (!customOptions) {
    return svgPathFromStroke(
      getStroke(inputPoints, {
        simulatePressure: element.simulatePressure,
        size: element.strokeWidth * 4.25,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: element.strokeOptions?.streamline ?? 0.5,
        easing: EASING_FUNCTIONS.easeOutSine,
        last: true,
      }),
    );
  }

  const options = {
    ...customOptions,
    simulatePressure:
      customOptions.simulatePressure ?? element.simulatePressure,
    size: element.strokeWidth * 4.25,
    last: true,
    easing: EASING_FUNCTIONS[customOptions.easing] ?? ((t) => t),
  };

  if (customOptions.start?.easing) {
    options.start = {
      ...customOptions.start,
      easing: EASING_FUNCTIONS[customOptions.start.easing] ?? ((t) => t),
    };
  }
  if (customOptions.end?.easing) {
    options.end = {
      ...customOptions.end,
      easing: EASING_FUNCTIONS[customOptions.end.easing] ?? ((t) => t),
    };
  }

  return svgPathFromStroke(getStroke(inputPoints, options));
}

// Matches the `filter: invert(93%) hue-rotate(180deg)` Excalidraw applies to
// colours in a dark-theme export. Only outlined pens need it: their fill is
// the pen's background colour, which the exporter never sees.
const DARK_MODE_INVERT = 0.93;

function parseHexColor(color) {
  const match = /^#([0-9a-f]{3,8})$/i.exec(color);
  if (!match) return null;

  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  if (hex.length !== 6 && hex.length !== 8) return null;

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
  };
}

function applyDarkModeFilter(color, dark) {
  if (!dark || color === 'transparent') return color;
  const rgb = parseHexColor(color);
  if (!rgb) return color;

  const invertChannel = (value) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(
          value * (1 - DARK_MODE_INVERT) + (255 - value) * DARK_MODE_INVERT,
        ),
      ),
    );
  const r = invertChannel(rgb.r) / 255;
  const g = invertChannel(rgb.g) / 255;
  const b = invertChannel(rgb.b) / 255;

  // hue-rotate(180deg) matrix, applied after the inversion.
  const rotated = [
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ].map((value) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0'),
  );

  const alpha = rgb.a === 255 ? '' : rgb.a.toString(16).padStart(2, '0');
  return `#${rotated.join('')}${alpha}`;
}

/**
 * Replace the outline of every freedraw stroke that carries custom pen
 * settings. Nodes are matched by their exported `d`, which is deterministic,
 * so an exporter change leaves the affected strokes untouched instead of
 * corrupting them.
 */
function replaceFreedrawPaths(svg, elements, getStroke, dark) {
  const pathsByD = new Map();
  for (const node of svg.querySelectorAll('path[d]')) {
    const d = node.getAttribute('d');
    const list = pathsByD.get(d);
    if (list) list.push(node);
    else pathsByD.set(d, [node]);
  }

  let unmatched = 0;
  for (const element of elements) {
    if (
      element.type !== 'freedraw' ||
      element.isDeleted ||
      !element.customData?.strokeOptions
    ) {
      continue;
    }

    const defaultD = freedrawPath(element, getStroke, false);
    const node = pathsByD.get(defaultD)?.shift();
    if (!node) {
      unmatched += 1;
      continue;
    }

    const customD = freedrawPath(element, getStroke, true);
    const pen = element.customData.strokeOptions;
    // Most colour-only pens produce the same outline; leave them byte-for-byte
    // identical so unchanged drawings do not churn.
    if (customD === defaultD && !pen.hasOutline) continue;

    const wrapper = node.parentElement;
    if (!wrapper) continue;

    if (pen.hasOutline) {
      const outline = svg.ownerDocument.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      outline.setAttribute('fill', 'none');
      // The exporter already applied the theme filter to strokeColor, which is
      // exactly what the fork uses for the outline.
      outline.setAttribute('stroke', node.getAttribute('fill'));
      outline.setAttribute(
        'stroke-width',
        `${element.strokeWidth * (pen.outlineWidth ?? 1)}`,
      );
      outline.setAttribute('d', customD);
      wrapper.insertBefore(outline, node);
      node.setAttribute(
        'fill',
        applyDarkModeFilter(element.backgroundColor || 'transparent', dark),
      );
    }

    node.setAttribute('d', customD);
  }

  if (unmatched > 0) {
    logWarn(
      `${unmatched} freedraw path(s) had no matching exported ` +
        'outline; they keep the default pen shape.',
    );
  }
}

async function renderDrawing({ relPath, content, mdRel, svgRel, data, files }) {
  const { exportScene, renderEnvironment, getStroke } = await getRenderer();
  const appState = data.appState || {};
  const exportBackground = appState.exportBackground !== false;
  const dark = Boolean(appState.exportWithDarkMode);

  const svg = await exportScene({
    type: 'svg',
    data: {
      elements: data.elements,
      appState,
      files,
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

  replaceFreedrawPaths(svg, data.elements, getStroke, dark);

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
    logError(`Could not write state file: ${err.message}`);
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

/**
 * The published site lowercases every path, so two names that differ only by
 * case would silently overwrite each other. Refuse to guess which one wins.
 */
function assertNoCaseCollisions(files, dirs) {
  const byKey = new Map();
  const add = (relPath) => {
    const key = toKey(relPath);
    const list = byKey.get(key);
    if (list) list.push(relPath);
    else byKey.set(key, [relPath]);
  };

  for (const file of files) add(path.relative(SRC_DIR, file));
  for (const dir of dirs) {
    const rel = path.relative(SRC_DIR, dir);
    if (rel) add(rel);
  }

  const clashes = [...byKey.values()].filter((list) => list.length > 1);
  if (clashes.length === 0) return;

  throw new Error(
    `Refusing to convert: ${clashes.length} name(s) differ only by case:\n` +
      clashes.map((list) => `  ${list.join(' / ')}`).join('\n') +
      '\nRename or delete one; both cannot be published.',
  );
}

async function convertOne(srcFile, force = false) {
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
    const mdRel = normalizeMdRel(relPath);
    const svgRel = svgRelFor(mdRel);
    const previous = state.files[key];
    const sig = fileSignature(srcFile);
    // A drawing note has two outputs, a plain note one. Accept either shape as
    // long as it matches the current file name, so the note never has to be
    // read on the fast path.
    const knownOutputs =
      Boolean(previous) &&
      (sameOutputs(previous.outputs, [mdRel, svgRel]) ||
        sameOutputs(previous.outputs, [mdRel]));

    if (
      !force &&
      signatureUnchanged(previous, sig) &&
      knownOutputs &&
      outputsIntact(previous)
    ) {
      return 'cached';
    }

    let content;
    try {
      content = fs.readFileSync(srcFile, 'utf8');
    } catch (err) {
      logError(`Cannot read ${relPath}: ${err.message}`);
      return 'skipped';
    }

    const hash = sha256String(content);
    // Parse once; the drawing (if any) replaces the raw note with a rendered
    // companion page.
    const drawing = parseDrawing(content);
    const parsedOutputs = drawing ? [mdRel, svgRel] : [mdRel];

    // Same bytes and same classification (touch, rsync -t): keep the existing
    // output and just refresh the signature. The embedded images cannot have
    // changed if the note itself did not.
    if (
      previous &&
      previous.hash === hash &&
      sameOutputs(previous.outputs, parsedOutputs) &&
      outputsIntact(previous)
    ) {
      state.files[key] = withSignature(previous, sig);
      markStateDirty();
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
          files: resolveEmbeddedFiles(drawing, relPath, content),
        });
        state.files[key] = withSignature(
          { hash, kind: 'drawing', outputs: parsedOutputs },
          sig,
        );
        markStateDirty();
        return 'converted';
      } catch (err) {
        logError(`Error rendering ${relPath}: ${err.message}`);
        writeAtomic(path.join(DEST_DIR, mdRel), content);
        if (!sourceExists(svgRel)) {
          safeUnlink(path.join(DEST_DIR, svgRel));
        }
        state.files[key] = withSignature(
          { hash, kind: 'markdown', outputs: [mdRel] },
          sig,
        );
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
    state.files[key] = withSignature(
      { hash, kind: 'markdown', outputs: [mdRel] },
      sig,
    );
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

    const previous = state.files[key];
    const sig = fileSignature(srcFile);
    if (
      !force &&
      signatureUnchanged(previous, sig) &&
      sameOutputs(previous.outputs, [relPath]) &&
      allOutputsExist([relPath])
    ) {
      return 'cached';
    }

    const hash = sha256File(srcFile);
    if (
      previous &&
      previous.hash === hash &&
      sameOutputs(previous.outputs, [relPath]) &&
      allOutputsExist([relPath])
    ) {
      state.files[key] = withSignature(previous, sig);
      markStateDirty();
      return 'cached';
    }

    copyAtomic(srcFile, path.join(DEST_DIR, relPath));
    state.files[key] = withSignature(
      { hash, kind: 'asset', outputs: [relPath] },
      sig,
    );
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
    // With a shared (case-insensitive) key, make sure this entry describes
    // the file being removed before deleting anything.
    const owned = entry.outputs.some(
      (output) => output === relPath || output === normalizeMdRel(relPath),
    );
    if (!owned) {
      logError(
        `Refusing to unpublish ${relPath}: state belongs to ` +
          `${entry.outputs[0]} (names differ only by case).`,
      );
      return;
    }

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
    logError(`Could not inspect destination: ${error}`);
  }

  let pruned = 0;
  for (const destFile of destWalk.files) {
    const relPath = path.relative(DEST_DIR, destFile);
    const key = toKey(relPath);
    if (key === 'index.md') continue;

    const ext = path.extname(relPath).toLowerCase();

    if (ext === '.svg') {
      // The snapshot is a fast path; `sourceExists`/`findSourcePath` also see
      // files created after it was taken (the watcher may have published them
      // while this sweep was running), which must not be pruned as orphans.
      if (sourceByKey.has(key) || sourceExists(relPath)) continue;

      const mdRel = `${relPath.slice(0, -'.svg'.length)}.md`;
      const mdKey = toKey(mdRel);
      const mdSource = sourceByKey.get(mdKey) || findSourcePath(mdRel);
      if (mdSource) {
        try {
          if (parseDrawing(fs.readFileSync(mdSource, 'utf8'))) continue;
        } catch {}
      }

      if (safeUnlink(destFile)) pruned += 1;
      continue;
    }

    if (sourceByKey.has(key) || sourceExists(relPath)) continue;
    if (safeUnlink(destFile)) pruned += 1;
  }

  let statePruned = 0;
  for (const entryKey of Object.keys(state.files)) {
    if (sourceByKey.has(entryKey) || sourceExists(entryKey)) continue;
    delete state.files[entryKey];
    statePruned += 1;
  }
  if (statePruned > 0) markStateDirty();

  cleanEmptyDirectories(DEST_DIR);
  if (pruned > 0) {
    log(`Pruned ${pruned} orphaned file(s).`);
  }
}

function ensureRootIndex() {
  const indexFile = path.join(DEST_DIR, 'index.md');

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

  const header = `---
title: ${JSON.stringify(SITE_TITLE)}
---`;
  const intro = 'Benvenuto nella raccolta note. Scegli una cartella per iniziare:';
  const content = `${header}

${intro}

${links}
`;

  if (fs.existsSync(indexFile)) {
    // Older versions duplicated the site title as a Markdown heading, while
    // Quartz already renders it from the frontmatter. Replace only the known
    // generated prefix so edits below it survive.
    const existing = fs.readFileSync(indexFile, 'utf8');
    const legacyPrefix = `${header}

# ${SITE_TITLE}

${intro}`;
    if (existing.startsWith(legacyPrefix)) {
      writeAtomic(indexFile, `${header}

${intro}${existing.slice(legacyPrefix.length)}`);
    }
    return;
  }

  writeAtomic(indexFile, content);
}

async function runSweep(force = false) {
  const startedAt = performance.now();
  const { files, dirs, errors } = walkDirectory(SRC_DIR);
  assertSourceReady(files, errors);
  assertNoCaseCollisions(files, dirs);

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
      const result = await convertQueued(file, force);
      if (result === 'converted') converted += 1;
      else if (result === 'cached') cached += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logError(
        `Failed to process ${path.relative(SRC_DIR, file)}: ${err.message}`,
      );
    }
  }

  // Prune against a fresh listing: a file created or removed while the sweep
  // was running is already handled by the watcher, and pruning with the
  // snapshot taken above would delete its output or keep a stale page alive.
  try {
    const after = walkDirectory(SRC_DIR);
    assertSourceReady(after.files, after.errors);
    pruneOrphans(after.files);
  } catch (err) {
    logError(`Skipping prune: ${err.message}`);
  }

  ensureRootIndex();
  saveState(true);

  const elapsed = formatDuration(performance.now() - startedAt);
  log(
    `Sweep complete in ${elapsed}: ${converted} converted, ${cached} cached, ` +
      `${skipped} skipped, ${failed} failed.`,
  );
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

let watcher = null;
let sweepTimer = null;
let shuttingDown = false;
const queues = new Map();

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .then(task, task)
    .catch((err) => {
      logError(`Watch task failed for ${key}: ${err.message}`);
    })
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
  return next;
}

/**
 * Convert through the per-file queue. Sweeps and watcher events share it, so a
 * file is never converted twice at once and the later read always wins: the
 * sweep either runs before a pending event (which then re-reads) or after the
 * running conversion, never in the middle of it.
 */
async function convertQueued(srcFile, force) {
  const key = toKey(path.relative(SRC_DIR, srcFile));
  let outcome = 'skipped';
  let failure = null;
  await enqueue(key, async () => {
    try {
      outcome = await convertOne(srcFile, force);
    } catch (err) {
      failure = err;
    }
  });
  if (failure) throw failure;
  return outcome;
}

/**
 * Return a sibling whose name differs from this file only by case, if any.
 * Such a pair cannot both be published, so the new file is refused instead of
 * silently replacing the existing one until the next sweep.
 */
function caseTwin(relPath) {
  const dir = path.dirname(path.join(SRC_DIR, relPath));
  const name = path.basename(relPath);
  const lowered = name.toLowerCase();
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry !== name && entry.toLowerCase() === lowered) {
        return path.join(path.dirname(relPath), entry);
      }
    }
  } catch {}
  return null;
}

async function startWatcher() {
  const { watch } = await import('chokidar');

  watcher = watch(SRC_DIR, {
    persistent: true,
    // The ready handler sweeps the entire vault once the baseline scan finishes;
    // announcing every existing file as `add` would flood the queue and logs.
    ignoreInitial: true,
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
      if (event === 'add') {
        const twin = caseTwin(relPath);
        if (twin) {
          logError(
            `Refusing to convert ${relPath}: name differs ` +
              `only by case from ${twin}. Rename or delete one.`,
          );
          return;
        }
      }
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
    logError(`Watcher error: ${err.message}`);
    try {
      await watcher.close();
    } catch {}
    process.exit(1);
  });
  watcher.on('ready', async () => {
    // Run the single startup sweep once chokidar's baseline exists so events
    // arriving during the sweep serialize cleanly through `convertQueued`.
    // If this initial sweep fails, fail fast instead of leaving Quartz on
    // incomplete content.
    try {
      await runSweep(isForce);
    } catch (err) {
      logError(`Initial sweep failed: ${err.message}`);
      try {
        await watcher.close();
      } catch {}
      saveState();
      process.exit(1);
    }
    startSweepTimer();
    if (process.connected) process.send('ready');
    log('Watcher ready.');
  });

  log(`Watching "${SRC_DIR}" for changes...`);
}

/**
 * Sweep on a timer to pick up writes the kernel never reported. Only needed
 * when the source lives on a filesystem that does not forward inotify events
 * (NFS, SMB, 9p, FUSE-backed shares); elsewhere it is cheap, because the sweep
 * reuses the mtime cache.
 */
function startSweepTimer() {
  if (sweepSeconds <= 0) {
    log('Periodic sweep disabled.');
    return;
  }

  // setTimeout clamps anything above 2^31-1 ms, which would turn a very large
  // interval into a near-constant rebuild loop.
  const interval = Math.min(sweepSeconds * 1000, 2 ** 31 - 1);

  const scheduleNext = () => {
    if (shuttingDown) return;
    sweepTimer = setTimeout(async () => {
      sweepTimer = null;
      if (shuttingDown) return;
      try {
        await runSweep();
      } catch (err) {
        logError(`Periodic sweep failed: ${err.message}`);
      } finally {
        scheduleNext();
      }
    }, interval);
    // The watcher keeps the process alive; the timer must not.
    sweepTimer.unref();
  };

  scheduleNext();
  log(`Periodic sweep every ${sweepSeconds}s.`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}; shutting down.`);
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
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
  logError('Uncaught exception:', err);
  saveState();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logError('Unhandled rejection:', err);
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

  if (isWatch) {
    await startWatcher();
  } else {
    await runSweep(isForce);
    saveState();
  }
}

main().catch((err) => {
  logError('Fatal error:', err);
  saveState();
  process.exit(1);
});
