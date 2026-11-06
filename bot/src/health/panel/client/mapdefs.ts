// The map screen's registries (decision 0062, docs/map.md): the overlays, the layers and the actions
// (block and box), as data. Pure: the page builds its toggles and sheets from these, the server renders
// the overlay switches from them, and the guard tests check them (every action's command is a
// registered chat command, every overlay and action is in docs/map.md). Every action is one chat
// command sent through POST /api/cmd like every panel action; the page shows the exact command (and a
// box's size) before it is sent. No DOM, no Node API.
import type { MenuAction } from './menu.ts';

// ---- overlays ------------------------------------------------------------------------------------------

export interface OverlayDef {
  id: string;
  label: string;
  /** The marker colour (also the legend swatch). */
  colour: string;
  /** Shown before the owner changed anything. */
  on: boolean;
  /** Where the data comes from (docs/map.md "Overlays" lists it). */
  source: 'map-live' | 'marks';
}

export const MAP_OVERLAYS: readonly OverlayDef[] = [
  { id: 'bot', label: 'bot and heading', colour: '#ffffff', on: true, source: 'map-live' },
  { id: 'trail', label: 'trail', colour: '#d0d4da', on: true, source: 'map-live' },
  { id: 'path', label: 'path and goal', colour: '#f5c542', on: true, source: 'map-live' },
  { id: 'waypoints', label: 'waypoints', colour: '#5cd6ff', on: true, source: 'map-live' },
  { id: 'home', label: 'home and shelter', colour: '#4ce08a', on: true, source: 'map-live' },
  { id: 'players', label: 'players', colour: '#e8e8e8', on: true, source: 'map-live' },
  { id: 'hostiles', label: 'hostile mobs', colour: '#ff5050', on: true, source: 'map-live' },
  { id: 'passive', label: 'passive mobs', colour: '#9fcf6a', on: true, source: 'map-live' },
  { id: 'items', label: 'items on the ground', colour: '#ffd27f', on: false, source: 'map-live' },
  { id: 'ores', label: 'ores', colour: '#7fe3ff', on: false, source: 'marks' },
  { id: 'chests', label: 'chests', colour: '#b5793a', on: true, source: 'marks' },
  { id: 'spawners', label: 'spawners', colour: '#ff3fd2', on: true, source: 'marks' },
  { id: 'beds', label: 'beds', colour: '#e04848', on: true, source: 'marks' },
  { id: 'stations', label: 'furnaces and crafting tables', colour: '#c8a060', on: false, source: 'marks' },
  { id: 'farmland', label: 'farmland', colour: '#7a5230', on: true, source: 'marks' },
  { id: 'forests', label: 'forests', colour: '#2f8f3a', on: false, source: 'marks' },
];

/** Which overlay an entity kind belongs to (null: not drawn). */
export function entityOverlay(kind: string): string | null {
  return kind === 'player' ? 'players' : kind === 'hostile' ? 'hostiles' : kind === 'passive' || kind === 'neutral' ? 'passive' : kind === 'item' ? 'items' : null;
}

/** An ore's marker colour by kind (diamond cyan, iron tan ...); other ores the overlay colour. */
export function oreColour(name: string): string {
  const k = name.replace(/^(deepslate|nether)_/, '').replace(/_ore$/, '');
  const c: Record<string, string> = { diamond: '#5ee8e0', iron: '#d8af93', gold: '#f7d23c', copper: '#e07a4a', coal: '#3a3a3a', redstone: '#ff2a2a', lapis: '#2f56d6', emerald: '#2fdc6a', quartz: '#efe6dc', ancient_debris: '#7a4a3a' };
  return c[k] ?? '#7fe3ff';
}

// ---- layers --------------------------------------------------------------------------------------------

export interface LayerDef {
  id: 'surface' | 'class' | 'slice';
  label: string;
}

export const MAP_LAYERS: readonly LayerDef[] = [
  { id: 'surface', label: 'surface' },
  { id: 'class', label: 'classes' },
  { id: 'slice', label: 'Y-slice' },
];

// ---- actions -------------------------------------------------------------------------------------------

/** What a block action knows about the tapped block. */
export interface PointContext {
  x: number;
  z: number;
  /** The block's y (the surface, or the slice height), null when the map knows nothing there. */
  y: number | null;
  /** The block there (null: unknown or air). */
  block: string | null;
  /** The bot's feet (null when unknown). */
  bot: { x: number; y: number; z: number } | null;
  /** The bot carries or wears an elytra (Fly here). */
  elytra: boolean;
}

/** A box: corners (inclusive) and the y range. */
export interface MapBox {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  y1: number;
  y2: number;
}

export interface BoxContext {
  /** The block the owner picked from the inventory (Fill, Floor, Wall). */
  block: string | null;
}

export interface MapActionDef {
  id: string;
  label: string;
  kind: 'point' | 'box';
  /** The chat command's words (`goto`, `build clear`): the guard test checks the command is registered. */
  command: string;
  /** docs/map.md "Actions" says the same. */
  doc: string;
  /** Asks for a name first (`{name}` in the command). */
  prompt?: string;
  /** The command, or null when it does not apply here. */
  point?: (c: PointContext) => string | null;
  box?: (b: MapBox, c: BoxContext) => string | null;
}

const feet = (c: PointContext): number | null => (c.y === null ? (c.bot ? Math.floor(c.bot.y) : null) : c.y + 1);
const at = (c: PointContext): string | null => {
  const f = feet(c);
  return f === null ? null : `${c.x} ${f} ${c.z}`;
};
const DIGGABLE = (b: string | null): boolean => b !== null && b !== 'air' && b !== 'water' && b !== 'lava' && b !== 'bedrock';

/** Tunnel to here: the tapped block within one block of a straight line north / south / east / west of the bot, 2..256 away. */
export function tunnelTo(c: PointContext): { dir: string; length: number } | null {
  if (!c.bot) return null;
  const dx = c.x - Math.floor(c.bot.x);
  const dz = c.z - Math.floor(c.bot.z);
  if (Math.abs(dz) <= 1 && Math.abs(dx) >= 2 && Math.abs(dx) <= 256) return { dir: dx > 0 ? 'east' : 'west', length: Math.abs(dx) };
  if (Math.abs(dx) <= 1 && Math.abs(dz) >= 2 && Math.abs(dz) <= 256) return { dir: dz > 0 ? 'south' : 'north', length: Math.abs(dz) };
  return null;
}

const corners = (b: MapBox): string => `${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2}`;

export const MAP_ACTIONS: readonly MapActionDef[] = [
  { id: 'walk', label: 'Go here', kind: 'point', command: 'goto', doc: 'walk to the block above the tapped one', point: (c) => (at(c) ? `!goto ${at(c)}` : null) },
  { id: 'fly', label: 'Fly here', kind: 'point', command: 'fly', doc: 'fly there with the elytra (only when the bot has one)', point: (c) => (c.elytra && at(c) ? `!fly ${at(c)}` : null) },
  { id: 'wp', label: 'Set waypoint...', kind: 'point', command: 'wp set', doc: 'asks a name, then sets the waypoint on the block above', prompt: 'waypoint name (a-z 0-9 _ -)', point: (c) => (at(c) ? `!wp set {name} ${at(c)}` : null) },
  { id: 'home', label: 'Set home here', kind: 'point', command: 'home set', doc: 'the home point on the block above', point: (c) => (at(c) ? `!home set ${at(c)}` : null) },
  { id: 'shelter', label: 'Set shelter here', kind: 'point', command: 'shelter set', doc: 'the night shelter on the block above', point: (c) => (at(c) ? `!shelter set ${at(c)}` : null) },
  {
    id: 'dig',
    label: 'Dig this block',
    kind: 'point',
    command: 'build clear',
    doc: 'digs exactly the tapped block (a 1 x 1 x 1 clear; the builder walks to it, keeps the drops)',
    point: (c) => (c.y !== null && DIGGABLE(c.block) ? `!build clear ${c.x} ${c.y} ${c.z} ${c.x} ${c.y} ${c.z}` : null),
  },
  {
    id: 'tunnel',
    label: 'Tunnel to here',
    kind: 'point',
    command: 'tunnel',
    doc: 'a 3 x 3 tunnel from the bot towards the block, when it lies straight north, south, east or west of the bot',
    point: (c) => {
      const t = tunnelTo(c);
      return t ? `!tunnel ${t.dir} ${t.length}` : null;
    },
  },
  { id: 'clear', label: 'Clear', kind: 'box', command: 'build clear', doc: 'digs every block of the box', box: (b) => `!build clear ${corners(b)}` },
  { id: 'fill', label: 'Fill', kind: 'box', command: 'build fill', doc: 'places the picked block in every free cell of the box', box: (b, c) => (c.block ? `!build fill ${corners(b)} ${c.block}` : null) },
  { id: 'floor', label: 'Floor', kind: 'box', command: 'build floor', doc: 'a one-block-high floor of the picked block at the lower y', box: (b, c) => (c.block ? `!build floor ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.z2} ${c.block}` : null) },
  {
    id: 'wall',
    label: 'Wall',
    kind: 'box',
    command: 'build wall',
    doc: 'a wall of the picked block along the drag (first corner to second), from the lower y up to the upper',
    box: (b, c) => (c.block ? `!build wall ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.z2} ${Math.max(1, b.y2 - b.y1 + 1)} ${c.block}` : null),
  },
  { id: 'quarry', label: 'Quarry', kind: 'box', command: 'quarry', doc: 'digs the box out layer by layer with stairs (at most 64 on every side)', box: (b) => `!quarry ${corners(b)}` },
];

/** The box with its corners in order (x1 <= x2, z1 <= z2, y1 <= y2), keeping the drag direction for the wall. */
export function orderedBox(b: MapBox): MapBox {
  return { x1: Math.min(b.x1, b.x2), z1: Math.min(b.z1, b.z2), x2: Math.max(b.x1, b.x2), z2: Math.max(b.z1, b.z2), y1: Math.min(b.y1, b.y2), y2: Math.max(b.y1, b.y2) };
}

/** `5 x 3 x 5 = 75 blocks` (x, y, z). */
export function boxSize(b: MapBox): { w: number; h: number; d: number; blocks: number; text: string } {
  const w = Math.abs(b.x2 - b.x1) + 1;
  const h = Math.abs(b.y2 - b.y1) + 1;
  const d = Math.abs(b.z2 - b.z1) + 1;
  return { w, h, d, blocks: w * h * d, text: `${w} x ${h} x ${d} = ${w * h * d} blocks` };
}

/** The block actions that apply at a tapped block. */
export function pointActions(c: PointContext): MenuAction[] {
  const out: MenuAction[] = [];
  for (const a of MAP_ACTIONS) {
    if (a.kind !== 'point' || !a.point) continue;
    const cmd = a.point(c);
    if (cmd) out.push({ id: a.id, label: a.label, cmd, ...(a.prompt ? { prompt: a.prompt } : {}) });
  }
  return out;
}

/** The box actions (Fill, Floor and Wall only with a picked block); the wall keeps the drag direction, the rest take the ordered box. */
export function boxActions(b: MapBox, c: BoxContext): MenuAction[] {
  const out: MenuAction[] = [];
  const o = orderedBox(b);
  for (const a of MAP_ACTIONS) {
    if (a.kind !== 'box' || !a.box) continue;
    const cmd = a.box(a.id === 'wall' ? { ...b, y1: o.y1, y2: o.y2 } : o, c);
    if (cmd) out.push({ id: a.id, label: a.label, cmd, ...(a.id === 'clear' || a.id === 'quarry' ? { confirm: true } : {}) });
  }
  return out;
}
