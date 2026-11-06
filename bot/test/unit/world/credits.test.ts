// The End credits (world/credits.ts): the client answers show_credits at once and reports `showing` until the
// server moves the player out (change_dimension) or a new session starts.
import { describe, expect, it } from 'vitest';
import { CREDITS_END, CREDITS_HOLD_MS, CREDITS_START, CreditsWatcher } from '../../../src/world/credits.ts';

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

describe('CreditsWatcher', () => {
  const setup = (self = 9n) => {
    const src = fakeSource();
    let t = 1000;
    const w = new CreditsWatcher(src, { selfRuntimeId: () => self, now: () => t });
    return { src, w, advance: (ms: number) => (t += ms) };
  };

  it('answers a start for the bot with an end at once and shows until the move to the overworld', () => {
    const { src, w } = setup();
    expect(w.showing).toBe(false);
    src.emit('show_credits', { runtime_entity_id: 9n, status: CREDITS_START });
    expect(src.sent).toEqual([{ name: 'show_credits', params: { runtime_entity_id: 9n, status: CREDITS_END } }]);
    expect(w.showing).toBe(true);
    expect(w.stats).toEqual({ shown: 1, answered: 1 });
    src.emit('change_dimension', { dimension: 0, position: { x: 0, y: 64, z: 0 }, respawn: false });
    expect(w.showing).toBe(false);
  });

  it('answers again after a rejoin (the server starts the credits again while the bot stands in the portal)', () => {
    const { src, w } = setup();
    src.emit('show_credits', { runtime_entity_id: 9n, status: CREDITS_START });
    src.emit('start_game', {});
    expect(w.showing).toBe(false);
    src.emit('show_credits', { runtime_entity_id: 9n, status: CREDITS_START });
    expect(src.sent).toHaveLength(2);
    expect(w.showing).toBe(true);
  });

  it("ignores another player's credits and an end status", () => {
    const { src, w } = setup();
    src.emit('show_credits', { runtime_entity_id: 4n, status: CREDITS_START });
    src.emit('show_credits', { runtime_entity_id: 9n, status: CREDITS_END });
    expect(src.sent).toHaveLength(0);
    expect(w.showing).toBe(false);
  });

  it('before start_game (self id 0) answers with the id the server gave', () => {
    const { src } = setup(0n);
    src.emit('show_credits', { runtime_entity_id: 5, status: CREDITS_START });
    expect(src.sent[0]?.params).toEqual({ runtime_entity_id: 5n, status: CREDITS_END });
  });

  it('stops holding after CREDITS_HOLD_MS when the server never moves the bot, and dispose unsubscribes', () => {
    const { src, w, advance } = setup();
    src.emit('show_credits', { runtime_entity_id: 9n, status: CREDITS_START });
    advance(CREDITS_HOLD_MS + 1);
    expect(w.showing).toBe(false);
    w.dispose();
    expect(src.count()).toBe(0);
  });
});
