const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const EMPTY = '--';

export const fmtInt = (n: number | undefined) => (n === undefined ? EMPTY : integer.format(n));
export const fmtMicros = (n: number | undefined) => (n === undefined ? EMPTY : oneDecimal.format(n));
export const fmtPercent = (ratio: number | undefined) =>
  ratio === undefined ? EMPTY : `${oneDecimal.format(ratio * 100)}%`;
export const fmtSeconds = (n: number | undefined) => (n === undefined ? EMPTY : twoDecimal.format(n));

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss in the viewer's local time zone. */
export function fmtDateTime(ms: number | undefined): string {
  if (ms === undefined) return EMPTY;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** How long ago something happened, in the largest sensible unit. */
export function fmtAge(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return EMPTY;
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${integer.format(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${integer.format(hours)} h ago`;
  return `${integer.format(Math.round(hours / 24))} days ago`;
}

const threeSig = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });

/** CPU seconds over a time range, as the share of one core kept busy for that whole range. */
export function fmtCoreShare(cpuSeconds: number | undefined, rangeSeconds: number): string {
  if (cpuSeconds === undefined || rangeSeconds <= 0) return EMPTY;
  const share = (cpuSeconds / rangeSeconds) * 100;
  return `${share >= 10 ? oneDecimal.format(share) : threeSig.format(share)}% of one core`;
}
