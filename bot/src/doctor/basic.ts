// `pnpm bot:check` (Track REL1, docs/getting-started.md "Before the first start"): the checks that need nothing but Node
// itself, so they still run when `pnpm install` never ran or failed: the Node version, pnpm, the installed dependencies
// and the repository's patches. The checks that read the config file (setup.ts) import the dependencies and run after
// these pass. Pure apart from the injected file reads; unit-tested in test/unit/doctor.test.ts.
import { join } from 'node:path';

export type Level = 'ok' | 'info' | 'warn' | 'fail';

/** One line of the report; `fix` says what to do in one line (warn and fail only). */
export interface Check {
  name: string;
  level: Level;
  text: string;
  fix?: string;
}

export interface BasicInput {
  /** process.versions.node */
  nodeVersion: string;
  /** The root package.json's `engines.node` (">=24") and `packageManager` ("pnpm@12.16.1"). */
  engines: string | undefined;
  packageManager: string | undefined;
  /** env npm_config_user_agent: set by pnpm (and npm) for the scripts they run. */
  userAgent: string | undefined;
  /** bot/package.json `dependencies` (exact pins) and `optionalDependencies`. */
  dependencies: Readonly<Record<string, string>>;
  optional: Readonly<Record<string, string>>;
  /** The bot package's directory (node_modules/<name> is looked up there). */
  botDir: string;
  /** Read a text file, or undefined when it does not exist or cannot be read. */
  readText(path: string): string | undefined;
}

/** The lowest major version an `engines` range such as ">=24" or "^24.1" allows (undefined: none given). */
export function minMajor(engines: string | undefined): number | undefined {
  const m = /(\d+)/.exec(engines ?? '');
  return m ? Number(m[1]) : undefined;
}

export function checkNode(i: Pick<BasicInput, 'nodeVersion' | 'engines'>): Check {
  const need = minMajor(i.engines) ?? 24;
  const major = Number(i.nodeVersion.split('.')[0]);
  if (Number.isFinite(major) && major >= need) return { name: 'node', level: 'ok', text: `v${i.nodeVersion} (needs ${need} or newer)` };
  return { name: 'node', level: 'fail', text: `v${i.nodeVersion} is too old: the bot runs its TypeScript with Node's own type stripping, from Node ${need}`, fix: `install Node ${need} (the version in .nvmrc), e.g. \`nvm install ${need}\`, then run \`pnpm install\` again` };
}

export function checkPnpm(i: Pick<BasicInput, 'packageManager' | 'userAgent'>): Check {
  const pinned = /^pnpm@(.+)$/.exec(i.packageManager ?? '')?.[1];
  const used = /\bpnpm\/(\S+)/.exec(i.userAgent ?? '')?.[1];
  if (!used) {
    const npm = /\bnpm\/(\S+)/.test(i.userAgent ?? '');
    if (npm) return { name: 'pnpm', level: 'warn', text: 'started through npm: this repository installs with pnpm only (its patches and lockfile)', fix: `run \`corepack enable\` once, then \`pnpm install\` and \`pnpm bot:check\`${pinned ? ` (pnpm ${pinned} comes from package.json)` : ''}` };
    return { name: 'pnpm', level: 'info', text: `not started through pnpm (fine for this check)${pinned ? `; the repository pins pnpm ${pinned}: \`corepack enable\` once provides it` : ''}` };
  }
  if (pinned && used !== pinned) return { name: 'pnpm', level: 'warn', text: `pnpm ${used}, the repository pins ${pinned}`, fix: 'run `corepack enable` once so the pinned pnpm runs in this folder (another pnpm can rewrite the lockfile)' };
  return { name: 'pnpm', level: 'ok', text: `pnpm ${used}${pinned ? ' (the pinned one)' : ''}` };
}

function installedVersion(i: Pick<BasicInput, 'botDir' | 'readText'>, name: string): string | undefined {
  const text = i.readText(join(i.botDir, 'node_modules', name, 'package.json'));
  if (text === undefined) return undefined;
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Every pinned dependency installed at its pin; the optional ones reported as info. */
export function checkDependencies(i: BasicInput): Check[] {
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const [name, pin] of Object.entries(i.dependencies)) {
    const v = installedVersion(i, name);
    if (v === undefined) missing.push(name);
    else if (/^\d/.test(pin) && v !== pin) wrong.push(`${name} ${v} (pinned ${pin})`);
  }
  const out: Check[] = [];
  const n = Object.keys(i.dependencies).length;
  if (missing.length > 0) out.push({ name: 'dependencies', level: 'fail', text: `${missing.length} of ${n} not installed (${missing.join(', ')})`, fix: 'run `pnpm install` in the repository root (not npm: the patches and the lockfile need pnpm)' });
  else if (wrong.length > 0) out.push({ name: 'dependencies', level: 'fail', text: `not the pinned versions: ${wrong.join(', ')}`, fix: 'run `pnpm install` in the repository root; do not update packages by hand (tools/bump-version/playbook.md)' });
  else out.push({ name: 'dependencies', level: 'ok', text: `${n} installed at their pins` });
  for (const [name] of Object.entries(i.optional)) {
    if (installedVersion(i, name) === undefined) out.push({ name: 'dependencies', level: 'info', text: `optional ${name} not installed: the panel draws glyphs instead of item pictures (docs/panel.md)` });
  }
  return out;
}

/**
 * The pnpm patches (pnpm-workspace.yaml patchedDependencies) applied: minecraft-data lists the derived 1.26.70 and
 * bedrock-protocol has the signalling fallback. An install without them (npm, or `pnpm install --ignore-patches`) joins
 * fewer servers and fails on some Realms.
 */
export function checkPatches(i: Pick<BasicInput, 'botDir' | 'readText'>): Check {
  const paths = i.readText(join(i.botDir, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'dataPaths.json'));
  const signalling = i.readText(join(i.botDir, 'node_modules', 'bedrock-protocol', 'src', 'nethernet', 'signalling.js'));
  if (paths === undefined || signalling === undefined) return { name: 'patches', level: 'fail', text: 'minecraft-data or bedrock-protocol is missing', fix: 'run `pnpm install` in the repository root' };
  const missing: string[] = [];
  try {
    if (!(JSON.parse(paths) as { bedrock?: Record<string, unknown> }).bedrock?.['1.26.70']) missing.push('minecraft-data (1.26.70)');
  } catch {
    missing.push('minecraft-data (unreadable dataPaths.json)');
  }
  if (!signalling.includes('_triedDefaultHost')) missing.push('bedrock-protocol (signalling fallback)');
  if (missing.length > 0) return { name: 'patches', level: 'fail', text: `not applied: ${missing.join(', ')}`, fix: 'delete node_modules and run `pnpm install` (it applies patches/ by itself; npm does not)' };
  return { name: 'patches', level: 'ok', text: 'minecraft-data and bedrock-protocol patched' };
}

export function basicChecks(i: BasicInput): Check[] {
  return [checkNode(i), checkPnpm(i), ...checkDependencies(i), checkPatches(i)];
}

const LABEL: Record<Level, string> = { ok: 'ok  ', info: 'info', warn: 'WARN', fail: 'FAIL' };

/** The report: one line a check, its fix indented under it, and a last line with the counts. */
export function formatReport(checks: readonly Check[]): string {
  const width = Math.max(8, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  ${LABEL[c.level]}  ${c.name.padEnd(width)}  ${c.text}`);
    if (c.fix && (c.level === 'warn' || c.level === 'fail')) lines.push(`  ${' '.repeat(6 + width)}  fix: ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(fails > 0 ? `${fails} problem${fails === 1 ? '' : 's'}${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}: fix the FAIL lines, then run \`pnpm bot:check\` again` : warns > 0 ? `ready, with ${warns} warning${warns === 1 ? '' : 's'} to read` : 'ready: start the bot (README "Quick start")');
  return lines.join('\n');
}

/** Exit code: 1 when anything failed. */
export function exitCode(checks: readonly Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
