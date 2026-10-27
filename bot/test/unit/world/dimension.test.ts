// Track AT (docs/nether.md): dimension names and rules, per-dimension waypoint names, the
// DimensionWatcher (the client's dimension_change_ack answer) and the World's reset on change_dimension,
// with the packet shapes recorded on bds-nether (BDS 1.26.60.6).
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import {
  bedsWork,
  dimensionIdOf,
  dimensionName,
  DimensionWatcher,
  dimWaypointName,
  hasDayCycle,
  hasSurface,
  surfaceRefusal,
  voidBelow,
  waterWorks,
  waypointDimension,
  type DimensionChange,
} from '../../../src/world/dimension.ts';
import { World } from '../../../src/world/index.ts';

/** A packet source: `emit` delivers a server packet, `sent` collects what the client queued. */
function fakeSource() {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  return {
    sent,
    on(name: string, fn: (p: Record<string, unknown>) => void) {
      let s = handlers.get(name);
      if (!s) handlers.set(name, (s = new Set()));
      s.add(fn);
      return () => s.delete(fn);
    },
    queue(name: string, params: Record<string, unknown>) {
      sent.push({ name, params });
    },
    emit(name: string, params: Record<string, unknown>) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(params);
    },
    count(): number {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
  };
}

// recorded on bds-nether (truth teleport overworld -> nether, then the server's ack 445 ms later)
const CHANGE = { dimension: 1, position: { x: 1102.5, y: 100, z: 500.5 }, respawn: false, loading_screen_id: 2 };
const SERVER_ACK = { runtime_entity_id: 8n, action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 };

describe('dimension names and rules', () => {
  it('names and ids', () => {
    expect([0, 1, 2].map(dimensionName)).toEqual(['overworld', 'nether', 'the_end']);
    expect(dimensionName(7)).toBe('7');
    expect(dimensionName(undefined)).toBe('unknown');
    expect(dimensionIdOf('minecraft:the_end')).toBe(2);
    expect(dimensionIdOf('Nether')).toBe(1);
    expect(dimensionIdOf('end')).toBe(2);
    expect(dimensionIdOf('0')).toBe(0);
    expect(dimensionIdOf(1)).toBe(1);
    expect(dimensionIdOf('moon')).toBeUndefined();
  });

  it('day cycle, beds, surface, water and the void per dimension', () => {
    expect([0, 1, 2].map(hasDayCycle)).toEqual([true, false, false]);
    expect([0, 1, 2].map(bedsWork)).toEqual([true, false, false]);
    expect([0, 1, 2].map(hasSurface)).toEqual([true, false, true]);
    expect([0, 1, 2].map(waterWorks)).toEqual([true, false, true]);
    expect([0, 1, 2].map(voidBelow)).toEqual([false, false, true]);
    expect(surfaceRefusal(1)).toMatch(/no surface in the Nether/);
    expect(surfaceRefusal(0)).toBeUndefined();
    expect(surfaceRefusal(2)).toBeUndefined();
    expect(surfaceRefusal(undefined)).toBeUndefined();
  });

  it('waypoint names carry the dimension outside the overworld', () => {
    expect(dimWaypointName(0, 'portal')).toBe('portal');
    expect(dimWaypointName(1, 'portal')).toBe('nether_portal');
    expect(dimWaypointName(2, 'portal')).toBe('end_portal');
    expect(dimWaypointName(1, 'a'.repeat(40))).toHaveLength(32);
    expect(waypointDimension('nether_portal')).toBe(1);
    expect(waypointDimension('end_portal')).toBe(2);
    expect(waypointDimension('portal')).toBe(0);
    expect(waypointDimension('home')).toBe(0);
  });
});

describe('DimensionWatcher', () => {
  function setup() {
    const src = fakeSource();
    let dim = 0;
    let t = 1000;
    const events: DimensionChange[] = [];
    const w = new DimensionWatcher(src, { selfRuntimeId: () => 8n, dimension: () => dim, loadedColumns: () => 393, now: () => t, logger: silentLogger });
    w.onChange((e) => events.push(e));
    return {
      src,
      w,
      events,
      setDim: (d: number) => {
        dim = d;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('change_dimension starts a change, the server ack is answered with the client ack and ends it', () => {
    const s = setup();
    s.src.emit('change_dimension', CHANGE);
    expect(s.w.changing).toBe(true);
    expect(s.events).toEqual([{ phase: 'start', from: 0, to: 1, position: CHANGE.position, loadingScreenId: 2, ms: 0 }]);
    expect(s.src.sent).toEqual([]);
    s.setDim(1);
    s.advance(445);
    s.src.emit('player_action', SERVER_ACK);
    expect(s.src.sent).toEqual([{ name: 'player_action', params: { runtime_entity_id: 8n, action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 } }]);
    expect(s.w.changing).toBe(false);
    expect(s.events[1]).toMatchObject({ phase: 'arrived', from: 0, to: 1, ms: 445 });
    expect(s.w.stats).toMatchObject({ changes: 1, arrivals: 1, lastAckMs: 445, last: { from: 0, to: 1 }, lastColumnsDropped: 393 });
  });

  it('other player actions are ignored; an ack without a change is still answered', () => {
    const s = setup();
    s.src.emit('player_action', { ...SERVER_ACK, action: 'start_sneak' });
    expect(s.src.sent).toEqual([]);
    s.src.emit('player_action', SERVER_ACK);
    expect(s.src.sent).toHaveLength(1);
    expect(s.events).toEqual([]);
    expect(s.w.stats.arrivals).toBe(0);
  });

  it('a throwing listener does not stop the others; dispose unsubscribes', () => {
    const s = setup();
    const seen: string[] = [];
    s.w.onChange(() => {
      throw new Error('boom');
    });
    s.w.onChange((e) => seen.push(e.phase));
    s.src.emit('change_dimension', CHANGE);
    expect(seen).toEqual(['start']);
    s.w.dispose();
    expect(s.src.count()).toBe(0);
  });
});

describe('World on a dimension change', () => {
  it('switches the dimension, takes the arrival position as feet, drops chunks and entities, answers the ack', () => {
    const src = fakeSource();
    const world = new World(src, { version: '1.26.60', logger: silentLogger, defer: (fn) => fn() });
    world.self.runtimeId = 8n;
    world.entityTracker.handleAddEntity({ runtime_id: 5n, unique_id: 5n, entity_type: 'minecraft:zombie', position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0, attributes: [], metadata: [], links: [] } as never);
    expect(world.entities.size).toBe(1);
    const starts: number[] = [];
    world.dimensions.onChange((e) => {
      if (e.phase === 'start') starts.push(world.self.dimension); // the old dimension still (the watcher subscribed first)
    });
    src.emit('change_dimension', CHANGE);
    expect(starts).toEqual([0]);
    expect(world.self.dimension).toBe(1);
    expect(world.chunks.dimension).toBe(1);
    expect(world.self.pos).toEqual({ x: 1102.5, y: 100, z: 500.5 });
    expect(world.entities.size).toBe(0);
    src.emit('player_action', SERVER_ACK);
    expect(src.sent.filter((s) => s.name === 'player_action')).toHaveLength(1);
    world.dispose();
    expect(src.count()).toBe(0);
  });
});
