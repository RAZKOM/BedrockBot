#!/usr/bin/env node
// Run tests on a second machine (the test host, a Mac or Linux box you can ssh to) instead of this one
// (docs/runbook.md "Tests on the Mac (Track I1)"). Called from a checkout or worktree on the dev machine:
//
//   node scripts/mac-run.mjs [options] -- <command...>     sync this checkout to the test host, run the command there
//   node scripts/mac-run.mjs bds up|down|status|pack|tps|logs [fly fly2 fly3]   the test host's BDS containers
//   node scripts/mac-run.mjs status                        slots, load, the live bot's test series, the checkouts
//   node scripts/mac-run.mjs private <dir>                 copy a private fixture folder (bot/fixtures-private/cave)
//   node scripts/mac-run.mjs clean                         remove this checkout's copy on the test host
//
// A run: (1) the files git sees in the checkout (tracked and untracked, not ignored) are compared by SHA-1 with the
// test host's copy in ~/<dir>/checkouts/<name>/ and only the changed ones are sent (a tar stream over ssh; files the
// checkout no longer has are deleted there); (2) scripts/mac/remote.sh runs the command there: it waits while the live
// bot runs a `!test` series or the load is high, takes a slot (at most BEDROCKBOT_TEST_SLOTS heavy runs at once),
// installs the dependencies when the lockfile or a package.json changed, and runs the command at low priority
// (nice 10) with at most BEDROCKBOT_MAX_WORKERS (4) vitest and bench workers, HOME pointed at a sandbox so nothing
// reads or writes the live bot's ~/.bedrockbot. The output streams back; the exit code is the command's.
//
// Options (before `--`):
//   --name <n>       the test checkout's name (default: this checkout's folder name)
//   --light          no wait, no slot, no install (quick looks: `-- cat file`, `-- git status`)
//   --no-wait        skip the wait rule (the slot is still taken)
//   --no-sync        run on the copy as it is
//   --install        force `pnpm install` before the command
//   --pull <path>    after the run copy this file (relative to the checkout) back here; repeatable
//   -e NAME[=VALUE]  pass an environment variable (the value from here when omitted); repeatable.
//                    BDS_E2E, BOT_VERSION, BDS_TRANSPORT and the suites' FLY_* / MOVE_* / WATER_* / REACH_* / ...
//                    variables set here are passed by themselves (see FORWARD below); inline `NAME=value cmd`
//                    in the command works as well (it runs in bash).
//   --as-live        run the command under the live bot's CPU policy (macOS background QoS, `taskpolicy -b`: the
//                    efficiency cores, throttled), to time planners as the live bot gets them
//   --dry-run        print what would be sent and run
//
// Environment (no machine name or home path lives in the repository):
//   BEDROCKBOT_TEST_HOST     the ssh host (an alias from ~/.ssh/config or user@address); default BEDROCKBOT_DEPLOY_HOST
//   BEDROCKBOT_TEST_DIR      the test root on the host, relative to its home (default bbtest.noindex: Spotlight
//                            leaves a folder named *.noindex alone; indexing a fresh node_modules took 1.5 cores)
//   BEDROCKBOT_TEST_NODE     the folder with node 24 and pnpm on the host, relative to its home (default .local/node/bin)
//   BEDROCKBOT_TEST_SLOTS    heavy runs at once on the host (default 2), BEDROCKBOT_TEST_MAX_LOAD the 1-minute load
//                            average above which a run waits (default 7), BEDROCKBOT_MAX_WORKERS (default 4)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const SAFE_REL = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Variables passed to the host by themselves when they are set here (values with a backslash, i.e. Windows paths, are not). */
const FORWARD = /^(BDS_E2E|BOT_VERSION|BDS_TRANSPORT|BDS_SOAK|(FLY|MOVE|WATER|REACH|T1|W1|W2|W3|NAV|BARI|PHYS|DIG|R1|F\d+)_[A-Z0-9_]+)$/;
/** Changes to these make the host run `pnpm install` before the command. */
const INSTALL_TRIGGER = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|[^/]+\/package\.json|[^/]+\/[^/]+\/package\.json|patches\/.*)$/;

function fail(message, code = 2) {
  console.error(`mac-run: ${message}`);
  process.exit(code);
}

// ---- arguments --------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const opts = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const command = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
const o = { name: undefined, light: false, wait: true, sync: true, install: false, asLive: false, pull: [], env: [], dry: false, sub: undefined, subArgs: [] };
for (let i = 0; i < opts.length; i++) {
  const a = opts[i];
  const next = () => {
    if (i + 1 >= opts.length) fail(`${a} needs a value`);
    return opts[++i];
  };
  if (a === '--name') o.name = next();
  else if (a === '--light') o.light = true;
  else if (a === '--no-wait') o.wait = false;
  else if (a === '--no-sync') o.sync = false;
  else if (a === '--install') o.install = true;
  else if (a === '--pull') o.pull.push(next());
  else if (a === '-e' || a === '--env') o.env.push(next());
  else if (a === '--dry-run') o.dry = true;
  else if (a === '--as-live') o.asLive = true;
  else if (!a.startsWith('-') && o.sub === undefined && dashdash < 0) {
    o.sub = a;
    o.subArgs = opts.slice(i + 1);
    break;
  } else fail(`unknown option ${a} (see the header of scripts/mac-run.mjs)`);
}
if (o.sub === undefined && command.length === 0) fail('nothing to run: node scripts/mac-run.mjs [options] -- <command...> (or bds | status | private | clean)');
if (o.sub !== undefined && !['bds', 'status', 'private', 'clean'].includes(o.sub)) fail(`unknown subcommand ${o.sub}`);

const host = process.env.BEDROCKBOT_TEST_HOST || process.env.BEDROCKBOT_DEPLOY_HOST || '';
if (!SAFE_HOST.test(host)) {
  fail('set BEDROCKBOT_TEST_HOST (or BEDROCKBOT_DEPLOY_HOST) to the ssh host of the test machine (an alias from ~/.ssh/config or user@address).');
}
const testDir = process.env.BEDROCKBOT_TEST_DIR || 'bbtest.noindex';
const nodeDir = process.env.BEDROCKBOT_TEST_NODE || '.local/node/bin';
for (const [n, v] of [['BEDROCKBOT_TEST_DIR', testDir], ['BEDROCKBOT_TEST_NODE', nodeDir]]) {
  if (!SAFE_REL.test(v) || v.split('/').includes('..')) fail(`${n} must be a plain relative path, got ${JSON.stringify(v)}`);
}

// The checkout: the git top level of the current directory (a worktree is its own top level).
const here = dirname(fileURLToPath(import.meta.url));
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
const root = resolve(top.status === 0 ? top.stdout.trim() : join(here, '..'));
const name = o.name ?? basename(root);
if (!SAFE_NAME.test(name)) fail(`the checkout name must be letters, digits, . _ - (got ${JSON.stringify(name)}); pass --name`);
/** Remote paths, relative to the host's home (the remote shell starts there). */
const R = { dir: testDir, co: `${testDir}/checkouts/${name}`, node: nodeDir };

// ---- ssh helpers ------------------------------------------------------------------------------------------------

/** POSIX single-quote a word unless it is plainly safe (so `NAME=value` stays an assignment). */
function shq(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function sshCapture(remote, input) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, remote], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) fail(`cannot run ssh: ${r.error.message}`, 1);
  return r;
}

// ---- the sync ---------------------------------------------------------------------------------------------------

function gitLs(args) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ls-files failed in ${root}: ${r.stderr}`, 1);
  return r.stdout.split('\0').filter(Boolean);
}

/** The files to send: tracked (minus deleted ones and symlinks) and untracked-not-ignored, with size, mode and SHA-1. */
function localFiles() {
  const modes = new Map();
  for (const line of gitLs(['-s'])) {
    const m = /^(\d+) [0-9a-f]+ \d\t(.*)$/.exec(line);
    if (m) modes.set(m[2], m[1]);
  }
  const paths = new Set([...modes.keys(), ...gitLs(['--others', '--exclude-standard'])]);
  const files = [];
  for (const p of [...paths].sort()) {
    const mode = modes.get(p);
    if (mode === '160000' || mode === '120000') continue; // submodules, symlinks
    const abs = join(root, p);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // deleted in the checkout, not yet in the index
    }
    if (!st.isFile()) continue;
    const data = readFileSync(abs);
    const exec = mode === '100755' || /\.(sh|bash)$/.test(p);
    files.push({ p, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), exec, h: createHash('sha1').update(data).digest('hex') });
  }
  return files;
}

/**
 * Runs on the host (node, the program on stdin after CO_REL and LIST): which of the listed files differ there; deletes
 * what the last sync sent and the checkout no longer has (the manifest), so files the tests write are left alone.
 */
const REMOTE_DIFF = String.raw`
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const co = path.join(process.env.HOME, CO_REL);
const list = LIST;
fs.mkdirSync(path.join(co, '.mac-run'), { recursive: true });
// one sync of a checkout at a time: held from this diff to the end of the tar that follows it (two runs of the same
// worktree started together extracted over each other: "Can't create ...: File exists"); stale after 2 minutes
const lock = path.join(co, '.mac-run', 'sync.lock');
for (const t0 = Date.now(); ;) {
  try { fs.mkdirSync(lock); break; } catch {}
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) { fs.rmdirSync(lock); continue; } } catch {}
  if (Date.now() - t0 > 180000) { console.error('another sync of this checkout holds .mac-run/sync.lock'); process.exit(3); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}
const manifest = path.join(co, '.mac-run', 'manifest.json');
let old = [];
try { old = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch {}
const now = new Set(list.map((f) => f.p));
let deleted = 0;
for (const p of old) if (!now.has(p)) { try { fs.unlinkSync(path.join(co, p)); deleted++; } catch {} }
const need = [];
for (const f of list) {
  const abs = path.join(co, f.p);
  let ok = false;
  try { const st = fs.statSync(abs); ok = st.size === f.size && createHash('sha1').update(fs.readFileSync(abs)).digest('hex') === f.h; } catch {}
  if (!ok) need.push(f.p);
}
fs.writeFileSync(manifest, JSON.stringify(list.map((f) => f.p)));
if (need.length === 0) fs.rmdirSync(lock);
process.stdout.write(JSON.stringify({ need, deleted, fresh: !fs.existsSync(path.join(co, 'node_modules', '.modules.yaml')) }));
`;

function tarHeader(p, size, mode, mtime) {
  const b = Buffer.alloc(512);
  let nameField = p;
  let prefix = '';
  if (Buffer.byteLength(p) > 100) {
    const cut = p.lastIndexOf('/', p.length - 1);
    // the longest prefix (<= 155 bytes) that leaves a name of <= 100 bytes
    let at = -1;
    for (let i = p.indexOf('/'); i >= 0 && i <= cut; i = p.indexOf('/', i + 1)) {
      if (i <= 155 && Buffer.byteLength(p.slice(i + 1)) <= 100) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error(`path too long for a tar header: ${p}`);
    prefix = p.slice(0, at);
    nameField = p.slice(at + 1);
  }
  const put = (s, off, len) => b.write(s, off, Math.min(len, Buffer.byteLength(s)), 'utf8');
  const oct = (n, off, len) => put(`${n.toString(8).padStart(len - 1, '0')}\0`, off, len);
  put(nameField, 0, 100);
  oct(mode, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(mtime, 136, 12);
  b.fill(0x20, 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const x of b) sum += x;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return b;
}

async function sendTar(files) {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', host, `tar -xf - -C ${R.co}; rc=$?; rmdir ${R.co}/.mac-run/sync.lock 2>/dev/null; exit $rc`], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res) => child.on('close', (code) => res(code)));
  const write = (buf) => (child.stdin.write(buf) ? Promise.resolve() : new Promise((r) => child.stdin.once('drain', r)));
  for (const f of files) {
    const data = readFileSync(join(root, f.p));
    await write(tarHeader(f.p, data.length, f.exec ? 0o755 : 0o644, f.mtime));
    await write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024));
  child.stdin.end();
  return done;
}

async function sync() {
  const t0 = Date.now();
  if (o.dry) {
    console.log(`mac-run: would sync ${root} with ${host}:~/${R.co}`);
    return { changed: [], install: false };
  }
  const files = localFiles();
  const program = `const CO_REL = ${JSON.stringify(R.co)};\nconst LIST = ${JSON.stringify(files.map(({ p, size, h }) => ({ p, size, h })))};\n${REMOTE_DIFF}`;
  const r = sshCapture(`mkdir -p ${R.co} && ${R.node}/node -`, program);
  if (r.status !== 0) fail(`the sync helper failed on ${host} (is node 24 at ~/${R.node}? set BEDROCKBOT_TEST_NODE): ${r.stderr.trim()}`, 1);
  const diff = JSON.parse(r.stdout.trim());
  const byPath = new Map(files.map((f) => [f.p, f]));
  const send = diff.need.map((p) => byPath.get(p)).filter(Boolean);
  if (send.length > 0) {
    const code = await sendTar(send);
    if (code !== 0) fail(`sending ${send.length} files to ${host} failed (tar exit ${code})`, 1);
  }
  const sent = send.reduce((s, f) => s + f.size, 0);
  console.log(`mac-run: synced ${name} to ${host}: ${send.length} of ${files.length} files sent (${(sent / 1e6).toFixed(2)} MB), ${diff.deleted} deleted, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { changed: diff.need, install: diff.fresh || diff.need.some((p) => INSTALL_TRIGGER.test(p)) };
}

// ---- the run ----------------------------------------------------------------------------------------------------

function envList() {
  const out = [];
  const seen = new Set();
  for (const e of o.env) {
    const eq = e.indexOf('=');
    const k = eq >= 0 ? e.slice(0, eq) : e;
    const v = eq >= 0 ? e.slice(eq + 1) : process.env[k];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`bad variable name ${JSON.stringify(k)}`);
    if (v === undefined) fail(`-e ${k}: not set here`);
    out.push(`${k}=${v}`);
    seen.add(k);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (seen.has(k) || !FORWARD.test(k) || v === undefined || v.includes('\\')) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** The remote wrapper with its settings as an environment prefix (every value base64 or plainly safe). */
function remoteCall(mode, extra = {}) {
  const vars = {
    MR_DIR: R.dir,
    MR_CO: R.co,
    MR_NAME: name,
    MR_NODE: R.node,
    MR_SLOTS: process.env.BEDROCKBOT_TEST_SLOTS ?? '',
    MR_MAX_LOAD: process.env.BEDROCKBOT_TEST_MAX_LOAD ?? '',
    MR_WORKERS: process.env.BEDROCKBOT_MAX_WORKERS ?? '',
    ...extra,
  };
  for (const [k, v] of Object.entries(vars)) if (!/^[A-Za-z0-9+/=._-]*$/.test(String(v))) fail(`internal: unsafe value for ${k}`, 1);
  const prefix = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${prefix} bash ${R.co}/scripts/mac/remote.sh ${mode}`;
}

/** Runs a remote call with the output streamed; stdin stays open so the host's watchdog sees when we go away. */
function stream(remote) {
  return new Promise((res) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', host, remote], { stdio: ['pipe', 'inherit', 'inherit'] });
    const stop = () => {
      console.error('\nmac-run: interrupted; stopping the run on the host');
      child.stdin.end(); // EOF on the host's stdin: its watchdog kills the command's process group
      setTimeout(() => child.kill(), 10_000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('close', (code, signal) => res(code ?? (signal ? 1 : 0)));
  });
}

function pull(paths) {
  let bad = 0;
  for (const p of paths) {
    if (!SAFE_REL.test(p) || p.split('/').includes('..')) {
      console.error(`mac-run: --pull ${p}: give a plain path relative to the checkout`);
      bad++;
      continue;
    }
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `cat ${R.co}/${p}`], { maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0) {
      console.error(`mac-run: --pull ${p}: ${String(r.stderr).trim() || `exit ${r.status}`}`);
      bad++;
      continue;
    }
    writeFileSync(join(root, ...p.split('/')), r.stdout);
    console.log(`mac-run: pulled ${p} (${r.stdout.length} bytes)`);
  }
  return bad;
}

/** `private <dir>`: copy a private fixture folder (files only, one level of subfolders) to ~/<dir>/private/<basename>. */
async function sendPrivate(dir) {
  const src = resolve(dir);
  if (!existsSync(src) || !statSync(src).isDirectory()) fail(`${dir} is not a folder`);
  const rel = relative(root, src);
  if (!rel.startsWith('..') && !rel.split(sep).includes('fixtures-private')) fail('refusing: only a git-ignored fixtures-private folder (or one outside the checkout) is copied');
  const leaf = basename(src);
  if (!SAFE_NAME.test(leaf)) fail(`folder name ${leaf} is not plain`);
  const files = [];
  const walk = (d, pre) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile()) {
        const st = statSync(join(d, e.name));
        files.push({ p: `${pre}${e.name}`, abs: join(d, e.name), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      }
    }
  };
  walk(src, '');
  const target = `${R.dir}/private/${leaf}`;
  if (o.dry) {
    console.log(`mac-run: would copy ${files.length} files to ${host}:~/${target}`);
    return 0;
  }
  const child = spawn('ssh', ['-o', 'BatchMode=yes', host, `rm -rf ${target} && mkdir -p ${target} && chmod 700 ${R.dir}/private && tar -xf - -C ${target}`], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res) => child.on('close', res));
  for (const f of files) {
    const fd = openSync(f.abs, 'r');
    const data = Buffer.alloc(f.size);
    readSync(fd, data, 0, f.size, 0);
    closeSync(fd);
    child.stdin.write(tarHeader(f.p, f.size, 0o600, f.mtime));
    child.stdin.write(data);
    const pad = (512 - (f.size % 512)) % 512;
    if (pad) child.stdin.write(Buffer.alloc(pad));
  }
  child.stdin.end(Buffer.alloc(1024));
  const code = await done;
  if (code === 0) console.log(`mac-run: ${files.length} private files in ${host}:~/${target} (the runs set CAVE_FIXTURE_DIR to ~/${R.dir}/private/cave)`);
  return code ?? 1;
}

// ---- main -------------------------------------------------------------------------------------------------------

async function main() {
  if (o.sub === 'private') {
    if (o.subArgs.length !== 1) fail('usage: node scripts/mac-run.mjs private <folder>');
    return sendPrivate(o.subArgs[0]);
  }
  if (o.sub === 'clean') {
    if (o.dry) return console.log(`mac-run: would remove ${host}:~/${R.co}`), 0;
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `rm -rf ${R.co} ${R.dir}/homes/${name}`], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  let install = o.install;
  if (o.sync) {
    const s = await sync();
    install ||= s.install;
  }
  if (o.dry) {
    console.log(`mac-run: would run on ${host}: ${command.map(shq).join(' ') || o.sub}`);
    return 0;
  }
  let code;
  if (o.sub === 'bds' || o.sub === 'status') {
    const words = o.sub === 'bds' ? o.subArgs : [];
    for (const w of words) if (!/^[a-z0-9]+$/.test(w)) fail(`bds: unknown word ${w}`);
    code = await stream(remoteCall(o.sub === 'bds' ? `bds ${words.join(' ')}` : 'status', { MR_INSTALL: install ? '1' : '0' }));
  } else {
    const cmd = command.length === 1 ? command[0] : command.map(shq).join(' ');
    code = await stream(remoteCall('run', {
      MR_CMD: b64(cmd),
      MR_ENV: b64(envList().join('\n')),
      MR_INSTALL: install ? '1' : '0',
      MR_LOCK: o.light ? '0' : '1',
      MR_WAIT: o.light || !o.wait ? '0' : '1',
      MR_AS_LIVE: o.asLive ? '1' : '0',
    }));
  }
  if (o.pull.length > 0 && pull(o.pull) > 0 && code === 0) code = 1;
  return code;
}

main().then((code) => process.exit(code ?? 0), (err) => fail(err instanceof Error ? err.stack ?? err.message : String(err), 1));
