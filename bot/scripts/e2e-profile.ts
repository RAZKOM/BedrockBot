// Run the whole e2e suite against ONE container profile, by setting every suite's env vars
// (chat-helpers BDS_*, world-truth BDS_WORLD_*, skills-input PHYS_BDS_*, move-truth MOVE_BDS_*,
// dig-truth DIG_BDS_*, wood-truth WOOD_BDS_*, hard-truth HARD_BDS_*, rl-truth RL_BDS_*, act-truth ACT_BDS_*, pve-truth PVE_BDS_*, surv-truth SURV_BDS_*, core-truth CORE_BDS_*, cache-truth CACHE_BDS_*, env.ts BOT_VERSION / BDS_TRANSPORT). The default suite (no profile) targets
// bds-dev, bds-world, bds-move and bds-dig at 1.26.60 over RakNet (docs/runbook.md, "Tests").
//   node scripts/e2e-profile.ts dev51 [vitest args...]   BDS 1.26.51.1 (bds-dev51, udp/19134), game version 1.26.51, RakNet:
//                                                        the previous version, kept as the rollback path
//   node scripts/e2e-profile.ts nn [vitest args...]      BDS 1.26.60.6 (bds-nn, 19140), NetherNet LAN signalling
// The container needs the truth pack: `node scripts/bds.mjs pack --profile <name>` from the repo root.
// Root shortcuts: pnpm e2e:51 | pnpm e2e:nn
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
  dev51: { container: 'bds-dev51', port: 19134, version: '1.26.51', transport: 'raknet', build: '1.26.51.1' },
  nn: { container: 'bds-nn', port: 19140, version: '1.26.60', transport: 'nethernet', build: '1.26.60.6' },
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
  MOVE_BDS_CONTAINER: p.container,
  MOVE_BDS_PORT: port,
  DIG_BDS_CONTAINER: p.container,
  DIG_BDS_PORT: port,
  WOOD_BDS_CONTAINER: p.container,
  WOOD_BDS_PORT: port,
  HARD_BDS_CONTAINER: p.container,
  HARD_BDS_PORT: port,
  RL_BDS_CONTAINER: p.container,
  RL_BDS_PORT: port,
  ACT_BDS_CONTAINER: p.container,
  ACT_BDS_PORT: port,
  PVE_BDS_CONTAINER: p.container,
  PVE_BDS_PORT: port,
  SURV_BDS_CONTAINER: p.container, // Track S
  SURV_BDS_PORT: port,
  CORE_BDS_CONTAINER: p.container, // Track Q: core-* (process manager, settings)
  CORE_BDS_PORT: port,
  CACHE_BDS_CONTAINER: p.container,
  CACHE_BDS_PORT: port,
  FARM_BDS_CONTAINER: p.container, // Track U: farm-*, mine-* (farm-truth.ts)
  FARM_BDS_PORT: port,
  FOOD_BDS_CONTAINER: p.container, // Track X: food-* (food-truth.ts)
  FOOD_BDS_PORT: port,
  ...{ REG_BDS_CONTAINER: p.container, REG_BDS_PORT: port }, // Track AC: world-registry
  GAUNT_BDS_CONTAINER: p.container, // Track W: gaunt-* (gaunt-truth.ts)
  GAUNT_BDS_PORT: port,
  GET_BDS_CONTAINER: p.container, // Track AD: get-* (get-truth.ts)
  GET_BDS_PORT: port,
  ...{ BUILD_BDS_CONTAINER: p.container, BUILD_BDS_PORT: port }, // Track AL: build-* (build-truth.ts)
};
console.error(`[e2e-profile] ${name}: ${p.container} (BDS ${p.build}) port ${port}, version ${p.version}, transport ${p.transport}`);
const botDir = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const r = spawnSync(process.execPath, [vitest, 'run', '--project', 'e2e', ...rest], { cwd: botDir, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
