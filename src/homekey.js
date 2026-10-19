// How a typed home name becomes a registry key. The registry never stores plain names,
// only the SHA-256 of the normalized name, so nobody can list the homes by reading the file.
// Pure JavaScript (no crypto.subtle) so it also works where the page is not a "secure context".
// Used by the app and by scripts/add-home.mjs, so both always agree.
export const normalizeHome = s =>
  String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function sha256hex(text) {
  const maxWord = 2 ** 32;
  const rotr = (v, a) => (v >>> a) | (v << (32 - a));
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / maxWord));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const hash = [], k = [], composite = {};
  for (let c = 2, n = 0; n < 64; c++) {
    if (composite[c]) continue;
    for (let i = 0; i < 313; i += c) composite[i] = true;
    if (n < 8) hash[n] = (c ** 0.5 * maxWord) | 0;
    k[n++] = (c ** (1 / 3) * maxWord) | 0;
  }

  const w = new Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = hash;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + add[i]) | 0;
  }
  return hash.map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

export const homeKey = name => sha256hex(normalizeHome(name));
