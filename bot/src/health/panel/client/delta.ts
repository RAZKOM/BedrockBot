// State deltas for the push channel (docs/panel.md "Live updates", decision 0061). Pure functions on
// JSON values, imported by the server (stream.ts computes them once per publish) and by the page
// (transport.ts applies them), so both sides run the same code.
//
// A delta is a list of operations on the previous value, in order:
//   ['s', path, value]       set the key / array index at path (path [] = replace the whole value)
//   ['d', path]              delete the object key at path
//   ['a', path, drop, tail]  an array that moved like a log: drop `drop` items from the front, append `tail`
// Objects are compared key by key, arrays of the same length index by index (one inventory cell that
// changed is one 's' op), a log or chat ring that scrolled is one 'a' op, anything else is replaced.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Path = (string | number)[];
export type DeltaOp = ['s', Path, Json] | ['d', Path] | ['a', Path, number, Json[]];

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep equality of two JSON values. */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!(k in b) || !jsonEqual(a[k], b[k])) return false;
  return true;
}

/** The smallest drop d (0..limit) with next = prev.slice(d) + tail, or -1. */
function scrolled(prev: Json[], next: Json[], limit: number): number {
  for (let d = 0; d <= Math.min(limit, prev.length); d++) {
    const keep = prev.length - d;
    if (keep > next.length || keep === 0) continue;
    let ok = true;
    for (let i = 0; i < keep && ok; i++) ok = jsonEqual(prev[d + i], next[i]);
    if (ok) return d;
  }
  return -1;
}

function diffInto(prev: Json | undefined, next: Json, path: Path, out: DeltaOp[]): void {
  if (jsonEqual(prev, next)) return;
  const set: DeltaOp = ['s', path, next];
  if (isObj(prev) && isObj(next)) {
    const ops: DeltaOp[] = [];
    for (const k of Object.keys(prev)) if (!(k in next)) ops.push(['d', [...path, k]]);
    for (const k of Object.keys(next)) diffInto(prev[k], next[k]!, [...path, k], ops);
    out.push(...shortest(set, [ops]));
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    const candidates: DeltaOp[][] = [];
    // the same length: element by element (one inventory cell that changed = one op)
    if (prev.length === next.length) {
      const ops: DeltaOp[] = [];
      for (let i = 0; i < next.length; i++) diffInto(prev[i], next[i]!, [...path, i], ops);
      candidates.push(ops);
    }
    // a ring that scrolled (logs, chat): one op instead of every line
    const d = next.length > 0 && prev.length > 0 ? scrolled(prev, next, 64) : -1;
    if (d >= 0 && (d > 0 || next.length > prev.length)) candidates.push([['a', path, d, next.slice(prev.length - d)]]);
    out.push(...shortest(set, candidates));
    return;
  }
  out.push(set);
}

/**
 * The shortest way to write a change as JSON: replace the value (`set`) or one of the fine-grained
 * candidates. A candidate of one or two ops carries only parts of the new value, so it wins without
 * measuring (the common case: a cell, a counter, a scrolled log); otherwise every candidate is measured.
 */
function shortest(set: DeltaOp, fine: DeltaOp[][]): DeltaOp[] {
  const tiny = fine.filter((c) => c.length > 0 && c.length <= 2).sort((a, b) => a.length - b.length)[0];
  if (tiny) return tiny;
  let best: DeltaOp[] = [set];
  let size = JSON.stringify(best).length;
  for (const c of fine) {
    const n = JSON.stringify(c).length;
    if (n < size) {
      best = c;
      size = n;
    }
  }
  return best;
}

/** The operations that turn prev into next ([] when equal). */
export function diffJson(prev: Json | undefined, next: Json): DeltaOp[] {
  const out: DeltaOp[] = [];
  diffInto(prev, next, [], out);
  return out;
}

/** Apply ops to value (in place where it can) and return the result (a new root for a [] path). */
export function applyDelta(value: Json, ops: readonly DeltaOp[]): Json {
  let root = value;
  for (const op of ops) {
    const path = op[1];
    if (path.length === 0) {
      if (op[0] === 's') root = op[2];
      else if (op[0] === 'a' && Array.isArray(root)) root = root.slice(op[2]).concat(op[3]);
      continue;
    }
    let parent: Json = root;
    for (let i = 0; i < path.length - 1; i++) {
      const next: Json | undefined = (parent as Record<string | number, Json>)[path[i]!];
      if (typeof next !== 'object' || next === null) throw new Error(`delta: no container at ${path.slice(0, i + 1).join('.')}`);
      parent = next;
    }
    if (typeof parent !== 'object' || parent === null) throw new Error(`delta: no container at ${path.join('.')}`);
    const key = path[path.length - 1]!;
    const box = parent as Record<string | number, Json>;
    if (op[0] === 's') box[key] = op[2];
    else if (op[0] === 'd') delete box[key];
    else {
      const arr = box[key];
      if (!Array.isArray(arr)) throw new Error(`delta: no array at ${path.join('.')}`);
      box[key] = arr.slice(op[2]).concat(op[3]);
    }
  }
  return root;
}
