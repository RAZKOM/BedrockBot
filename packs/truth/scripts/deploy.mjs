// Deploys the truth pack into a BDS data directory (the itzg image's /data volume).
//
//   node scripts/deploy.mjs [--data <dir>] [--world <levelName>] [--restart <container>] [--no-build]
//
// 1. builds dist/ (unless --no-build)
// 2. copies dist/ to <data>/behavior_packs/truth/ (replacing what was there)
// 3. adds the pack to <data>/worlds/<level>/world_behavior_packs.json (other entries are kept)
// 4. sets content-log-console-output-enabled=true in <data>/server.properties so script errors
//    show up in `docker logs`
// 5. with --restart, runs `docker restart <container>` (the pack loads on server start)
//
// Defaults: --data is packs/truth/.bds; --world is level-name from server.properties.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPack } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readProps(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function getProp(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text ?? '');
  return m ? m[1].trim() : undefined;
}

function setProp(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return text.replace(/\n?$/, `\n${key}=${value}\n`);
}

export async function deploy({ data, world, restart, build = true }) {
  const dataDir = resolve(data);
  if (!existsSync(dataDir)) throw new Error(`data dir ${dataDir} does not exist (start the server once first)`);
  const dist = join(root, 'dist');
  if (build) await buildPack();
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ is missing; run the build first');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  const { uuid, version } = manifest.header;

  const packDir = join(dataDir, 'behavior_packs', 'truth');
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  cpSync(dist, packDir, { recursive: true });

  const propsFile = join(dataDir, 'server.properties');
  let props = readProps(propsFile);
  const level = world ?? getProp(props, 'level-name') ?? 'Bedrock level';
  const worldDir = join(dataDir, 'worlds', level);
  mkdirSync(worldDir, { recursive: true });
  const wbpFile = join(worldDir, 'world_behavior_packs.json');
  let entries = [];
  if (existsSync(wbpFile)) {
    try {
      entries = JSON.parse(readFileSync(wbpFile, 'utf8'));
    } catch {
      entries = [];
    }
  }
  entries = entries.filter((e) => e.pack_id !== uuid);
  entries.push({ pack_id: uuid, version });
  writeFileSync(wbpFile, JSON.stringify(entries, null, 2) + '\n');

  if (props !== null) {
    props = setProp(props, 'content-log-console-output-enabled', 'true');
    writeFileSync(propsFile, props);
  }

  if (restart) execFileSync('docker', ['restart', restart], { stdio: 'inherit' });
  return { packDir, wbpFile, uuid, version, level };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      data: { type: 'string', default: join(root, '.bds') },
      world: { type: 'string' },
      restart: { type: 'string' },
      'no-build': { type: 'boolean', default: false },
    },
  });
  const r = await deploy({ data: values.data, world: values.world, restart: values.restart, build: !values['no-build'] });
  console.log(`deployed truth pack ${r.uuid} v${r.version.join('.')} -> ${r.packDir}`);
  console.log(`registered in ${r.wbpFile} (level "${r.level}")${values.restart ? `; restarted ${values.restart}` : ''}`);
}
