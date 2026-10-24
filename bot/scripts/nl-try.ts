// Try the natural-language front end without a bot (PLAN.md 7.18, Track Y; docs/natural-language.md):
//
//   node scripts/nl-try.ts "walk home then guard"
//   node scripts/nl-try.ts --waypoints home,base,mine "go to the mine and get 10 iron"
//   node scripts/nl-try.ts --model llama3.1:8b --url http://127.0.0.1:11434 "come here"
//   node scripts/nl-try.ts --fake "walk home then guard"      (no model: the prompt's worked examples)
//   node scripts/nl-try.ts --prompt "come here"               (also print the system prompt)
//
// Reads the `nl` block of the config file (--config, BEDROCKBOT_CONFIG or the default path; --no-config
// skips it), asks the provider once and prints the raw answer, the validated plan, the checks against
// the request and the chat commands it would run. Exit 0 = a plan or a question, 1 = invalid answer
// or provider error, 2 = usage.
import { parseArgs } from 'node:util';
import { loadConfig, locateConfig } from '../src/config/config.ts';
import { SETTING_DEFS, SETTING_KEYS, formatSettingValue } from '../src/config/settings.ts';
import { checkPlan } from '../src/nl/executor.ts';
import { FakeProvider } from '../src/nl/fake.ts';
import { OllamaProvider } from '../src/nl/ollama.ts';
import { parsePlan, planJsonSchema, planLine, stepCommand } from '../src/nl/plan.ts';
import { buildSystemPrompt, buildUserMessage, EXAMPLES } from '../src/nl/prompt.ts';
import { resolveNlConfig, type NlProvider } from '../src/nl/provider.ts';

const ALL_COMMANDS = ['goto', 'come', 'follow', 'stop', 'guard', 'kill', 'gather', 'mine', 'farm', 'eat', 'equip', 'wp', 'set', 'pause', 'resume', 'inv', 'drop', 'top', 'home'];

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'no-config': { type: 'boolean' },
        url: { type: 'string' },
        model: { type: 'string' },
        'timeout-ms': { type: 'string' },
        waypoints: { type: 'string' },
        commands: { type: 'string' },
        sender: { type: 'string' },
        fake: { type: 'boolean' },
        prompt: { type: 'boolean' },
        schema: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { values: v, positionals } = parsed;
  const text = positionals.join(' ').trim();
  if (v.help || (!text && !v.schema)) {
    console.error('usage: node scripts/nl-try.ts [--config f | --no-config] [--url u] [--model m] [--timeout-ms n] [--waypoints a,b] [--commands a,b] [--sender name] [--fake] [--prompt] [--schema] "<request>"');
    return v.help ? 0 : 2;
  }
  if (v.schema) {
    console.log(JSON.stringify(planJsonSchema(), null, 2));
    if (!text) return 0;
  }
  const cfg = v['no-config'] ? {} : loadConfig(locateConfig(v.config)).config;
  const nl = resolveNlConfig(cfg.nl);
  const url = v.url ?? nl.url;
  const model = v.model ?? nl.model;
  const timeoutMs = v['timeout-ms'] !== undefined ? Number(v['timeout-ms']) : nl.timeoutMs;
  let provider: NlProvider;
  if (v.fake) {
    provider = new FakeProvider(EXAMPLES.map((e) => [e.request, e.plan] as const));
  } else {
    if (nl.provider === 'none' && v.url === undefined && v.model === undefined) console.error('note: nl.provider is none in the config; asking Ollama anyway (the bot would not)');
    provider = new OllamaProvider({ url, model, timeoutMs });
  }
  const waypoints = (v.waypoints ?? 'home').split(',').map((s) => s.trim()).filter(Boolean);
  const commands = v.commands ? v.commands.split(',').map((s) => s.trim()) : ALL_COMMANDS;
  const sender = v.sender ?? 'Steve';
  const system = buildSystemPrompt({
    botName: 'Bot',
    sender,
    status: 'pos 0.5 -60.0 0.5, task afk, behaviour idle (nl-try: no bot)',
    stack: 'idle',
    waypoints,
    inventory: 'unknown (nl-try: no bot)',
    settings: SETTING_KEYS.map((k) => `${k} ${formatSettingValue(k, SETTING_DEFS[k].default)}`).join(', '),
    help: new Map(commands.map((c) => [c, `!${c}`])),
  });
  if (v.prompt) console.log(`--- system prompt ---\n${system}\n--- end ---`);
  const t0 = Date.now();
  let answer: string;
  try {
    answer = await provider.complete({ system, user: buildUserMessage(sender, text), schema: planJsonSchema() });
  } catch (e) {
    console.error(`provider ${provider.label}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`answer (${provider.label}, ${Date.now() - t0} ms): ${answer}`);
  const p = parsePlan(answer);
  if (!p.ok) {
    console.log(`invalid plan: ${p.error}`);
    return 1;
  }
  console.log(planLine(p.plan));
  const c = checkPlan(p.plan, { text, sender, waypoints, commands });
  if (c.kind === 'question') console.log(`the bot would ask: ${c.text}`);
  else if (c.kind === 'unavailable') console.log(`the bot would say: not available: ${c.command}`);
  else for (const s of c.plan.steps) console.log(s.command === 'question' ? `  ask: ${s.text}` : `  !${stepCommand(s)}`);
  return 0;
}

process.exitCode = await main();
