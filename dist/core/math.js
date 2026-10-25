// Pure numeric helpers shared by returns.ts, drawdown.ts and windows.ts
//. Every function is total: an empty list yields 0 (or null
// where the contract says so) — never NaN, never ±Infinity.
export function sum(xs) {
    let s = 0;
    for (const x of xs)
        s += x;
    return s;
}
/** Arithmetic mean; 0 for []. */
export function mean(xs) {
    return xs.length ? sum(xs) / xs.length : 0;
}
/** Sample standard deviation (n − 1 denominator); 0 when n < 2. */
export function sampleStd(xs) {
    const n = xs.length;
    if (n < 2)
        return 0;
    const m = mean(xs);
    let s = 0;
    for (const x of xs)
        s += (x - m) ** 2;
    return Math.sqrt(s / (n - 1));
}
/** Median (average of the two middle values for even n); 0 for []. Does not mutate. */
export function median(xs) {
    const n = xs.length;
    if (n === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** Nearest-rank quantile: sorted[ceil(p·n) − 1], clamped to [0, n − 1]; 0 for []. Does not mutate. */
export function quantile(xs, p) {
    const n = xs.length;
    if (n === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const k = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return s[k];
}
/** Population central moments m2, m3, m4 (divided by n). */
function centralMoments(xs) {
    const n = xs.length;
    if (n === 0)
        return { m2: 0, m3: 0, m4: 0 };
    const m = mean(xs);
    let m2 = 0;
    let m3 = 0;
    let m4 = 0;
    for (const x of xs) {
        const d = x - m;
        const d2 = d * d;
        m2 += d2;
        m3 += d2 * d;
        m4 += d2 * d2;
    }
    return { m2: m2 / n, m3: m3 / n, m4: m4 / n };
}
/** Population skewness m3 / m2^1.5; 0 when m2 = 0. */
export function skew(xs) {
    const { m2, m3 } = centralMoments(xs);
    return m2 > 0 ? m3 / m2 ** 1.5 : 0;
}
/** Population excess kurtosis m4 / m2² − 3; 0 when m2 = 0. */
export function exKurt(xs) {
    const { m2, m4 } = centralMoments(xs);
    return m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
}
/**
 * Wilson score interval:
 * (p̂ + z²/2n ± z√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n). null when n = 0.
 * Clamped to [0, 1]: for p̂ = 0 (or 1) the exact bound is 0 (or 1) but rounding
 * in centre − half leaves a ±1e-17 residue (wilson(0, 10)[0] was −2e-17).
 */
export function wilson(wins, n, z = 1.96) {
    if (!(n > 0))
        return null;
    const p = wins / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}
/**
 * Expected longest win / loss streaks in n trades with win probability p
 *: log_{1/p}(n(1−p)) and log_{1/(1−p)}(n·p). 0 when p ∈ {0, 1} or
 * n = 0, and clamped at 0 when the log argument is below 1.
 */
export function expectedStreaks(p, n) {
    if (!(n > 0) || !(p > 0) || !(p < 1))
        return { expW: 0, expL: 0 };
    const expW = Math.log(n * (1 - p)) / Math.log(1 / p);
    const expL = Math.log(n * p) / Math.log(1 / (1 - p));
    return { expW: Math.max(0, expW), expL: Math.max(0, expL) };
}
/**
 * P(at least one run of ≥ k consecutive losses in n trades), loss probability q.
 * State DP over the trailing-loss count 0..k−1; reaching k absorbs.
 */
export function pRunAtLeast(k, n, q) {
    if (k <= 0)
        return 1;
    if (!(n >= k) || !(q > 0))
        return 0;
    if (q >= 1)
        return 1;
    let state = new Array(k).fill(0);
    state[0] = 1; // no losses yet
    let absorbed = 0;
    for (let t = 0; t < n; t++) {
        const next = new Array(k).fill(0);
        for (let j = 0; j < k; j++) {
            const mass = state[j];
            if (mass === 0)
                continue;
            next[0] = next[0] + mass * (1 - q); // a win (or breakeven) resets the streak
            if (j + 1 === k)
                absorbed += mass * q; // k-th consecutive loss → run achieved
            else
                next[j + 1] = next[j + 1] + mass * q;
        }
        state = next;
    }
    return absorbed;
}
export function roundCents(v) {
    return Math.round(v * 100) / 100;
}
