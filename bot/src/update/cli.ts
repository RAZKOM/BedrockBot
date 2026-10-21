// `pnpm update:check` (PLAN.md task 5.3): is there a newer game version, BDS build, bedrock-protocol
// or minecraft-data than the pinned set? Prints one line per item; `--json` prints the full report;
// `--out <file>` also writes it. Exit codes: 0 (also when something is newer; `--fail-on-update` makes
// that 10, for schedulers that act on exit codes; pnpm reports any non-zero code as 1), 1 every
// source failed, 2 bad arguments.
// Schedule it daily with the OS (Windows: `schtasks`, see docs/runbook.md "Operations"), or let the
// bot run it (`--update-check-hours 24`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { currentPins, formatReport, runUpdateCheck } from './check.ts';

async function main(argv: string[]): Promise<number> {
  // pnpm forwards `--` separators (`pnpm bot:afk -- --port 1` gives `--task afk -- --port 1`); no
  // command here takes positional arguments, so drop them all.
  const args = argv.filter((a) => a !== '--');
  let values: { json?: boolean; out?: string; version?: string; help?: boolean; 'fail-on-update'?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { json: { type: 'boolean' }, out: { type: 'string' }, version: { type: 'string' }, 'fail-on-update': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (values.help) {
    console.log('usage: pnpm update:check [--json] [--out <file>] [--version <pinned game version>] [--fail-on-update]');
    return 0;
  }
  const pins = currentPins(values.version);
  const report = await runUpdateCheck({ pins });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatReport(report)) console.log(line);
  if (values.out) {
    const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  if (report.findings.every((f) => f.latest === null)) return 1;
  if (report.newer.length && values['fail-on-update']) return 10;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
