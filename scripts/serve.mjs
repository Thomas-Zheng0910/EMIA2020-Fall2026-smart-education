/**
 * Runs the public demo: the API (restarted on server edits) and a frontend build
 * that rewrites dist/ on every change, so the site tracks this working copy.
 *
 * `tsx watch` restarts the API when a file changes, but it does *not* bring back a
 * child that died on its own — the process sitting behind the tunnel would go dark
 * while systemd still saw the unit as healthy. So this supervisor watches the API's
 * health and exits when it stops answering; systemd's Restart= then restarts the unit.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const port = Number(process.env.PORT || 4310);
const bin = process.platform === 'win32' ? '.cmd' : '';
const children = [
  spawn('node_modules/.bin/tsx' + bin, ['watch', '--env-file-if-exists=.env', 'server/index.ts'], { stdio: 'inherit' }),
  spawn('node_modules/.bin/vite' + bin, ['build', '--watch', '--mode', 'production'], { stdio: 'inherit' }),
];

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  // Give the children a moment to release the port before systemd restarts us.
  setTimeout(() => process.exit(code), 300).unref();
};

// A child that exits on its own (a crash, not a file-change restart) ends the unit.
for (const c of children) c.on('exit', (code) => stop(code ?? 1));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The API takes a few seconds to boot, so misses are only fatal once they persist. */
let misses = 0;
for (;;) {
  await sleep(5000);
  if (stopping) break;
  if (await healthy()) misses = 0;
  else if (++misses >= 4) {
    console.error(`[serve] API did not answer on :${port} — restarting through systemd.`);
    stop(1);
    break;
  }
}
