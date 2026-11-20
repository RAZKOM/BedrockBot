// Track F22: a far server on a local one. A UDP relay that holds every datagram for a fixed time each way, so that a bot
// on this machine sees a local test server as it sees one a round trip away (a Realm): the rocket entity's `add_entity`
// and its removal come that much later, and the server flies the inputs that much later.
//
//   node scripts/udp-lag.ts --listen 29210 --to 127.0.0.1:19210 --ms 75 [--jitter 25] [--for 900]
//
// The bot connects to the `--listen` port (FLY_BDS_PORT for the flight suites; their server commands go through `docker
// exec` and do not pass here). `--ms`: the delay of every datagram, each way (a round trip is twice that); `--jitter`:
// up to that many milliseconds more, drawn for each datagram (the order of two datagrams may then swap, as on a real
// link; RakNet orders them again). One upstream socket a client. Ends with the process.
import { createSocket, type Socket } from 'node:dgram';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const listen = Number(arg('listen', '29210'));
const [host = '127.0.0.1', portText = '19210'] = arg('to', '127.0.0.1:19210').split(':');
const port = Number(portText);
const ms = Number(arg('ms', '75'));
const jitter = Number(arg('jitter', '0'));
const hold = (): number => ms + (jitter > 0 ? Math.random() * jitter : 0);

const front = createSocket('udp4');
const clients = new Map<string, Socket>();
let up = 0;
let down = 0;
front.on('message', (data, from) => {
  const key = `${from.address}:${from.port}`;
  let back = clients.get(key);
  if (!back) {
    back = createSocket('udp4');
    clients.set(key, back);
    back.on('message', (reply) => {
      down++;
      setTimeout(() => front.send(reply, from.port, from.address), hold());
    });
    back.on('error', () => undefined);
  }
  const to = back;
  up++;
  setTimeout(() => to.send(data, port, host), hold());
});
front.on('error', (err) => {
  console.error(`udp-lag: ${err.message}`);
  process.exit(1);
});
front.bind(listen, () => console.log(`udp-lag: ${listen} -> ${host}:${port}, every datagram held ${ms}${jitter ? ` to ${ms + jitter}` : ''} ms each way`));
const stats = setInterval(() => console.log(`udp-lag: ${up} datagrams up, ${down} down, ${clients.size} client${clients.size === 1 ? '' : 's'}`), 60_000);
stats.unref();
// (`--for <seconds>`: the relay ends by itself, 15 minutes after it began unless told otherwise: nothing is left running)
const life = Number(arg('for', '900'));
setTimeout(() => {
  console.log(`udp-lag: ${life} s gone, ending (${up} datagrams up, ${down} down)`);
  process.exit(0);
}, life * 1000);
