// Tvine Shield proof-of-work worker (classic Worker script, no eval).
// Finds `counter` so that SHA-256(nonce + ':' + counter) has `difficulty` leading zero BITS.
// in:  { nonce, difficulty }   out: { progress: attempts } … then { counter } or { error }
'use strict'

function lzBits(h) {
  var n = 0
  for (var i = 0; i < h.length; i++) {
    if (h[i] === 0) { n += 8; continue }
    return n + Math.clz32(h[i]) - 24
  }
  return n
}

// Pure-JS SHA-256 fallback for insecure contexts (plain http on a LAN ip) where crypto.subtle is absent.
var K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2])
function sha256(msg) {
  var l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(nb)
  b.set(msg); b[l] = 0x80
  var dv = new DataView(b.buffer); dv.setUint32(nb - 4, l * 8); dv.setUint32(nb - 8, Math.floor(l / 0x20000000))
  var H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64)
  var r = function (x, n) { return (x >>> n) | (x << (32 - n)) }
  for (var o = 0; o < nb; o += 64) {
    for (var i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4)
    for (i = 16; i < 64; i++) w[i] = w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))
    var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (i = 0; i < 64; i++) {
      var t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
      var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  var out = new Uint8Array(32), odv = new DataView(out.buffer)
  for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i])
  return out
}

function digestFn() {
  var s = typeof crypto !== 'undefined' && crypto.subtle
  return s ? function (d) { return s.digest('SHA-256', d).then(function (x) { return new Uint8Array(x) }) }
           : function (d) { return Promise.resolve(sha256(d)) }
}

// Hashes in batches of 256 (parallel subtle calls); onProgress(attempts) every 4096 attempts.
async function solve(nonce, difficulty, onProgress, digest) {
  digest = digest || digestFn()
  var enc = new TextEncoder(), B = 256
  for (var base = 0; ; base += B) {
    var jobs = []
    for (var c = base; c < base + B; c++) jobs.push(digest(enc.encode(nonce + ':' + c)))
    var hs = await Promise.all(jobs)
    for (var k = 0; k < B; k++) if (lzBits(hs[k]) >= difficulty) return base + k
    if (onProgress && (base & 4095) === 0) onProgress(base + B)
  }
}

if (typeof importScripts === 'function') {
  self.onmessage = function (e) {
    var m = e.data || {}
    solve(String(m.nonce), Math.max(0, Math.min(32, m.difficulty | 0)), function (n) { self.postMessage({ progress: n }) })
      .then(function (counter) { self.postMessage({ counter: counter }) }, function (err) { self.postMessage({ error: String(err) }) })
  }
}
