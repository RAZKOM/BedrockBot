// The storage view's actions (decision 0065, docs/storage.md "Actions"), as data. Pure: the view and the
// Bring picker build their buttons and commands from these, and the guard tests check them (every command
// is a registered chat command, every action has its row in docs/storage.md). Every action that changes
// anything is one chat command sent through POST /api/cmd like every panel action; the page shows the
// exact command before Send. No DOM, no Node API.

export interface StorageActionDef {
  id: string;
  label: string;
  /** The chat command's words (`bring`, `chests scan`); empty for a local action (no command). */
  command: string;
  /** docs/storage.md "Actions" says the same. */
  doc: string;
}

export const STORAGE_ACTIONS: readonly StorageActionDef[] = [
  { id: 'bring', label: 'Bring', command: 'bring', doc: 'the bot takes n of the item out of the chests (its planner picks them: nearest first, loose before boxes) and brings it to the player the panel runs as' },
  { id: 'bring-home', label: 'Bring home', command: 'bring', doc: 'the same, but the bot carries it to the home point' },
  { id: 'scan', label: 'Read them now', command: 'chests scan', doc: 'walks to every container within homeChestRadius of home not read in the last 10 minutes (the never-opened and stale ones included) and looks inside' },
  { id: 'map', label: 'Show on map', command: '', doc: 'local: switches to the map, centres it on the container and highlights it' },
];

/** `!bring` takes 1..2304 (bring.ts parseBringArgs). */
export const BRING_MAX = 2304;

/** The `!bring` command: `!bring diamond 2`, `!bring diamond 2 home`. */
export function bringCommand(name: string, n: number, home: boolean): string {
  const k = Math.max(1, Math.min(BRING_MAX, Math.floor(n)));
  return `!bring ${name} ${k}${home ? ' home' : ''}`;
}

export const SCAN_COMMAND = '!chests scan';

/** The quick picks: 1, 16, 64, a stack (when the stack size is not one of those), all (up to 2304). */
export function bringPicks(total: number, stack: number | null): { label: string; n: number }[] {
  const out: { label: string; n: number }[] = [];
  const add = (label: string, n: number): void => {
    if (n >= 1 && !out.some((p) => p.n === n)) out.push({ label, n });
  };
  for (const n of [1, 16, 64]) if (n <= Math.max(1, total)) add(String(n), n);
  if (stack && stack <= total) add(`a stack (${stack})`, stack);
  if (total > 0) add(`all (${Math.min(total, BRING_MAX)})`, Math.min(total, BRING_MAX));
  return out;
}

/** Where "to me" goes (docs/home.md "The delivery"): the player panel commands run as, else home. */
export function bringTarget(me: string | null): { me: string; note: string } {
  return me
    ? { me: `to ${me}`, note: `to ${me} when online, else home; !bring takes from the chests its planner picks (nearest first, loose stacks before boxes), not from a chosen chest` }
    : { me: 'to me (home)', note: 'the panel runs as the console, which has no position: the items go home; !bring takes from the chests its planner picks, not from a chosen chest' };
}

/** docs/storage.md "Actions", generated (the guard test compares it with the doc). */
export function storageActionTable(): string {
  const rows = STORAGE_ACTIONS.map((a) => `| \`${a.id}\` | ${a.label} | ${a.command ? `\`!${a.command}\`` : 'none (local)'} | ${a.doc} |`);
  return ['| action | button | command | what it does |', '|---|---|---|---|', ...rows].join('\n');
}
