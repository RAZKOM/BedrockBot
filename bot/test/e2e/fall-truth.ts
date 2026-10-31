// Track BI: helpers for the long-fall and clutch e2e tests (fall-*.test.ts) against bds-gaunt (udp/19188,
// flat world, truth pack; docker/compose.gaunt.yml) by default, or bds-surv (FALL_BDS_PORT=19182
// FALL_BDS_CONTAINER=bds-surv). The bot is the movement stack of move-truth.ts (Connection -> World ->
// InputLoop -> BotSkills with its FallGuard), in survival on difficulty normal without natural
// regeneration (health only changes by falls and truth:sethealth), in a private area at x, z < -24576.
//
// Env: FALL_BDS_HOST (127.0.0.1), FALL_BDS_PORT (19188), FALL_BDS_CONTAINER (bds-gaunt).
import { randomInt } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget } from './env.ts';
import { connectBot, dist, sleep, type MoveBot } from './move-truth.ts';
import { PveTruth, type HurtRecord } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const FALL_HOST = process.env.FALL_BDS_HOST ?? '127.0.0.1';
export const FALL_PORT = Number(process.env.FALL_BDS_PORT ?? 19188);
export const FALL_CONTAINER = process.env.FALL_BDS_CONTAINER ?? 'bds-gaunt';

export interface FallBot extends MoveBot {
  pve: PveTruth;
}

/** A private 256 x 256 cell west / north of -24576 (64 cells). */
export function fallArea(): { x: number; z: number } {
  const c = randomInt(64);
  return { x: -24576 - 256 * (c % 8) - 128, z: -24576 - 256 * Math.floor(c / 8) - 128 };
}

export async function connectFallBot(prefix: string, at: Vec3): Promise<FallBot> {
  const bot = await connectBot(prefix, { target: bdsTarget(FALL_HOST, FALL_PORT), container: FALL_CONTAINER });
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'naturalregeneration', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['time', 'set', 'noon'],
    ['gamemode', 'survival', bot.name],
  ])
    await consoleCommand(FALL_CONTAINER, ...c);
  const pve = new PveTruth(bot.conn, FALL_CONTAINER);
  await tpBot(bot, at);
  await bot.world.waitForChunks(3, { center: at, timeoutMs: 30_000 });
  return Object.assign(bot, { pve });
}

/** Teleport and wait until the loop adopted it and the body settled. */
export async function tpBot(bot: MoveBot, feet: Vec3, yaw = 0, settle = 20): Promise<void> {
  const seen = new Promise<void>((resolve) => {
    const off = bot.loop.onEvent((e) => {
      if (e.kind === 'teleport' && dist(e.to, feet) < 0.01) {
        off();
        resolve();
      }
    });
  });
  bot.loop.release();
  await bot.truth.tp(bot.name, feet, yaw, 0);
  await seen;
  bot.loop.setCommand({ yaw, pitch: 0 });
  await bot.loop.waitTicks(settle);
}

/** Fill, retrying while the chunks are not loaded yet. */
export async function fillAt(bot: MoveBot, a: Vec3, b: Vec3, block: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await bot.truth.cmd('fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 30_000);
    if (r.ok) return;
    if (r.reason !== 'unloaded_chunk' || attempt >= 20) throw new Error(`truth:fill failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(500);
  }
}

/** Set the health (truth:sethealth) and wait until the bot's world model has it. */
export async function setHealth(bot: FallBot, hp: number): Promise<void> {
  await bot.pve.setHealth(bot.name, hp);
  for (let i = 0; i < 40 && Math.abs(bot.world.self.health - hp) > 0.01; i++) await bot.loop.waitTicks(1);
}

/**
 * Health boost (amplifier 4: 40 max health) and full health: a failed clutch from 30 blocks (26 HP) must not
 * kill the bot in the middle of a suite (the cases after it would run on a dead body).
 */
export async function toughen(bot: FallBot, amplifier = 4): Promise<void> {
  await bot.pve.effect(bot.name, 'health_boost', 600, amplifier);
  await bot.loop.waitTicks(2);
  await setHealth(bot, 20 + 4 * (amplifier + 1));
}

/** Fall damage the server logged for the bot since `since` (truth tick). */
export async function fallHurts(bot: FallBot, since: number): Promise<{ total: number; events: HurtRecord[] }> {
  const log = await bot.pve.hurtlog(since, bot.name);
  const events = log.events.filter((e) => e.cause === 'fall');
  return { total: events.reduce((a, e) => a + e.damage, 0), events };
}

/** Water blocks (source or flowing) in a box, per truth:find. */
export async function waterIn(bot: MoveBot, a: Vec3, b: Vec3): Promise<number> {
  const r = await bot.truth.ok<{ count: number }>('find', [a.x, a.y, a.z, b.x, b.y, b.z, 'water'], 30_000);
  return r.count;
}

/** The summary lines: printed, and appended to FALL_OUT when set (the measurements in the docs). */
export function report(name: string, lines: string[]): void {
  const text = `[${name}]\n  ${lines.join('\n  ')}\n`;
  console.log(text);
  if (process.env.FALL_OUT) appendFileSync(process.env.FALL_OUT, text);
}

/** Empty the inventory and give `items` (hotbar first, in order). */
export async function kit(bot: MoveBot, items: [string, number][]): Promise<void> {
  await bot.truth.ok('clear', [bot.name]);
  for (const [name, n] of items) await bot.truth.ok('give', [bot.name, name, n]);
  for (let i = 0; i < 40; i++) {
    const have = items.every(([name]) => bot.world.inventory.slots.some((s) => s?.name === name));
    if (have) break;
    await bot.loop.waitTicks(1);
  }
}
