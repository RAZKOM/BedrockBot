// Update notifier (PLAN.md task 5.3, section 7 "Detecting a breaking update"): compares the pinned
// stack with what upstream publishes and reports anything newer. It only reads public JSON over
// HTTPS (no game server, no sign-in) and never changes a pin; the version-bump playbook
// (tools/bump-version/playbook.md) is the human/agent follow-up.
//
// Sources (the same ones the playbook's step 0 uses):
//   - npm registry  https://registry.npmjs.org/<pkg>/latest      (= `npm view <pkg> version`)
//   - minecraft-data master  data/bedrock/common/protocolVersions.json (newest game version with
//     protocol data, i.e. what a bump could use today)
//   - BDS links API  https://net-secondary.web.minecraft-services.net/api/v1.0/download/links
//     (newest BDS release and preview builds)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_BDS_BUILD, DEFAULT_VERSION } from '../config/defaults.ts';

export const SOURCES = {
  npm: (pkg: string) => `https://registry.npmjs.org/${pkg}/latest`,
  protocolVersions: 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/bedrock/common/protocolVersions.json',
  bdsLinks: 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links',
} as const;

/** Compare dotted versions numerically (1.26.60 < 1.26.60.6 < 1.26.100). Non-numeric parts sort as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const NpmLatest = z.object({ name: z.string(), version: z.string() });
export function parseNpmLatest(json: unknown): { name: string; version: string } {
  const r = NpmLatest.parse(json);
  return { name: r.name, version: r.version };
}

const ProtocolVersions = z.array(z.object({ version: z.number(), minecraftVersion: z.string(), releaseType: z.string().optional() }).loose());
export interface GameVersionInfo {
  /** Newest release game version that has protocol data on minecraft-data master. */
  release: { version: string; protocol: number } | null;
  /** Newest non-release (beta/preview) entry, if any. */
  preview: { version: string; protocol: number } | null;
}
export function parseProtocolVersions(json: unknown): GameVersionInfo {
  const list = ProtocolVersions.parse(json);
  const newest = (filter: (e: (typeof list)[number]) => boolean) => {
    const sorted = list.filter(filter).sort((a, b) => cmpVersion(b.minecraftVersion, a.minecraftVersion) || b.version - a.version);
    const e = sorted[0];
    return e ? { version: e.minecraftVersion, protocol: e.version } : null;
  };
  return { release: newest((e) => (e.releaseType ?? 'release') === 'release'), preview: newest((e) => e.releaseType !== undefined && e.releaseType !== 'release') };
}

const BdsLinks = z.object({ result: z.object({ links: z.array(z.object({ downloadType: z.string(), downloadUrl: z.string() })) }) });
export interface BdsBuilds {
  release: string | null;
  preview: string | null;
}
export function parseBdsLinks(json: unknown): BdsBuilds {
  const r = BdsLinks.parse(json);
  const build = (type: string) => {
    const l = r.result.links.find((x) => x.downloadType === type);
    const m = l ? /bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip$/.exec(l.downloadUrl) : null;
    return m?.[1] ?? null;
  };
  return { release: build('serverBedrockLinux'), preview: build('serverBedrockPreviewLinux') };
}

export interface Pins {
  /** Game version the bot speaks by default (1.26.60). */
  gameVersion: string;
  /** BDS build of the dev servers (docker/compose.dev.yml), e.g. 1.26.60.6. */
  bds: string;
  /** Installed bedrock-protocol package version (the git pin reports the version in its package.json). */
  bedrockProtocol: string;
  /** Installed minecraft-data version. */
  minecraftData: string;
}

export interface Finding {
  what: 'game_version' | 'bds_release' | 'bedrock_protocol' | 'minecraft_data' | 'bds_preview' | 'game_preview';
  pinned: string;
  latest: string | null;
  newer: boolean;
  /** Informational only (previews never trigger a notification). */
  info?: boolean;
  error?: string;
}

export interface UpdateReport {
  checkedAt: string;
  pins: Pins;
  findings: Finding[];
  /** Findings with newer: true and not info. */
  newer: Finding[];
  errors: string[];
}

export interface SourceData {
  bedrockProtocol?: unknown;
  minecraftData?: unknown;
  protocolVersions?: unknown;
  bdsLinks?: unknown;
  errors?: Partial<Record<'bedrockProtocol' | 'minecraftData' | 'protocolVersions' | 'bdsLinks', string>>;
}

/** Pure: compare pins with fetched (or fixture) JSON. */
export function evaluate(pins: Pins, data: SourceData, now: Date = new Date()): UpdateReport {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const guard = <T>(key: keyof NonNullable<SourceData['errors']>, raw: unknown, parse: (j: unknown) => T): T | undefined => {
    const fetchErr = data.errors?.[key];
    if (fetchErr) {
      errors.push(`${key}: ${fetchErr}`);
      return undefined;
    }
    if (raw === undefined) return undefined;
    try {
      return parse(raw);
    } catch (e) {
      const why =
        e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e);
      errors.push(`${key}: unexpected JSON (${why})`);
      return undefined;
    }
  };
  const add = (what: Finding['what'], pinned: string, latest: string | null | undefined, info = false, key?: keyof NonNullable<SourceData['errors']>) => {
    const f: Finding = { what, pinned, latest: latest ?? null, newer: latest ? cmpVersion(latest, pinned) > 0 : false };
    if (info) f.info = true;
    if (latest === undefined && key && data.errors?.[key]) f.error = data.errors[key];
    findings.push(f);
  };
  const gv = guard('protocolVersions', data.protocolVersions, parseProtocolVersions);
  add('game_version', pins.gameVersion, gv ? (gv.release?.version ?? null) : undefined, false, 'protocolVersions');
  const bds = guard('bdsLinks', data.bdsLinks, parseBdsLinks);
  add('bds_release', pins.bds, bds ? bds.release : undefined, false, 'bdsLinks');
  const bp = guard('bedrockProtocol', data.bedrockProtocol, parseNpmLatest);
  add('bedrock_protocol', pins.bedrockProtocol, bp?.version, false, 'bedrockProtocol');
  const md = guard('minecraftData', data.minecraftData, parseNpmLatest);
  add('minecraft_data', pins.minecraftData, md?.version, false, 'minecraftData');
  if (bds?.preview) add('bds_preview', pins.bds, bds.preview, true);
  if (gv?.preview) add('game_preview', pins.gameVersion, gv.preview.version, true);
  return { checkedAt: now.toISOString(), pins, findings, newer: findings.filter((f) => f.newer && !f.info), errors };
}

/** One line per finding, for logs and chat. */
export function formatReport(r: UpdateReport): string[] {
  const label: Record<Finding['what'], string> = {
    game_version: 'game version (minecraft-data master)',
    bds_release: 'BDS release (links API)',
    bedrock_protocol: 'bedrock-protocol (npm)',
    minecraft_data: 'minecraft-data (npm)',
    bds_preview: 'BDS preview (info)',
    game_preview: 'game preview (info)',
  };
  const lines = r.findings.map((f) => `${f.newer && !f.info ? 'NEWER ' : f.latest === null ? 'ERROR ' : f.info ? 'info  ' : 'ok    '}${label[f.what]}: pinned ${f.pinned}, latest ${f.latest ?? `? (${f.error ?? 'no data'})`}`);
  for (const e of r.errors) lines.push(`error ${e}`);
  lines.push(r.newer.length ? `update available: ${r.newer.map((f) => `${f.what} ${f.pinned} -> ${f.latest}`).join(', ')}; see tools/bump-version/playbook.md` : 'no newer release than the pins');
  return lines;
}

/** Short one-liner for a chat whisper (BDS chat is limited; keep it under 200 characters). */
export function chatSummary(r: UpdateReport): string | undefined {
  if (!r.newer.length) return undefined;
  return `update available: ${r.newer.map((f) => `${f.what.replace('_', ' ')} ${f.latest}`).join(', ')} (pinned ${r.pins.gameVersion} / BDS ${r.pins.bds})`.slice(0, 200);
}

export type FetchJson = (url: string) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'bedrockbot-update-check' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
};

export async function fetchSources(fetchJson: FetchJson = defaultFetchJson): Promise<SourceData> {
  const errors: NonNullable<SourceData['errors']> = {};
  const out: SourceData = { errors };
  const jobs: [keyof NonNullable<SourceData['errors']>, string][] = [
    ['bedrockProtocol', SOURCES.npm('bedrock-protocol')],
    ['minecraftData', SOURCES.npm('minecraft-data')],
    ['protocolVersions', SOURCES.protocolVersions],
    ['bdsLinks', SOURCES.bdsLinks],
  ];
  await Promise.all(
    jobs.map(async ([key, url]) => {
      try {
        out[key] = await fetchJson(url);
      } catch (e) {
        errors[key] = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  return out;
}

const require = createRequire(import.meta.url);

function installedVersion(pkg: string): string {
  try {
    const p = require.resolve(`${pkg}/package.json`);
    return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** BDS build pinned in docker/compose.dev.yml (VERSION: "x.y.z.w"), else the built-in default. */
export function pinnedBdsBuild(composeFile = fileURLToPath(new URL('../../../docker/compose.dev.yml', import.meta.url))): string {
  try {
    const m = /^\s*VERSION:\s*"?(\d+\.\d+\.\d+\.\d+)"?/m.exec(readFileSync(composeFile, 'utf8'));
    return m?.[1] ?? DEFAULT_BDS_BUILD;
  } catch {
    return DEFAULT_BDS_BUILD;
  }
}

export function currentPins(gameVersion: string = DEFAULT_VERSION): Pins {
  return { gameVersion, bds: pinnedBdsBuild(), bedrockProtocol: installedVersion('bedrock-protocol'), minecraftData: installedVersion('minecraft-data') };
}

export async function runUpdateCheck(opts: { pins?: Pins; fetchJson?: FetchJson; now?: Date } = {}): Promise<UpdateReport> {
  const data = await fetchSources(opts.fetchJson);
  return evaluate(opts.pins ?? currentPins(), data, opts.now);
}
