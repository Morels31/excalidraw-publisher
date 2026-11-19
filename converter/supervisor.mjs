#!/usr/bin/env node
/**
 * Process supervisor for the publisher container.
 *
 * Runs the converter in watch mode first, waits for its single `ready` IPC
 * message (signaled only after the initial sweep succeeds), and then starts
 * Quartz build --watch. Keeps startup to one sweep and forwards shutdown
 * signals cleanly to both child processes.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [srcDir, destDir, siteDir] = process.argv.slice(2);
if (!srcDir || !destDir || !siteDir) {
  console.error('Usage: node supervisor.mjs <srcDir> <destDir> <siteDir>');
  process.exit(1);
}

const CONVERTER =
  process.env.CONVERTER_SCRIPT ||
  fileURLToPath(new URL('./convert.mjs', import.meta.url));
const QUARTZ_CLI =
  process.env.QUARTZ_CLI || '/usr/src/app/quartz/bootstrap-cli.mjs';

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function log(message) {
  console.log(`[${timestamp()}] [run] ${message}`);
}

function logError(message) {
  console.error(`[${timestamp()}] [run] ${message}`);
}

let ready = false;
let shuttingDown = false;
let exitCode = 0;
let converter = null;
let quartz = null;
let restartTimer = null;
let forceExitTimer = null;

function maybeExit() {
  if (!converter && !quartz) {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

function beginShutdown(code, signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  clearTimeout(restartTimer);
  restartTimer = null;
  converter?.kill(signal);
  quartz?.kill(signal);
  forceExitTimer = setTimeout(() => process.exit(exitCode), 5000);
  forceExitTimer.unref();
  maybeExit();
}

function startQuartz() {
  // Watch mode rebuilds siteDir on changes; it never opens a port, the nginx
  // container serves the output. Invoke the bundled CLI directly instead of
  // `npx` so the container never touches npm's resolution/cache paths.
  quartz = spawn(
    process.execPath,
    [QUARTZ_CLI, 'build', '--watch', '--concurrency=4', '--output', siteDir],
    { stdio: 'inherit' },
  );
  quartz.on('exit', (code, signal) => {
    quartz = null;
    if (shuttingDown) {
      maybeExit();
      return;
    }
    logError(`Quartz exited (${code ?? signal}); stopping converter.`);
    beginShutdown(code ?? (signal ? 1 : 0));
  });
}

function startConverter(forceCheck) {
  const env = forceCheck
    ? process.env
    : { ...process.env, STARTUP_HASH_CHECK: '0' };

  converter = spawn(
    process.execPath,
    [CONVERTER, '--watch', srcDir, destDir],
    { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env },
  );

  converter.on('message', (msg) => {
    if (msg === 'ready' && !ready && !shuttingDown) {
      ready = true;
      startQuartz();
    }
  });

  converter.on('exit', (code, signal) => {
    converter = null;
    if (shuttingDown) {
      maybeExit();
      return;
    }
    if (!ready) {
      logError(
        `Converter exited (${code ?? signal}) before becoming ready.`,
      );
      process.exit(code || 1);
    }
    logError(`Converter exited (${code ?? signal}); restarting in 2s...`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!shuttingDown) startConverter(false);
    }, 2000);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    beginShutdown(0, signal);
  });
}

log('Starting converter...');
startConverter(true);
