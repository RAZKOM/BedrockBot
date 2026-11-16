// src/threads.ts (decision 0089): the wasm code GC guard of the bot's worker threads, and that every Worker of the
// bot's sources and scripts starts through it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guardWasmCodeGc, wasmCodeGcRaces } from '../../src/threads.ts';

const BOT = fileURLToPath(new URL('../../', import.meta.url));

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('threads: the wasm code GC guard', () => {
  it('races on V8 13.x (Node 24) only', () => {
    expect(wasmCodeGcRaces('13.6.233.17-node.58')).toBe(true);
    expect(wasmCodeGcRaces('12.4.254.21-node.33')).toBe(false); // Node 22: no process-wide import wrapper cache
    expect(wasmCodeGcRaces('14.1.146.11-node.20')).toBe(false); // Node 25+: has the fix
  });

  it('is set once and says so (BEDROCKBOT_WASM_CODE_GC=on leaves the default)', () => {
    const want = wasmCodeGcRaces() && process.env.BEDROCKBOT_WASM_CODE_GC !== 'on';
    expect(guardWasmCodeGc()).toBe(want);
    expect(guardWasmCodeGc({ BEDROCKBOT_WASM_CODE_GC: want ? 'on' : undefined })).toBe(want); // decided once a process
  });

  it('no wasm code GC runs after the guard, while a worker strips its .ts sources (V8 13.x)', () => {
    if (!wasmCodeGcRaces()) return;
    // three planner workers one after another, as a test file starts them; --trace-wasm-code-gc prints each code GC
    // (execArgv []: the workers must not inherit --input-type)
    const threads = JSON.stringify(new URL('../../src/threads.ts', import.meta.url).href);
    const program = (guard: boolean): string => `
      ${guard ? `const { startWorker } = await import(${threads});` : "const { Worker } = await import('node:worker_threads'); const startWorker = (u, o) => new Worker(u, o);"}
      const file = new URL(${JSON.stringify(new URL('../../src/skills/nav/worker.ts', import.meta.url).href)});
      for (let i = 0; i < 3; i++) await new Promise((res) => { const w = startWorker(file, { workerData: { bedrockbotPlanner: true }, execArgv: [] }); w.once('message', () => w.terminate().then(res)); });`;
    const gcs = (guard: boolean): number => {
      const env = { ...process.env };
      delete env.NODE_COMPILE_CACHE; // a warm compile cache skips the stripping: no wasm would run
      delete env.BEDROCKBOT_WASM_CODE_GC;
      const r = spawnSync(process.execPath, ['--trace-wasm-code-gc', '--input-type=module', '-e', program(guard)], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      return (`${r.stdout}${r.stderr}`.match(/\[wasm-gc\] Starting GC/g) ?? []).length;
    };
    expect(gcs(false)).toBeGreaterThan(0); // the test sees code GC at all
    expect(gcs(true)).toBe(0);
  }, 30_000);

  it('every Worker in src and scripts starts through startWorker', () => {
    const offenders: string[] = [];
    for (const f of [...tsFiles(join(BOT, 'src')), ...tsFiles(join(BOT, 'scripts'))]) {
      const rel = relative(BOT, f).replace(/\\/g, '/');
      if (rel === 'src/threads.ts' || rel === 'scripts/worker-churn.ts') continue; // the guard itself; the repro starts raw workers on purpose
      if (readFileSync(f, 'utf8').includes('new Worker(')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
