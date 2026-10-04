/**
 * Pure math helpers for promotion harness (deterministic).
 */
"use strict";

function num(...xs) {
  for (const x of xs) {
    if (typeof x === "number" && Number.isFinite(x)) return x;
  }
  return null;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pctile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    s.length - 1,
    Math.max(0, Math.ceil((p / 100) * s.length) - 1)
  );
  return s[idx];
}

function trimmedMean(arr, trimFrac = 0.05) {
  if (arr.length < 10) return mean(arr);
  const s = [...arr].sort((a, b) => a - b);
  const k = Math.floor(s.length * trimFrac);
  const core = s.slice(k, s.length - k || undefined);
  return mean(core.length ? core : s);
}

function profitFactor(pnls) {
  let g = 0;
  let l = 0;
  for (const x of pnls) {
    if (x > 0) g += x;
    else if (x < 0) l += -x;
  }
  if (l <= 0) return g > 0 ? Infinity : null;
  return g / l;
}

/** Mulberry32 PRNG — fixed seed for reproducible bootstrap */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMedianDiff(a, b, { nBoot = 1000, seed = 42 } = {}) {
  if (!a.length || !b.length) {
    return { diff: null, lo: null, hi: null, nA: a.length, nB: b.length };
  }
  const rnd = mulberry32(seed);
  const obs = pctile(a, 50) - pctile(b, 50);
  const diffs = [];
  for (let i = 0; i < nBoot; i++) {
    const sa = [];
    const sb = [];
    for (let j = 0; j < a.length; j++) sa.push(a[(rnd() * a.length) | 0]);
    for (let j = 0; j < b.length; j++) sb.push(b[(rnd() * b.length) | 0]);
    diffs.push(pctile(sa, 50) - pctile(sb, 50));
  }
  diffs.sort((x, y) => x - y);
  return {
    diff: obs,
    lo: diffs[(0.025 * diffs.length) | 0],
    hi: diffs[(0.975 * diffs.length) | 0],
    nA: a.length,
    nB: b.length,
  };
}

/**
 * Spearman rank correlation (average ranks for ties).
 * Returns { rho, n } — no forced p-value.
 */
function spearman(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (
      typeof xs[i] === "number" &&
      Number.isFinite(xs[i]) &&
      typeof ys[i] === "number" &&
      Number.isFinite(ys[i])
    ) {
      pairs.push([xs[i], ys[i]]);
    }
  }
  const n = pairs.length;
  if (n < 3) return { rho: null, n };
  const rank = (vals) => {
    const idx = vals
      .map((v, i) => ({ v, i }))
      .sort((a, b) => a.v - b.v);
    const ranks = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j < idx.length && idx[j].v === idx[i].v) j++;
      const avg = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) ranks[idx[k].i] = avg;
      i = j;
    }
    return ranks;
  };
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  const mx = mean(rx);
  const my = mean(ry);
  let nume = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    nume += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return { rho: null, n };
  return { rho: nume / Math.sqrt(dx * dy), n };
}

/**
 * Kendall tau-b (handles ties). Returns { tau, n }.
 */
function kendallTau(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (
      typeof xs[i] === "number" &&
      Number.isFinite(xs[i]) &&
      typeof ys[i] === "number" &&
      Number.isFinite(ys[i])
    ) {
      pairs.push([xs[i], ys[i]]);
    }
  }
  const n = pairs.length;
  if (n < 3) return { tau: null, n };
  let C = 0;
  let D = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pairs[i][0] - pairs[j][0];
      const dy = pairs[i][1] - pairs[j][1];
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) {
        ty++;
        continue;
      }
      if (dy === 0) {
        tx++;
        continue;
      }
      if (dx * dy > 0) C++;
      else D++;
    }
  }
  const denom = Math.sqrt((C + D + tx) * (C + D + ty));
  if (denom <= 0) return { tau: null, n };
  return { tau: (C - D) / denom, n };
}

/**
 * Canonical executable MFE/MAE from a PnL path.
 * MFE = peak exec PnL since first fill quote.
 * MAE = trough exec PnL since first fill quote.
 */
function execPathPeaks(pnlPath) {
  if (!Array.isArray(pnlPath) || !pnlPath.length) {
    return { execMfe: null, execMae: null, valid: false };
  }
  for (const x of pnlPath) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      return { execMfe: null, execMae: null, valid: false };
    }
  }
  let peak = pnlPath[0];
  let trough = pnlPath[0];
  for (const x of pnlPath) {
    if (x > peak) peak = x;
    if (x < trough) trough = x;
  }
  return { execMfe: peak, execMae: trough, valid: true };
}

module.exports = {
  num,
  mean,
  pctile,
  trimmedMean,
  profitFactor,
  mulberry32,
  bootstrapMedianDiff,
  spearman,
  kendallTau,
  execPathPeaks,
};
