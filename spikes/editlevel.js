// Spike D helper: enable the Beta APIs experiment ("gametest") in a BDS world's level.dat without a client.
const fs = require('fs'); const nbt = require('prismarine-nbt')
const file = process.argv[2]
const buf = fs.readFileSync(file)
const header = buf.subarray(0, 8); const body = buf.subarray(8)
const { parsed, type } = nbt.parseUncompressed ? { parsed: nbt.parseUncompressed(body, 'little'), type: 'little' } : {}
const exp = parsed.value.experiments || (parsed.value.experiments = nbt.comp({}))
exp.value.gametest = nbt.byte(1)
exp.value.experiments_ever_used = nbt.byte(1)
exp.value.saved_with_toggled_experiments = nbt.byte(1)
const out = nbt.writeUncompressed(parsed, 'little')
const h = Buffer.from(header); h.writeInt32LE(out.length, 4)
fs.copyFileSync(file, file + '.bak'); fs.writeFileSync(file, Buffer.concat([h, out]))
console.log('experiments now:', JSON.stringify(nbt.simplify(parsed).experiments))
