// Run the whole e2e suite against ONE container profile, by setting every suite's env vars
// (chat-helpers BDS_*, world-truth BDS_WORLD_*, skills-input PHYS_BDS_*, env.ts BOT_VERSION /
// BDS_TRANSPORT). The default suite (no profile) still targets bds-dev, bds-world and bds-phys.
//   node scripts/e2e-profile.ts dev60 [vitest args...]   BDS 1.26.60.6 (bds60, udp/19134), game version 1.26.60, RakNet
//   node scripts/e2e-profile.ts nn [vitest args...]      BDS 1.26.51.1 (bds-nn, 19140), NetherNet LAN signalling
// The container needs the truth pack: `node scripts/bds.mjs pack --profile <name>` from the repo root.
// Root shortcuts: pnpm e2e:60 | pnpm e2e:nn
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Profile {
  container: string;
  port: number;
  version: string;
  transport: 'raknet' | 'nethernet';
  build: string;
}

const PROFILES: Record<string, Profile> = {
  dev60: { container: 'bds60', port: 19134, version: '1.26.60', transport: 'raknet', build: '1.26.60.6' },
  nn: { container: 'bds-nn', port: 19140, version: '1.26.51', transport: 'nethernet', build: '1.26.51.1' },
};

const [name, ...rest] = process.argv.slice(2).filter((a, i) => !(a === '--' && i === 0));
const p = name ? PROFILES[name] : undefined;
if (!p) {
  console.error(`usage: node scripts/e2e-profile.ts <${Object.keys(PROFILES).join('|')}> [vitest args...]`);
  process.exit(2);
}
const port = String(p.port);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  BDS_E2E: '1',
  BOT_VERSION: p.version,
  BDS_TRANSPORT: p.transport,
  BDS_BUILD: p.build,
  BDS_CONTAINER: p.container,
  BDS_PORT: port,
  BDS_WORLD_CONTAINER: p.container,
  BDS_WORLD_PORT: port,
  PHYS_BDS_CONTAINER: p.container,
  PHYS_BDS_PORT: port,
};
console.error(`[e2e-profile] ${name}: ${p.container} (BDS ${p.build}) port ${port}, version ${p.version}, transport ${p.transport}`);
const botDir = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const r = spawnSync(process.execPath, [vitest, 'run', '--project', 'e2e', ...rest], { cwd: botDir, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
