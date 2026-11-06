// Decision 0065 guards (docs/storage.md "Reviewer checklist"): every storage action's command is a
// registered chat command (against the real afk registry) and the commands the view builds parse as
// `!bring` arguments; docs/storage.md carries the generated groups, aliases and actions tables; every
// group and alias resolves to real items of the item registry; the alias words do not shadow a group.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bringCommand, SCAN_COMMAND, STORAGE_ACTIONS, storageActionTable } from '../../../src/health/panel/client/storedefs.ts';
import { parseBringArgs } from '../../../src/skills/home/bring.ts';
import { aliasTable, groupMembers, groupTable, itemRegistry, STORAGE_ALIASES, STORAGE_GROUPS } from '../../../src/skills/home/search.ts';
import { afkChat } from '../chat/afk-chat.ts';

const DOC = readFileSync(new URL('../../../../docs/storage.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The text between `<!-- storage:<name> -->` and `<!-- /storage:<name> -->`. */
function block(name: string, want: string): string {
  const m = new RegExp(`<!-- storage:${name} -->\\n([\\s\\S]*?)\\n<!-- /storage:${name} -->`).exec(DOC);
  expect(m, `docs/storage.md needs the <!-- storage:${name} --> markers`).not.toBeNull();
  if (m![1] !== want) console.log(`paste this between the storage:${name} markers of docs/storage.md:\n${want}`);
  return m![1]!;
}

describe('storage actions (storedefs.ts STORAGE_ACTIONS)', () => {
  const { chat } = afkChat();
  const infos = new Map(chat.commandInfo().map((c) => [c.name, c]));

  it('every action with a command runs a registered command; a subcommand is in its help', () => {
    for (const a of STORAGE_ACTIONS) {
      if (!a.command) continue;
      const [name, sub] = a.command.split(' ');
      const info = infos.get(name!);
      expect(info, `!${name} (storage action ${a.id}) is registered`).toBeDefined();
      if (sub) expect(info!.help, `!${name} help names "${sub}"`).toMatch(new RegExp(`\\b${sub}\\b`));
    }
    expect(new Set(STORAGE_ACTIONS.map((a) => a.id)).size).toBe(STORAGE_ACTIONS.length);
    expect(SCAN_COMMAND).toBe(`!${STORAGE_ACTIONS.find((a) => a.id === 'scan')!.command}`);
  });

  it('the Bring commands parse as !bring arguments (to the sender, or home) and fit a chat message', () => {
    for (const name of ['diamond', 'oak_log', 'undyed_shulker_box', 'netherite_upgrade_smithing_template']) {
      for (const home of [false, true]) {
        const c = bringCommand(name, 2304, home);
        expect(Buffer.byteLength(c)).toBeLessThan(256);
        const p = parseBringArgs(c.split(' ').slice(1));
        expect(p).toEqual({ name, count: 2304, to: home ? 'home' : undefined });
      }
    }
  });

  it('docs/storage.md carries the generated actions table and names every command', () => {
    expect(block('actions', storageActionTable())).toBe(storageActionTable());
    for (const a of STORAGE_ACTIONS) if (a.command) expect(DOC).toContain(`!${a.command}`);
  });
});

describe('storage search groups and aliases (search.ts)', () => {
  it('docs/storage.md carries the generated groups and aliases tables', () => {
    expect(block('groups', groupTable())).toBe(groupTable());
    expect(block('aliases', aliasTable())).toBe(aliasTable());
  });

  it('every group matches real items; every alias names real items; words are unique', () => {
    expect(itemRegistry().size).toBeGreaterThan(1000);
    for (const g of STORAGE_GROUPS) expect([g.id, groupMembers(g).length > 0]).toEqual([g.id, true]);
    for (const [w, names] of Object.entries(STORAGE_ALIASES)) {
      expect(names.length, `alias ${w}`).toBeGreaterThan(0);
      for (const n of names) expect([w, n, itemRegistry().has(n)]).toEqual([w, n, true]);
    }
    const words = STORAGE_GROUPS.flatMap((g) => g.words);
    expect(new Set(words).size).toBe(words.length);
    for (const w of Object.keys(STORAGE_ALIASES)) expect(words, `alias ${w} is also a group word`).not.toContain(w);
    expect(new Set(STORAGE_GROUPS.map((g) => g.id)).size).toBe(STORAGE_GROUPS.length);
  });

  it('the brief\'s common words each find something: a group or an alias or an item', () => {
    const groupWords = new Set(STORAGE_GROUPS.flatMap((g) => g.words));
    for (const w of ['diamonds', 'iron', 'logs', 'wood', 'ores', 'food', 'tools', 'armour', 'shulker']) {
      const known = groupWords.has(w) || w in STORAGE_ALIASES || itemRegistry().has(w.replace(/s$/, ''));
      expect([w, known]).toEqual([w, true]);
    }
  });
});
