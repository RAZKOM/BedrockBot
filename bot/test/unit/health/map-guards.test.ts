// Decision 0062 guards (docs/map.md "Reviewer checklist"): every map action's command is a registered
// chat command (from the action registry's metadata, against the real afk registry), every action,
// overlay and layer is documented in docs/map.md, every overlay is drawn by overlays.ts, and the action
// commands the sheet shows are plain chat commands within the chat limit.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAP_ACTIONS, MAP_LAYERS, MAP_OVERLAYS, boxActions, pointActions } from '../../../src/health/panel/client/mapdefs.ts';
import { afkChat } from '../chat/afk-chat.ts';

const DOC = readFileSync(new URL('../../../../docs/map.md', import.meta.url), 'utf8');
const OVERLAYS_SRC = readFileSync(new URL('../../../src/health/panel/client/overlays.ts', import.meta.url), 'utf8');
/** The rows of the markdown table under `## <heading>` whose first cell is a backticked id. */
function tableIds(heading: string): string[] {
  const at = DOC.indexOf(`\n## ${heading}`);
  expect(at, `docs/map.md has "## ${heading}"`).toBeGreaterThan(0);
  const next = DOC.indexOf('\n## ', at + 4);
  const part = DOC.slice(at, next < 0 ? undefined : next);
  return [...part.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!);
}

describe('map actions (mapdefs.ts MAP_ACTIONS)', () => {
  const { chat } = afkChat();
  const infos = new Map(chat.commandInfo().map((c) => [c.name, c]));

  it('every action runs a registered command; a subcommand is in that command\'s help', () => {
    for (const a of MAP_ACTIONS) {
      const [name, sub] = a.command.split(' ');
      const info = infos.get(name!);
      expect(info, `!${name} (map action ${a.id}) is registered`).toBeDefined();
      if (sub) expect(info!.help, `!${name} help names "${sub}" (map action ${a.id})`).toMatch(new RegExp(`\\b${sub}\\b`));
    }
  });

  it('the commands it builds start with their registered command and fit one chat message', () => {
    const ctx = { x: -12345, z: 23456, y: 63, block: 'deepslate_redstone_ore', bot: { x: -12340.5, y: 64, z: 23456.5 }, elytra: true };
    const box = { x1: -12345, z1: 23456, x2: -12300, z2: 23500, y1: -60, y2: 300 };
    const built = [...pointActions(ctx), ...boxActions(box, { block: 'polished_blackstone_bricks' })];
    expect(built.map((a) => a.id).sort()).toEqual(MAP_ACTIONS.map((a) => a.id).sort()); // every action applies somewhere
    for (const b of built) {
      const def = MAP_ACTIONS.find((a) => a.id === b.id)!;
      expect(b.cmd!.startsWith(`!${def.command} `), `${b.id}: ${b.cmd}`).toBe(true);
      expect(Buffer.byteLength(b.cmd!.replace('{name}', 'x'.repeat(32)))).toBeLessThan(256);
    }
  });

  it('every action, overlay and layer is in docs/map.md (one table row each, no stale rows)', () => {
    expect(tableIds('Actions').sort()).toEqual(MAP_ACTIONS.map((a) => a.id).sort());
    expect(tableIds('Overlays').sort()).toEqual(MAP_OVERLAYS.map((o) => o.id).sort());
    expect(tableIds('Layers').sort()).toEqual(MAP_LAYERS.map((l) => l.id).sort());
    for (const a of MAP_ACTIONS) expect(DOC, `docs/map.md names !${a.command}`).toContain(`!${a.command}`);
  });

  it('every overlay is drawn: overlays.ts asks for its switch (entity kinds through entityOverlay)', () => {
    for (const o of MAP_OVERLAYS) {
      const asked = OVERLAYS_SRC.includes(`on('${o.id}')`) || ['players', 'hostiles', 'passive', 'items'].includes(o.id);
      expect(asked, `overlays.ts draws ${o.id}`).toBe(true);
    }
    expect(new Set(MAP_OVERLAYS.map((o) => o.id)).size).toBe(MAP_OVERLAYS.length);
    expect(new Set(MAP_ACTIONS.map((o) => o.id)).size).toBe(MAP_ACTIONS.length);
  });
});
