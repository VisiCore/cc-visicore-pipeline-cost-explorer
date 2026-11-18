import { fmtDateTime } from './format';

/**
 * The time window the app's event counts and CPU estimates cover. A relative range moves with the
 * clock ("the last 24 hours"); an absolute one is pinned to two instants.
 */
export type TimeRange =
  | { kind: 'relative'; earliest: string; latest: string }
  | { kind: 'absolute'; from: number; to: number };

/** The quick ranges shown in the page header, shortest first. */
export const QUICK_RANGES = ['1h', '6h', '12h', '24h', '7d'] as const;

export const quickRange = (token: string): TimeRange => ({ kind: 'relative', earliest: `-${token}`, latest: 'now' });

export const DEFAULT_RANGE = quickRange('24h');

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_NAME: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week' };
const RELATIVE = /^\s*(now|-(\d+)([smhdw]))\s*(?:@([smhdw]))?\s*$/;

/** Rounds a time down to the start of its second, minute, hour, day, or week, in local time. */
function snap(ms: number, unit: string): number {
  const d = new Date(ms);
  if (unit === 's') d.setMilliseconds(0);
  if (unit === 'm') d.setSeconds(0, 0);
  if (unit === 'h') d.setMinutes(0, 0, 0);
  if (unit === 'd' || unit === 'w') d.setHours(0, 0, 0, 0);
  if (unit === 'w') d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

/**
 * A relative time expression as an instant: `now`, or an offset such as `-90m`, optionally snapped
 * to the start of a unit (`-1d@d` is the start of yesterday). Undefined when it can't be read.
 */
export function parseRelative(expr: string, now = Date.now()): number | undefined {
  const m = RELATIVE.exec(expr);
  if (!m) return undefined;
  const at = m[1] === 'now' ? now : now - Number(m[2]) * UNIT_MS[m[3]];
  return m[4] ? snap(at, m[4]) : at;
}

/** The window as two instants, or undefined when it is not a valid, non-empty window. */
export function resolveRange(range: TimeRange, now = Date.now()): { earliest: number; latest: number } | undefined {
  const earliest = range.kind === 'absolute' ? range.from : parseRelative(range.earliest, now);
  const latest = range.kind === 'absolute' ? range.to : parseRelative(range.latest, now);
  if (earliest === undefined || latest === undefined || !(earliest < latest)) return undefined;
  return { earliest, latest };
}

/** The quick-range token a range corresponds to, if any. */
export function quickKey(range: TimeRange): string | undefined {
  if (range.kind !== 'relative' || range.latest.trim() !== 'now') return undefined;
  return QUICK_RANGES.find((token) => range.earliest.trim() === `-${token}`);
}

/** How the range reads in the page header. */
export function rangeLabel(range: TimeRange): string {
  if (range.kind === 'absolute') return `${fmtDateTime(range.from)} - ${fmtDateTime(range.to)}`;
  const m = RELATIVE.exec(range.earliest);
  if (range.latest.trim() === 'now' && m && m[1] !== 'now' && !m[4]) {
    const n = Number(m[2]);
    return `Last ${n} ${UNIT_NAME[m[3]]}${n === 1 ? '' : 's'}`;
  }
  return `${range.earliest.trim()} to ${range.latest.trim()}`;
}

/** Reads a stored range, including the bare tokens (`24h`) earlier versions saved. */
export function normalizeRange(value: unknown): TimeRange | undefined {
  if (typeof value === 'string') return /^\d+[smhdw]$/.test(value) ? quickRange(value) : undefined;
  const v = value as Partial<{ kind: string; earliest: unknown; latest: unknown; from: unknown; to: unknown }> | null;
  const range: TimeRange | undefined =
    v?.kind === 'relative' && typeof v.earliest === 'string' && typeof v.latest === 'string'
      ? { kind: 'relative', earliest: v.earliest, latest: v.latest }
      : v?.kind === 'absolute' && typeof v.from === 'number' && typeof v.to === 'number'
        ? { kind: 'absolute', from: v.from, to: v.to }
        : undefined;
  return range && resolveRange(range) ? range : undefined;
}
