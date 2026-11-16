// Worker threads (decision 0089, docs/pathfinding.md "Compute"): every `worker_threads` Worker the bot starts goes
// through `startWorker`, which first turns V8's wasm code GC off on the Node line where it races with worker exits.
//
// Why: Node strips the types of every .ts file a thread loads with a WebAssembly module (amaro: swc built to wasm), so
// each worker runs wasm while it loads its sources. Node 24's V8 (13.6) keeps the wasm-to-JS import wrappers in one
// cache for the whole process; when a worker ends, its wrappers die, and the wasm code GC frees them on one thread
// while another thread that tiers a wrapper up (Runtime_TierUpWasmToJSWrapper) takes a reference to the same dying
// wrapper and frees it again when its scope ends. V8's JIT page bookkeeping then aborts the process (SIGTRAP on macOS,
// `Check failed: end > addr.` or `jit_page_->allocations_.erase(addr) == 1`). V8 fixed it in 9b8ca54d5a ("[wasm] Fix
// lookup of wrappers marked is_dying"); Node 22 (V8 12.4, no shared wrapper cache) and Node 25+ do not have the race,
// Node 24 has no backport yet (nodejs/node#66366, nodejs/node#66376). With `--no-wasm-code-gc` dead wasm code is not
// collected, so no thread frees a wrapper under another. The cost: dead wasm code stays allocated until its module goes;
// JavaScript is not touched.
//
// BEDROCKBOT_WASM_CODE_GC=on leaves V8's default (to measure the race; nothing else should set it).
import { setFlagsFromString } from 'node:v8';
import { Worker, type WorkerOptions } from 'node:worker_threads';

/** The V8 line with the process-wide import wrapper cache and without the fix: Node 24's 13.x. */
export function wasmCodeGcRaces(v8: string = process.versions.v8): boolean {
  return v8.startsWith('13.');
}

let guarded: boolean | undefined;

/**
 * Turns the wasm code GC off once per process where it races (wasmCodeGcRaces). True when the flag was set. V8 reads
 * the flag each time code becomes dead, so setting it before the first worker ends is enough.
 */
export function guardWasmCodeGc(env: NodeJS.ProcessEnv = process.env): boolean {
  if (guarded === undefined) {
    guarded = wasmCodeGcRaces() && env.BEDROCKBOT_WASM_CODE_GC !== 'on';
    if (guarded) setFlagsFromString('--no-wasm-code-gc');
  }
  return guarded;
}

/** A Worker with the guard applied (use this instead of `new Worker`). */
export function startWorker(url: URL | string, opts?: WorkerOptions): Worker {
  guardWasmCodeGc();
  return new Worker(url, opts);
}
