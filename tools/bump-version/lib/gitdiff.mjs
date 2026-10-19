// Minimal git-style unified diff writer (no dependencies). Output is accepted by `git apply`,
// GNU `patch -p1`, patch-package and pnpm's patchedDependencies.

function splitLines (text) {
  if (text === '') return { lines: [], eofNewline: true }
  const eofNewline = text.endsWith('\n')
  const lines = (eofNewline ? text.slice(0, -1) : text).split('\n')
  return { lines, eofNewline }
}

// Myers O(ND) diff on line arrays -> list of ops: ['=', i, j] | ['-', i] | ['+', j]
function myers (a, b) {
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf); const B = b.slice(pre, b.length - suf)
  const N = A.length; const M = B.length; const MAX = N + M
  const ops = []
  for (let i = 0; i < pre; i++) ops.push(['=', i, i])
  let mid
  if (N === 0) mid = B.map((_, j) => ['+', pre + j])
  else if (M === 0) mid = A.map((_, i) => ['-', pre + i])
  else {
    const off = MAX; const v = new Int32Array(2 * MAX + 2); const trace = []
    let found = false
    for (let d = 0; d <= MAX && !found; d++) {
      if (d > 3000) break // pathological: fall back to one replace block (still a correct patch)
      trace.push(v.slice())
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1
        let y = x - k
        while (x < N && y < M && A[x] === B[y]) { x++; y++ }
        v[off + k] = x
        if (x >= N && y >= M) { found = true; break }
      }
    }
    if (!found) {
      mid = [...A.map((_, i) => ['-', pre + i]), ...B.map((_, j) => ['+', pre + j])]
    } else {
      const rev = []; let x = N; let y = M
      for (let d = trace.length - 1; d >= 0; d--) {
        const vv = trace[d]; const k = x - y
        const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1
        const prevX = d === 0 ? 0 : vv[off + prevK]; const prevY = prevX - prevK
        while (x > prevX && y > prevY) { rev.push(['=', pre + x - 1, pre + y - 1]); x--; y-- }
        if (d > 0) { if (x === prevX) rev.push(['+', pre + y - 1]); else rev.push(['-', pre + x - 1]) }
        x = prevX; y = prevY
      }
      mid = rev.reverse()
    }
  }
  ops.push(...mid)
  for (let i = 0; i < suf; i++) ops.push(['=', a.length - suf + i, b.length - suf + i])
  return ops
}

// One file's diff in git format. oldText null = new file, newText null = deleted file.
export function gitFileDiff (relPath, oldText, newText, context = 3) {
  if (oldText === newText) return ''
  const header = [`diff --git a/${relPath} b/${relPath}`]
  if (oldText == null) header.push('new file mode 100644')
  if (newText == null) header.push('deleted file mode 100644')
  header.push(oldText == null ? '--- /dev/null' : `--- a/${relPath}`)
  header.push(newText == null ? '+++ /dev/null' : `+++ b/${relPath}`)
  const o = splitLines(oldText ?? ''); const n = splitLines(newText ?? '')
  // Treat the "no newline at EOF" state as part of the last line so it diffs correctly.
  const a = o.lines.slice(); const b = n.lines.slice()
  const NL = '\u0000noeol'
  if (oldText != null && !o.eofNewline && a.length) a[a.length - 1] += NL
  if (newText != null && !n.eofNewline && b.length) b[b.length - 1] += NL
  const ops = myers(a, b)
  const fmt = (prefix, line) => line.endsWith(NL) ? `${prefix}${line.slice(0, -NL.length)}\n\\ No newline at end of file` : `${prefix}${line}`

  // group into hunks
  const hunks = []; let cur = null; let lastChange = -Infinity
  ops.forEach((op, idx) => {
    if (op[0] === '=') return
    if (!cur || idx - lastChange > 2 * context + 1) {
      cur = { start: Math.max(0, idx - context), end: idx }; hunks.push(cur)
    }
    cur.end = idx; lastChange = idx
  })
  const body = []
  for (const h of hunks) {
    const end = Math.min(ops.length - 1, h.end + context)
    const slice = ops.slice(h.start, end + 1)
    let oStart = null; let nStart = null; let oLen = 0; let nLen = 0
    // starting line numbers: position in old/new at the first op
    let oi = 0; let ni = 0
    for (let i = 0; i < h.start; i++) { const op = ops[i]; if (op[0] !== '+') oi++; if (op[0] !== '-') ni++ }
    oStart = oi; nStart = ni
    const lines = []
    for (const op of slice) {
      if (op[0] === '=') { lines.push(fmt(' ', a[op[1]])); oLen++; nLen++ } else if (op[0] === '-') { lines.push(fmt('-', a[op[1]])); oLen++ } else { lines.push(fmt('+', b[op[1]])); nLen++ }
    }
    const range = (s, l) => l === 0 ? `${s},0` : (l === 1 ? `${s + 1}` : `${s + 1},${l}`)
    body.push(`@@ -${range(oStart, oLen)} +${range(nStart, nLen)} @@`, ...lines)
  }
  return [...header, ...body].join('\n') + '\n'
}

// Re-root the file paths of a git-format patch, e.g. pnpm's package-relative paths
// ("a/data.js") to patch-package's project-relative ones ("a/node_modules/minecraft-data/data.js").
// Only header lines (from "diff --git" up to the first "@@") are touched, never hunk content.
export function rebasePatchPaths (text, prefix) {
  const p = prefix.replace(/\/?$/, '/')
  let inHeader = false
  return text.split('\n').map(line => {
    if (line.startsWith('diff --git ')) {
      inHeader = true
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (!m) throw new Error(`cannot parse ${line}`)
      return `diff --git a/${p}${m[1]} b/${p}${m[2]}`
    }
    if (inHeader && line.startsWith('@@')) inHeader = false
    if (inHeader && (line.startsWith('--- a/') || line.startsWith('+++ b/'))) return line.slice(0, 6) + p + line.slice(6)
    return line
  }).join('\n')
}
