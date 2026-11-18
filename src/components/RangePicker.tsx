import { useState } from 'react';
import { Button, DatePickerField, Text, TextField, ToggleButtonGroup } from '@capra/core';
import { CalendarDateTime, getLocalTimeZone, toCalendarDateTime, fromDate } from '@internationalized/date';
import { parseRelative, quickRange, resolveRange, type TimeRange } from '../lib/timeRange';

/** Quick selections in the picker's left rail, grouped by unit. */
const QUICK_GROUPS: { unit: string; rows: { token: string; label: string }[] }[] = [
  {
    unit: 'Minutes',
    rows: [
      { token: '15m', label: 'Last 15 minutes' },
      { token: '30m', label: 'Last 30 minutes' },
    ],
  },
  {
    unit: 'Hours',
    rows: [
      { token: '1h', label: 'Last 1 hour' },
      { token: '4h', label: 'Last 4 hours' },
      { token: '6h', label: 'Last 6 hours' },
      { token: '12h', label: 'Last 12 hours' },
      { token: '24h', label: 'Last 24 hours' },
    ],
  },
  {
    unit: 'Days',
    rows: [
      { token: '2d', label: 'Last 2 days' },
      { token: '7d', label: 'Last 7 days' },
      { token: '14d', label: 'Last 14 days' },
      { token: '30d', label: 'Last 30 days' },
    ],
  },
];

type Tab = 'relative' | 'absolute';

const zone = getLocalTimeZone();
const toField = (ms: number) => toCalendarDateTime(fromDate(new Date(ms), zone));
const fromField = (value: CalendarDateTime | null) => value?.toDate(zone).getTime();

/** "America/New_York (EDT)" for the viewer's own time zone. */
function zoneName(): string {
  const short = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${zone.replace(/_/g, ' ')}${short ? ` (${short})` : ''}`;
}

/** The body of the time range dropdown: quick selections, and a relative or absolute custom range. */
export function RangePicker({ range, onApply }: { range: TimeRange; onApply: (next: TimeRange) => void }) {
  const current = resolveRange(range) ?? resolveRange(quickRange('24h'))!;
  // Opens on the tab that matches how the current range is expressed.
  const [tab, setTab] = useState<Tab>(range.kind);
  const [earliest, setEarliest] = useState(range.kind === 'relative' ? range.earliest : '-24h');
  const [latest, setLatest] = useState(range.kind === 'relative' ? range.latest : 'now');
  const [from, setFrom] = useState<CalendarDateTime | null>(toField(current.earliest));
  const [to, setTo] = useState<CalendarDateTime | null>(toField(current.latest));

  const earliestBad = earliest.trim() !== '' && parseRelative(earliest) === undefined;
  const latestBad = latest.trim() !== '' && parseRelative(latest) === undefined;
  const fromMs = fromField(from);
  const toMs = fromField(to);
  const candidate: TimeRange | undefined =
    tab === 'relative'
      ? { kind: 'relative', earliest: earliest.trim(), latest: latest.trim() }
      : fromMs !== undefined && toMs !== undefined
        ? { kind: 'absolute', from: fromMs, to: toMs }
        : undefined;
  const valid = !!candidate && !!resolveRange(candidate);
  const backwards =
    tab === 'relative'
      ? !earliestBad && !latestBad && earliest.trim() !== '' && latest.trim() !== '' && !valid
      : fromMs !== undefined && toMs !== undefined && !valid;

  return (
    <div className="range-picker">
      <div className="range-rail">
        {QUICK_GROUPS.map((group) => (
          <div key={group.unit} className="range-group">
            <Text variant="body-sm-semibold" color="subtle">
              {group.unit}
            </Text>
            {group.rows.map((row) => (
              <button key={row.token} type="button" className="range-row" onClick={() => onApply(quickRange(row.token))}>
                <span>{row.label}</span>
                <span className="range-token">{`-${row.token}`}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="range-panel">
        <div>
          <ToggleButtonGroup
            aria-label="How to set the range"
            size="sm"
            disallowEmptySelection
            selectedKeys={new Set([tab])}
            onSelectionChange={(keys) => {
              const next = [...keys][0] as Tab | undefined;
              if (next) setTab(next);
            }}
            items={[
              { key: 'relative', text: 'Relative' },
              { key: 'absolute', text: 'Date range' },
            ]}
          />
        </div>

        {tab === 'relative' ? (
          <>
            <TextField
              label="Earliest"
              appearance={earliestBad ? 'danger' : 'default'}
              helperText={earliestBad ? 'Use an offset such as -90m or -2d@d.' : 'An offset back from now, such as -90m, -2d, or -1d@d.'}
              value={earliest}
              onChange={setEarliest}
            />
            <TextField
              label="Latest"
              appearance={latestBad ? 'danger' : 'default'}
              helperText={latestBad ? 'Use now, or an offset such as -1h.' : 'now, or an offset such as -1h. Add @h or @d to snap to the start of the hour or day.'}
              value={latest}
              onChange={setLatest}
            />
          </>
        ) : (
          <>
            <DatePickerField
              label="From"
              granularity="second"
              value={from}
              onChange={(v) => setFrom(v as CalendarDateTime | null)}
            />
            <DatePickerField
              label="To"
              granularity="second"
              value={to}
              onChange={(v) => setTo(v as CalendarDateTime | null)}
            />
          </>
        )}
        {backwards && <Text color="subtle">The earliest time must be before the latest.</Text>}

        <div className="range-footer">
          <div className="range-zone">
            <Text variant="body-sm-semibold">Local</Text>
            <Text variant="body-sm-normal" color="subtle">
              {zoneName()}
            </Text>
          </div>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => candidate && onApply(candidate)}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
