import { Card, Tag, Text, type TagColor } from '@capra/core';
import type { Severity } from '../lib/types';
import { EMPTY } from '../lib/format';

const SEVERITY_COLOR: Record<Severity, TagColor> = { high: 'danger', medium: 'warning', low: 'info' };
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function SeverityTag({ severity, count }: { severity: Severity | 'none'; count?: number }) {
  if (severity === 'none') return <>{EMPTY}</>;
  const label = SEVERITY_LABEL[severity];
  return (
    <Tag size="sm" color={SEVERITY_COLOR[severity]}>
      {count && count > 1 ? `${label} (${count})` : label}
    </Tag>
  );
}

export function MetricCard({
  label,
  value,
  note,
  noteColor,
  drill,
}: {
  label: string;
  value: string;
  note?: string;
  noteColor?: TagColor;
  /** When set, the label becomes a control that opens the list behind the number. */
  drill?: { label: string; onClick: () => void };
}) {
  return (
    <Card>
      <Card.Content>
        <div className="metric-card">
          {drill ? (
            <div>
              <LinkButton label={drill.label} onClick={drill.onClick}>
                {label}
              </LinkButton>
            </div>
          ) : (
            <Text variant="body-sm-normal" color="subtle">
              {label}
            </Text>
          )}
          <Text variant="metric-md">{value}</Text>
          {note && (
            <div>
              <Tag size="sm" color={noteColor ?? 'default'}>
                {note}
              </Tag>
            </div>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}

export interface Sort {
  column: string | number;
  direction: 'ascending' | 'descending';
}

/** Sorts by a column; missing values always sort last regardless of direction. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], sort: Sort | undefined): T[] {
  if (!sort) return rows;
  const dir = sort.direction === 'ascending' ? 1 : -1;
  const key = String(sort.column);
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const xMissing = x === undefined || x === null || x === '';
    const yMissing = y === undefined || y === null || y === '';
    if (xMissing || yMissing) return xMissing === yMissing ? 0 : xMissing ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
  });
}

/**
 * A link-styled control that acts in place (opens a drawer) rather than navigating. A native button
 * styled from tokens, so no class is applied to a Capra component.
 */
export function LinkButton({ children, label, onClick }: { children: string; label?: string; onClick: () => void }) {
  return (
    <button type="button" className="link-button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="code-block">
      <Text variant="code">{children}</Text>
    </pre>
  );
}

/** Keeps a page number inside the range that exists for the current row count. */
export function clampPage(page: number, rowCount: number, pageSize: number): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(rowCount / pageSize)));
}
