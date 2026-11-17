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
