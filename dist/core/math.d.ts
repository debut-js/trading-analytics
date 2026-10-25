export declare function sum(xs: number[]): number;
/** Arithmetic mean; 0 for []. */
export declare function mean(xs: number[]): number;
/** Sample standard deviation (n − 1 denominator); 0 when n < 2. */
export declare function sampleStd(xs: number[]): number;
/** Median (average of the two middle values for even n); 0 for []. Does not mutate. */
export declare function median(xs: number[]): number;
/** Nearest-rank quantile: sorted[ceil(p·n) − 1], clamped to [0, n − 1]; 0 for []. Does not mutate. */
export declare function quantile(xs: number[], p: number): number;
/** Population skewness m3 / m2^1.5; 0 when m2 = 0. */
export declare function skew(xs: number[]): number;
/** Population excess kurtosis m4 / m2² − 3; 0 when m2 = 0. */
export declare function exKurt(xs: number[]): number;
/**
 * Wilson score interval:
 * (p̂ + z²/2n ± z√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n). null when n = 0.
 * Clamped to [0, 1]: for p̂ = 0 (or 1) the exact bound is 0 (or 1) but rounding
 * in centre − half leaves a ±1e-17 residue (wilson(0, 10)[0] was −2e-17).
 */
export declare function wilson(wins: number, n: number, z?: number): [number, number] | null;
/**
 * Expected longest win / loss streaks in n trades with win probability p
 *: log_{1/p}(n(1−p)) and log_{1/(1−p)}(n·p). 0 when p ∈ {0, 1} or
 * n = 0, and clamped at 0 when the log argument is below 1.
 */
export declare function expectedStreaks(p: number, n: number): {
    expW: number;
    expL: number;
};
/**
 * P(at least one run of ≥ k consecutive losses in n trades), loss probability q.
 * State DP over the trailing-loss count 0..k−1; reaching k absorbs.
 */
export declare function pRunAtLeast(k: number, n: number, q: number): number;
export declare function roundCents(v: number): number;
