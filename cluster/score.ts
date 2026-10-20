export type ScoreInput = { est_traffic: number | null; kd: number | null; fit: number; gain: number };

export const WEIGHTS = { traffic: 0.35, kd: 0.2, fit: 0.25, gain: 0.2 } as const;

export function score({ est_traffic, kd, fit, gain }: ScoreInput): number {
  const traffic = Math.min(1, Math.log10(1 + Math.max(0, est_traffic ?? 0)) / 4);
  const ease = kd == null ? 0.5 : 1 - Math.min(100, Math.max(0, kd)) / 100;
  const s = WEIGHTS.traffic * traffic + WEIGHTS.kd * ease + WEIGHTS.fit * (fit / 5) + WEIGHTS.gain * (gain / 5);
  return Math.round(s * 1000) / 10;
}

const ctrTop3 = 0.15;

export function estTraffic(rows: { traffic: number | null; volume: number | null }[]): number {
  const competitor = rows.reduce((s, r) => s + (r.traffic ?? 0), 0);
  const fromVolume = Math.max(0, ...rows.map((r) => r.volume ?? 0)) * ctrTop3;
  return Math.round(Math.max(competitor, fromVolume));
}
