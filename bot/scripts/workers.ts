// The worker cap of the benches (Track I1, docs/runbook.md "Tests on the Mac (Track I1)"): BEDROCKBOT_MAX_WORKERS, when
// set, caps the workers / jobs a bench starts, whether asked for with --workers / --jobs or by default, so a run on
// the test host leaves cores to the live bot. Vitest has its own: VITEST_MAX_WORKERS (scripts/mac/remote.sh sets both).

/** `wanted` capped at BEDROCKBOT_MAX_WORKERS (unset, empty or not a positive number: no cap); at least 1. */
export function capWorkers(wanted: number, env: string | undefined = process.env.BEDROCKBOT_MAX_WORKERS): number {
  const cap = Number(env);
  const n = Math.max(1, Math.floor(wanted) || 1);
  return Number.isFinite(cap) && cap >= 1 ? Math.min(n, Math.floor(cap)) : n;
}
