import { world, system, GameMode } from "@minecraft/server";
import * as gametest from "@minecraft/server-gametest";
let sim = null;
const say = (m) => world.sendMessage("[truth] " + m);
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const [cmd, ...args] = ev.id.split(":")[1] ? [ev.id.split(":")[1], ...ev.message.trim().split(/\s+/)] : [];
  const ow = world.getDimension("overworld");
  try {
    if (cmd === "block") { const [x, y, z] = args.map(Number); const b = ow.getBlock({ x, y, z }); say(`block ${x} ${y} ${z} = ${b ? b.typeId : "unloaded"}`); }
    else if (cmd === "set") { const [x, y, z, type] = args; ow.getBlock({ x: +x, y: +y, z: +z }).setType(type); say(`set ${x} ${y} ${z} ${type}`); }
    else if (cmd === "pos") { for (const p of world.getAllPlayers()) { const l = p.location; say(`pos ${p.name} ${l.x.toFixed(3)} ${l.y.toFixed(3)} ${l.z.toFixed(3)} onground=${p.isOnGround} tick=${system.currentTick}`); } }
    else if (cmd === "sim") { const [x, y, z] = args.map(Number); sim = gametest.spawnSimulatedPlayer({ dimension: ow, x, y, z }, "SimBot", GameMode.Survival); say(`sim spawned ${sim.name} at ${JSON.stringify(sim.location)}`); }
    else if (cmd === "simnav") { const [x, y, z] = args.map(Number); const r = sim.navigateToLocation({ x, y, z }, 1); say(`simnav fullpath=${r.isFullPath} pathlen=${r.getPath().length}`); system.runTimeout(() => say(`sim now at ${JSON.stringify(sim.location)}`), 60); }
    else if (cmd === "simbreak") { const [x, y, z] = args.map(Number); say(`simbreak ${sim.breakBlock({ x, y, z })}`); }
    else if (cmd === "ping") say(`pong tick=${system.currentTick}`);
  } catch (e) { say("error " + e); }
});
world.afterEvents.playerBreakBlock.subscribe((ev) => say(`break ${ev.player.name} ${ev.block.location.x} ${ev.block.location.y} ${ev.block.location.z} was ${ev.brokenBlockPermutation.type.id}`));
system.runTimeout(() => say("SpikePack loaded"), 20);
