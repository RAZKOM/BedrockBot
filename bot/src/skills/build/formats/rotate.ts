// Turning a block's Bedrock states with its structure (Track B2, docs/build.md "Rotation"): a structure placed at
// 90, 180 or 270 degrees clockwise (seen from above) turns each cell, and with it every state that names a
// horizontal direction or an axis, so a stair that faced east in the file faces south at 90. Vertical directions,
// stair corners (left and right stay left and right), and states that name no direction stay as they are.
/** Horizontal directions clockwise from north. */
const CW = ['north', 'east', 'south', 'west'] as const;
type Dir = (typeof CW)[number];
const turnDir = (d: string, q: number): string => {
  const i = CW.indexOf(d as Dir);
  return i < 0 ? d : CW[(i + q) % 4]!;
};

/** Integer encodings of the four directions, by state (and block family where Bedrock differs). */
const WEIRDO: readonly Dir[] = ['east', 'west', 'south', 'north'];
const DIRECTION: readonly Dir[] = ['south', 'west', 'north', 'east'];
const FACING6: readonly string[] = ['down', 'up', 'north', 'south', 'west', 'east'];

function turnIndexed(order: readonly string[], v: unknown, q: number): unknown {
  if (typeof v !== 'number') return v;
  const d = order[v];
  if (d === undefined || !CW.includes(d as Dir)) return v;
  return order.indexOf(turnDir(d, q));
}

/** `states` of block `name` turned by `rot` degrees clockwise. */
export function rotateStates(name: string, states: Readonly<Record<string, unknown>>, rot: number): Record<string, unknown> {
  const q = (((Math.round(rot / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  if (q === 0) return { ...states };
  const out: Record<string, unknown> = {};
  const trapdoor = name.endsWith('trapdoor');
  for (const [k, v] of Object.entries(states)) {
    let key = k;
    let val = v;
    switch (k) {
      case 'weirdo_direction':
        val = turnIndexed(WEIRDO, v, q);
        break;
      case 'direction':
        val = turnIndexed(trapdoor ? WEIRDO : DIRECTION, v, q);
        break;
      case 'facing_direction':
        val = turnIndexed(FACING6, v, q);
        break;
      case 'ground_sign_direction':
        val = typeof v === 'number' ? (v + 4 * q) % 16 : v;
        break;
      case 'minecraft:cardinal_direction':
      case 'minecraft:facing_direction':
      case 'minecraft:block_face':
      case 'torch_facing_direction':
        val = typeof v === 'string' ? turnDir(v, q) : v;
        break;
      case 'pillar_axis':
      case 'portal_axis':
        val = q % 2 === 1 && (v === 'x' || v === 'z') ? (v === 'x' ? 'z' : 'x') : v;
        break;
      case 'vine_direction_bits':
        if (typeof v === 'number') {
          const bits: Record<Dir, number> = { south: 1, west: 2, north: 4, east: 8 };
          let n = 0;
          for (const d of CW) if (v & bits[d]) n |= bits[turnDir(d, q) as Dir];
          val = n;
        }
        break;
      default: {
        // per-side states: minecraft:connection_north, wall_connection_type_north
        const m = /^(minecraft:connection_|wall_connection_type_)(north|east|south|west)$/.exec(k);
        if (m) key = `${m[1]}${turnDir(m[2]!, q)}`;
      }
    }
    out[key] = val;
  }
  return out;
}
