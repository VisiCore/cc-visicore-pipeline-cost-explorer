import {
  Alert,
  Breadcrumb,
  Breadcrumbs,
  Button,
  PageHeader,
  Progress,
  SelectField,
  Tag,
  Text,
  TextField,
  ToggleButtonGroup,
} from '@capra/core';
import { ClockOutlined } from '@capra/icons';
import { RANGES, useAppData } from '../state/AppData';
import type { RangeKey } from '../lib/types';

const RANGE_NAMES: Record<RangeKey, string> = {
  '1h': 'Last 1 hour',
  '6h': 'Last 6 hours',
  '12h': 'Last 12 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

function HeaderControls() {
  const { groups, groupId, setGroupId, range, setRange } = useAppData();
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
      <div className="header-range">
        <TextField
          aria-label="Time range"
          size="sm"
          readOnly
          value={RANGE_NAMES[range]}
          leadingSlot={<ClockOutlined />}
        />
      </div>
      <Tag>Local</Tag>
      <ToggleButtonGroup
        aria-label="Quick time ranges"
        size="sm"
        disallowEmptySelection
        selectedKeys={new Set([range])}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as RangeKey | undefined;
          if (next) setRange(next);
        }}
        items={RANGES.map((r) => ({ key: r.key, text: r.key }))}
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
  const { error, warnings, trafficError, reload, profiling, cancelProfiling } = useAppData();
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
