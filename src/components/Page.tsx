import { useState } from 'react';
import {
  Alert,
  Breadcrumb,
  Breadcrumbs,
  Button,
  IconButton,
  PageHeader,
  Popover,
  Progress,
  SelectField,
  Tag,
  Text,
  TextField,
  ToggleButtonGroup,
} from '@capra/core';
import { ChevronDown, ClockOutlined } from '@capra/icons';
import { useAppData } from '../state/AppData';
import { RangePicker } from './RangePicker';
import { QUICK_RANGES, quickKey, quickRange, rangeLabel } from '../lib/timeRange';

function HeaderControls() {
  const { groups, groupId, setGroupId, range, setRange } = useAppData();
  // The picker has no way to be closed from inside, so applying a range remounts it shut.
  const [pickerKey, setPickerKey] = useState(0);
  const active = quickKey(range);
  return (
    <div className="header-controls">
      <div className="header-group">
        <SelectField
          aria-label="Worker Group or Fleet"
          placeholder="Select a Worker Group"
          size="sm"
          canSearch={groups.length > 8}
          items={groups.map((g) => ({ id: g.id, label: g.id, description: g.type === 'edge' ? 'Fleet' : 'Worker Group' }))}
          value={groupId ?? null}
          onChange={(key) => key !== null && setGroupId(String(key))}
        />
      </div>
      <Popover
        key={pickerKey}
        content={
          <RangePicker
            range={range}
            onApply={(next) => {
              setRange(next);
              setPickerKey((k) => k + 1);
            }}
          />
        }
      >
        <div className="header-range">
          <div className={range.kind === 'absolute' ? 'header-range-field wide' : 'header-range-field'}>
            <TextField
              aria-label="Time range"
              size="sm"
              readOnly
              value={rangeLabel(range)}
              leadingSlot={<ClockOutlined />}
            />
          </div>
          <IconButton icon={ChevronDown} aria-label="Change the time range" size="sm" variant="secondary" />
        </div>
      </Popover>
      <Tag>Local</Tag>
      <ToggleButtonGroup
        aria-label="Quick time ranges"
        size="sm"
        selectedKeys={new Set(active ? [active] : [])}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          // Deselecting the active range is not a choice; a custom range leaves none selected.
          if (next !== undefined) setRange(quickRange(String(next)));
        }}
        items={QUICK_RANGES.map((token) => ({ key: token, text: token }))}
      />
    </div>
  );
}

/** Standard page frame: fixed PageHeader, then a scrolling 12-column grid. */
export function Page({
  title,
  parent,
  parents = parent ? [parent] : [],
  children,
}: {
  title: string;
  /** The list page this page was drilled into from; shown as a breadcrumb link. */
  parent?: { label: string; href: string };
  /** The full trail above this page, outermost first, when it is more than one level deep. */
  parents?: { label: string; href: string }[];
  children: React.ReactNode;
}) {
  const { error, warnings, trafficError, trafficUnknown, groups, groupId, reload, profiling, cancelProfiling } =
    useAppData();
  const isFleet = groups.find((g) => g.id === groupId)?.type === 'edge';
  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs>
            {parents.map((p) => (
              <Breadcrumb key={p.href} href={p.href}>
                {p.label}
              </Breadcrumb>
            ))}
            <Breadcrumb>{title}</Breadcrumb>
          </Breadcrumbs>
        }
        actions={<HeaderControls />}
      />
      <div className="page-scroll">
        <div className="page-grid">
          {error && (
            <div className="span-12">
              <Alert appearance="danger" title="Pipelines could not be loaded" action={{ label: 'Retry', onClick: reload }}>
                {error}
              </Alert>
            </div>
          )}
          {!error && trafficError && (
            <div className="span-12">
              <Alert appearance="warning" title="Throughput metrics are unavailable">
                {`Event counts and CPU time estimates are hidden. ${trafficError}`}
              </Alert>
            </div>
          )}
          {!error && !trafficError && trafficUnknown && (
            <div className="span-12">
              <Alert appearance="info" title="Event counts are not available for this group">
                {`${isFleet ? 'Fleets do not report pipeline event counts to the Leader' : 'No pipeline event counts were reported for the selected time range'}, so traffic, CPU time estimates, and discarded-output checks are empty. Configuration findings and per-event timings still work.`}
              </Alert>
            </div>
          )}
          {!error && warnings.length > 0 && (
            <div className="span-12">
              <Alert appearance="warning" title="Some pipelines were skipped" onDismiss>
                {warnings.slice(0, 3).join(' · ') + (warnings.length > 3 ? ` · and ${warnings.length - 3} more` : '')}
              </Alert>
            </div>
          )}
          {profiling && (
            <div className="span-12 profiling-bar" role="status" aria-live="polite">
              <div className="profiling-bar-text">
                <Text variant="body-sm-semibold">
                  {`Profiling ${profiling.current} (${profiling.done + 1} of ${profiling.total})`}
                </Text>
                <Progress
                  aria-label="Profiling progress"
                  size="sm"
                  value={Math.round((profiling.done / profiling.total) * 100)}
                />
              </div>
              <Button variant="secondary" size="sm" onClick={cancelProfiling}>
                Stop
              </Button>
            </div>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
