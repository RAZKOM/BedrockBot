// e2e (tag @bds), Track P3 (decision 0065, docs/storage.md): the storage view's wire on a real bot process
// against bds-home (flat, peaceful, truth pack). The CLI (`--walk`, the panel on a port in 9980..9989,
// `--owner` the observer, so panel commands run as that player and "to me" is that player; every file in a
// temporary directory, the event store too) and an observer connection that sends the truth commands:
//   A  4 east of home    5 diamonds and 32 cobblestone, loose
//   B  4 west of home    one shulker box holding 7 diamonds (truth:boxmix drops the box item onto a
//                        hopper over B, which moves it in; the hopper is removed before the bot reads B)
//   1. the bot reads both (`!chests scan` from the panel); GET /api/storage counts them;
//   2. search "diamonds" finds both places with the right counts, B flagged as in a shulker box; the
//      totals match; `me` is the observer;
//   3. a bot deposit (`!unload` of 64 cobblestone the truth gave it) arrives on the `storage` topic as a
//      delta and in "recently changed", and in the search's per-item history;
//   4. Bring 2 (the view's command, storedefs.ts bringCommand) sends `!bring diamond 2`: the bot takes 2
//      and walks to the observer; the withdrawal shows in the recent changes;
//   5. `!stock diamond` replies in its unchanged words.
// Env: PANEL_STORAGE_E2E_PORT (default a random port in 9980..9989) plus home-truth.ts (HOME_BDS_*).
// Needs BDS_E2E=1 and bds-home with the truth pack (`node scripts/bds.mjs --profile home up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { PANEL_BUDGETS } from '../../src/health/panel/budgets.ts';
import { applyDelta, type DeltaOp, type Json } from '../../src/health/panel/client/delta.ts';
import { bringCommand } from '../../src/health/panel/client/storedefs.ts';
import { STORAGE_TOPIC, type StorageSearchAnswer, type StorageSummary } from '../../src/health/panel/shared.ts';
import type { StorageOverview } from '../../src/health/panel/storage.ts';
import { openSse, type SseStream } from '../unit/health/panel-sse.ts';
import { waitOnline, type CoreCli } from './core-truth.ts';
import { E2E, FEET_Y, hdist, HOME_CONTAINER, HOME_HOST, HOME_PORT, HOME_TARGET, HomeTruth, prepareServer, privateArea, sleep, truthLoaded, uniqueName, until } from './home-truth.ts';
import { connectObserver, panelClient, panelPort, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const F = FEET_Y;
const panel = panelClient(panelPort(process.env.PANEL_STORAGE_E2E_PORT, 9980));
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const at = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

describe.skipIf(!E2E)('@bds panel storage (Track P3, bds-home)', () => {
  const area = privateArea();
  const H = { x: area.x, y: F, z: area.z };
  const A = { x: H.x + 4, y: F, z: H.z };
  const B = { x: H.x - 4, y: F, z: H.z };
  const OBS = { x: H.x, y: F, z: H.z + 9 };
  const measurements: string[] = [];
  let observer: Observer<HomeTruth> | undefined;
  let truth: HomeTruth | undefined;
  let run: PanelCli | undefined;
  let cli: CoreCli | undefined;
  let stream: SseStream | undefined;
  /** The storage topic as the page keeps it. */
  let have: StorageSummary | undefined;

  const clear = async (t: HomeTruth): Promise<void> => {
    await truthLoaded(t, 'fill', [H.x - 12, F - 3, H.z - 12, H.x + 12, F - 2, H.z + 12, 'stone']);
    await truthLoaded(t, 'fill', [H.x - 12, F - 1, H.z - 12, H.x + 12, F - 1, H.z + 12, 'grass_block']);
    await truthLoaded(t, 'fill', [H.x - 12, F, H.z - 12, H.x + 12, F + 6, H.z + 12, 'air']);
  };
  const search = (q: string): Promise<StorageSearchAnswer> => panel.get<StorageSearchAnswer>(`/api/storage/search?q=${encodeURIComponent(q)}`);
  /** Follow the storage topic until `done` holds; returns the bytes of each message taken. */
  async function follow(done: (s: StorageSummary) => boolean, ms: number): Promise<number[]> {
    const took: number[] = [];
    const deadline = Date.now() + ms;
    while (!have || !done(have)) {
      const m = await stream!.next(STORAGE_TOPIC, Math.max(1, deadline - Date.now()));
      took.push(m.bytes);
      const p = JSON.parse(m.data) as { snap?: StorageSummary; d?: DeltaOp[] };
      have = p.snap ?? (applyDelta(have as unknown as Json, p.d!) as unknown as StorageSummary);
    }
    return took;
  }

  beforeAll(async () => {
    await prepareServer();
    observer = await connectObserver(uniqueName('StoreObs'), HOME_TARGET, HOME_CONTAINER, (c, k) => new HomeTruth(c, k));
    truth = observer.truth;
    const t = truth;
    await t.tp(observer.name, centre({ x: H.x, y: F + 20, z: H.z }), 0, 0); // loads the chunks
    await clear(t);
    await t.tp(observer.name, centre(OBS), 180, 0);
    // A: loose diamonds and cobblestone
    await truthLoaded(t, 'set', [A.x, A.y, A.z, 'chest']);
    await t.chestPut(A, 'diamond', 5);
    await t.chestPut(A, 'cobblestone', 32);
    // B: a shulker box of diamonds, moved in by a hopper (the Script API cannot write a box item into a chest)
    await truthLoaded(t, 'set', [B.x, B.y, B.z, 'chest']);
    await truthLoaded(t, 'set', [B.x, B.y + 1, B.z, 'hopper']);
    // a glass shaft over the hopper: the destroyed box's item pops out sideways otherwise
    await truthLoaded(t, 'fill', [B.x - 1, B.y + 2, B.z - 1, B.x + 1, B.y + 5, B.z + 1, 'glass']);
    await truthLoaded(t, 'fill', [B.x, B.y + 2, B.z, B.x, B.y + 5, B.z, 'air']);
    await truthLoaded(t, 'boxmix', [B.x, B.y + 4, B.z, 'diamond', 7, 1]);
    await until(async () => ((await t.box(B)).counts.undyed_shulker_box === 1 ? true : undefined), 20_000, 'the box in B', 250);
    await truthLoaded(t, 'fill', [B.x - 1, B.y + 1, B.z - 1, B.x + 1, B.y + 5, B.z + 1, 'air']);
    await t.clearAround(centre(B), 6);
    // the bot: panel commands run as the observer (--owner)
    run = startPanelCli(panel, { prefix: 'bot-e2e-panel-storage-', args: ['--walk', '--owner', observer.name], name: uniqueName('StoreBot'), target: { host: HOME_HOST, port: HOME_PORT }, events: true, config: { settings: { autoUnload: false } } });
    cli = run.cli;
    await waitOnline(t, cli.name);
    await t.ok('clear', [cli.name]);
    await t.tp(cli.name, centre(H), 0, 0);
    await panel.healthy();
  }, 180_000);

  afterAll(async () => {
    stream?.close();
    await quitPanelCli(panel, cli);
    if (truth) {
      for (const p of [A, B]) await truthLoaded(truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
      await clear(truth).catch(() => undefined);
      await truth.clearAround(centre(H), 30).catch(() => undefined);
    }
    await observer?.close().catch(() => undefined);
    run?.cleanup();
    console.log(`panel storage e2e (port ${panel.port}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('the bot reads both chests; GET /api/storage counts them; search "diamonds" finds both places, the box flagged', async () => {
    expect((await panel.cmd(`!home set ${at(H)}`)).status).toBe(200);
    const t0 = Date.now();
    const scan = await panel.cmd('!chests scan');
    expect(scan.status).toBe(200);
    const o = await until(async () => {
      const v = await panel.get<StorageOverview>('/api/storage');
      return v.containers.read >= 2 && (v.categories.find((c) => c.id === 'ores')?.items.find(([n]) => n === 'diamond')?.[1] ?? 0) === 12 ? v : undefined;
    }, 120_000, 'both chests read', 1000);
    measurements.push(`scan to both read: ${Date.now() - t0} ms; GET /api/storage ${Buffer.byteLength(JSON.stringify(o))} bytes`);
    expect(o.me).toBe(observer!.name);
    expect(o.containers).toMatchObject({ known: 2, read: 2, never: 0 });
    expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThan(PANEL_BUDGETS.storageFetch);

    const s = await search('diamonds');
    const bytes = Buffer.byteLength(JSON.stringify(s));
    measurements.push(`search "diamonds": ${bytes} bytes; ${JSON.stringify(s.results[0]?.where.map((p) => [p.x, p.count, p.boxed]))}`);
    expect(bytes).toBeLessThan(PANEL_BUDGETS.storageSearch);
    const d = s.results[0]!;
    expect(d).toMatchObject({ name: 'diamond', total: 12, loose: 5, boxed: 7, carried: 0 });
    expect(d.where.map((p) => [p.x, p.y, p.z, p.count, p.loose, p.boxed])).toEqual([
      [B.x, B.y, B.z, 7, 0, 7],
      [A.x, A.y, A.z, 5, 5, 0],
    ]);
    expect(d.where[0]!.distHome).toBeCloseTo(4, 0);
    // the totals match: the summary, the overview's categories, the search
    expect(o.totals.items).toBe(12 + 32 + 1); // diamonds, cobblestone, the box itself
    const box = await panel.get<{ inBoxes: [string, number][]; boxes: { full: number } }>(`/api/storage/container?x=${B.x}&y=${B.y}&z=${B.z}&dim=0`);
    expect(box).toMatchObject({ inBoxes: [['diamond', 7]], boxes: { full: 1 } });
  }, 180_000);

  it('a bot deposit arrives on the storage topic and in "recently changed"', async () => {
    stream = await openSse(`${panel.base}/api/stream?topics=${STORAGE_TOPIC}`, panel.auth);
    const first = await stream.next(STORAGE_TOPIC);
    have = (JSON.parse(first.data) as { snap: StorageSummary }).snap;
    measurements.push(`storage snapshot: ${first.bytes} bytes`);
    expect(first.bytes).toBeLessThan(PANEL_BUDGETS.storage);
    await truth!.ok('give', [cli!.name, 'cobblestone', 64]);
    await until(async () => ((await panel.state()).inventory?.slots.some((x) => x?.name === 'cobblestone') ? true : undefined), 15_000, 'the cobblestone carried', 250);
    const t0 = Date.now();
    const u = await panel.cmd('!unload');
    expect(u.status).toBe(200);
    measurements.push(`!unload: ${JSON.stringify(u.body.replies)}`);
    // the unloader keeps a few cobblestone (the building reserve) and puts the rest into A, where cobblestone is
    const took = await follow((v) => v.recent.some((r) => r.kind === 'deposit' && r.items.some(([n]) => n === 'cobblestone')), 60_000);
    measurements.push(`!unload to the deposit on the stream: ${Date.now() - t0} ms; ${took.length} deltas, ${JSON.stringify(took)} bytes`);
    for (const b of took) expect(b).toBeLessThan(PANEL_BUDGETS.storageDelta);
    const dep = have.recent.find((r) => r.kind === 'deposit')!;
    expect(dep.at).toEqual([A.x, A.y, A.z]);
    const put = dep.items.find(([n]) => n === 'cobblestone')![1];
    expect(put).toBeGreaterThan(0);
    const s = await search('cobblestone');
    expect(s.results[0]).toMatchObject({ name: 'cobblestone', total: 96, loose: 32 + put, carried: 64 - put }); // nothing lost on the way
    expect(s.recent.cobblestone?.[0]).toMatchObject({ kind: 'deposit', n: put });
    const o = await panel.get<StorageOverview>('/api/storage');
    expect(o.recent[0]).toMatchObject({ kind: 'deposit', at: [A.x, A.y, A.z] });
  }, 120_000);

  it('Bring 2 from the view sends `!bring diamond 2` and the bot brings them to the observer', async () => {
    const c = bringCommand('diamond', 2, false);
    expect(c).toBe('!bring diamond 2');
    const t0 = Date.now();
    const r = await panel.cmd(c);
    expect(r.status).toBe(200);
    measurements.push(`${c}: ${JSON.stringify(r.body.replies)}`);
    await until(async () => {
      const inv = (await truth!.ok<{ counts: Record<string, number> }>('inv', [cli!.name])).counts;
      const n = inv.diamond ?? inv['minecraft:diamond'] ?? 0;
      if (n < 2) return undefined;
      const p = (await truth!.pos(cli!.name)).location;
      return hdist(p, centre(OBS)) <= 3 ? true : undefined;
    }, 90_000, 'the bot at the observer with 2 diamonds', 500);
    measurements.push(`bring 2 diamonds to the observer: ${Date.now() - t0} ms`);
    await follow((v) => v.recent.some((x) => x.kind === 'withdraw' && x.items.some(([n]) => n === 'diamond')), 30_000);
    const s = await search('diamond');
    expect(s.results[0]!.carried).toBe(2);
    expect(s.results[0]!.total).toBe(12); // 10 stored, 2 carried
  }, 120_000);

  it('!stock replies in its unchanged words', async () => {
    await sleep(300);
    const r = await panel.cmd('!stock diamond');
    measurements.push(`!stock diamond: ${JSON.stringify(r.body.replies)}`);
    // A gave the 2 (loose first, nearest): 7 in B (all in boxes), 3 in A
    expect(r.body.replies[0]).toBe(`diamond: 7 in chest ${at(B)} (all in boxes), 3 in chest ${at(A)} (10 in all)`);
  }, 30_000);
});
