import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  BooleanPillter,
  Button,
  defineColumns,
  Drawer,
  EmptyState,
  Pagination,
  Link,
  Table,
  Text,
  TextField,
} from '@capra/core';
import { FilterOutlined, Play } from '@capra/icons';
import { Page } from '../components/Page';
import { clampPage, CodeBlock, MetricCard, RatingTag, sortRows, type Sort } from '../components/shared';
import { useAppData, type PipelineRow, type ProfileRequest } from '../state/AppData';
import { CAPTURE_SECONDS } from '../lib/api';
import { EMPTY, fmtAge, fmtCoreShare, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { listQuery, pipelineHref, useParamList } from '../lib/useParamList';

const PAGE_SIZE = 25;

export function Pipelines() {
  const {
    isLoading,
    error,
    pipelineRows,
    samplesError,
    trafficError,
    trafficUnknown,
    rangeSeconds,
    reload,
    profiling,
    runProfiles,
    profiledCount,
  } = useAppData();
  const navigate = useNavigate();
  // Toggle filters live in the URL so Overview can link straight to a filtered list.
  const [show, setShow] = useParamList('show');
  const [filter, setFilter] = useState('');
  const trafficOnly = show.includes('traffic');
  const unprofiledOnly = show.includes('unprofiled');
  const profiledOnly = show.includes('profiled');
  const discardedOnly = show.includes('discarded');
  const inefficientOnly = show.includes('inefficient');
  const toggle = (flag: string, excludes?: string) =>
    setShow(show.includes(flag) ? show.filter((f) => f !== flag) : [...show.filter((f) => f !== excludes), flag]);
  // Least efficient first, costliest within each rating, so the first screen is the pipelines to act on.
  const [sort, setSort] = useState<Sort | undefined>({ column: 'ratingScore', direction: 'descending' });
  const [pageState, setPage] = useState(1);
  const [batchOpen, setBatchOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = pipelineRows.filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q) || p.pack.toLowerCase().includes(q)) &&
        (!trafficOnly || (p.inEvents ?? 0) > 0) &&
        (!unprofiledOnly || p.profiledAt === undefined) &&
        (!profiledOnly || p.profiledAt !== undefined) &&
        (!discardedOnly || ((p.discardedShare ?? 0) >= 0.5 && p.functionCount > 0)) &&
        (!inefficientOnly || p.rating === 'inefficient' || p.rating === 'review'),
    );
    return sortRows(rows, sort);
  }, [pipelineRows, filter, trafficOnly, unprofiledOnly, profiledOnly, discardedOnly, inefficientOnly, sort]);

  // Rows can disappear under the current page (group switch, a filter that profiling empties).
  const page = clampPage(pageState, filtered.length, PAGE_SIZE);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const resetPage = () => setPage(1);

  // "Profile matched" covers unprofiled pipelines that are receiving events and have something to
  // profile with: a live capture worked out from how the pipeline is wired in, or failing that a saved sample.
  // When throughput is unknown, traffic can't be confirmed, so only saved samples are used.
  const batch = pipelineRows.filter(
    (p) =>
      p.functionCount > 0 &&
      p.profiledAt === undefined &&
      (trafficError ? !!p.sampleId : (p.inEvents ?? 0) > 0 && (!!p.capture || !!p.sampleId)),
  );
  const batchRequests: ProfileRequest[] = batch.map((p) => ({
    pipelineKey: p.id,
    capture: trafficError ? undefined : p.capture,
    sampleKey: p.sampleId,
  }));
  const captureCount = batchRequests.filter((r) => r.capture).length;
  const withTraffic = pipelineRows.filter((p) => (p.inEvents ?? 0) > 0).length;
  const withCpu = pipelineRows.filter((p) => p.cpuSeconds !== undefined);
  const totalCpu = withCpu.reduce((n, p) => n + (p.cpuSeconds ?? 0), 0);

  const columns = useMemo(
    () =>
      defineColumns<PipelineRow>([
        {
          id: 'name',
          label: 'Pipeline',
          allowsSorting: true,
          render: (_v, item) => (
            <div className="name-cell">
              <Link href={pipelineHref(item.id)}>{item.name}</Link>
              {item.pack && (
                <Text variant="body-sm-normal" color="subtle">
                  {item.pack}
                </Text>
              )}
            </div>
          ),
        },
        {
          id: 'ratingScore',
          label: 'Rating',
          allowsSorting: true,
          render: (_v, item) => (item.functionCount === 0 ? EMPTY : <RatingTag rating={item.rating} />),
        },
        {
          id: 'ratingReasons',
          label: 'Why',
          render: (_v, item) =>
            item.ratingReasons.length === 0 ? (
              EMPTY
            ) : (
              <span className="nowrap">
                {item.ratingReasons.length === 1
                  ? item.ratingReasons[0]
                  : `${item.ratingReasons[0]} (+${item.ratingReasons.length - 1} more)`}
              </span>
            ),
        },
        {
          id: 'findingCount',
          label: 'Findings',
          allowsSorting: true,
          render: (v, item) =>
            (v as number) > 0 ? (
              <Link href={`/functions${listQuery({ pipeline: [item.id], severity: ['high', 'medium', 'low'] })}`}>
                {fmtInt(v as number)}
              </Link>
            ) : (
              fmtInt(v as number)
            ),
        },
        { id: 'inEvents', label: 'Events in', allowsSorting: true, render: (v) => fmtInt(v as number | undefined) },
        { id: 'outEvents', label: 'Events out', allowsSorting: true, render: (v) => fmtInt(v as number | undefined) },
        {
          id: 'usPerEvent',
          label: 'Cost per event (µs)',
          allowsSorting: true,
          render: (v) => fmtMicros(v as number | undefined),
        },
        {
          id: 'cpuSeconds',
          label: 'CPU time (s)',
          allowsSorting: true,
          render: (v) => fmtSeconds(v as number | undefined),
        },
        {
          id: 'discardedShare',
          label: 'Discarded downstream',
          allowsSorting: true,
          render: (v) => fmtPercent(v as number | undefined),
        },
        {
          id: 'profiledAt',
          label: 'Profiled',
          allowsSorting: true,
          render: (v) => (v === undefined ? EMPTY : <span className="nowrap">{fmtAge(v as number)}</span>),
        },
      ]),
    [],
  );

  return (
    <Page title="Pipelines">
      <div className="span-4">
        <MetricCard
          label="Pipelines receiving events"
          value={isLoading ? '--' : trafficUnknown ? 'Unknown' : `${fmtInt(withTraffic)} of ${fmtInt(pipelineRows.length)}`}
        />
      </div>
      <div className="span-4">
        <MetricCard
          label="Profiled pipelines"
          value={isLoading ? '--' : `${fmtInt(profiledCount)} of ${fmtInt(pipelineRows.length)}`}
        />
      </div>
      <div className="span-4">
        <MetricCard
          label="Estimated CPU time, profiled pipelines"
          value={isLoading || withCpu.length === 0 ? '--' : `${fmtSeconds(totalCpu)} s`}
          note={isLoading || withCpu.length === 0 ? undefined : fmtCoreShare(totalCpu, rangeSeconds)}
        />
      </div>

      <div className="span-12">
        <div className="filter-bar">
          <div className="filter-input">
            <TextField
              aria-label="Filter pipelines"
              placeholder="Filter pipelines"
              leadingSlot={<FilterOutlined />}
              value={filter}
              onChange={(v) => {
                setFilter(v);
                resetPage();
              }}
            />
          </div>
          <BooleanPillter
            label="Has traffic"
            checked={trafficOnly}
            onPress={() => {
              toggle('traffic');
              resetPage();
            }}
          />
          <BooleanPillter
            label="Inefficient or to review"
            checked={inefficientOnly}
            onPress={() => {
              toggle('inefficient');
              resetPage();
            }}
          />
          <BooleanPillter
            label="Not profiled"
            checked={unprofiledOnly}
            onPress={() => {
              toggle('unprofiled', 'profiled');
              resetPage();
            }}
          />
          <BooleanPillter
            label="Profiled"
            checked={profiledOnly}
            onPress={() => {
              toggle('profiled', 'unprofiled');
              resetPage();
            }}
          />
          <BooleanPillter
            label="Output discarded"
            checked={discardedOnly}
            onPress={() => {
              toggle('discarded');
              resetPage();
            }}
          />
          <div className="filter-bar-actions">
            <Button
              variant="primary"
              leadingIcon={Play}
              disabled={batch.length === 0 || !!profiling || isLoading}
              onClick={() => setBatchOpen(true)}
            >
              {`Profile matched (${batch.length})`}
            </Button>
          </div>
        </div>
        {samplesError && (
          <Alert
            appearance="warning"
            title="Samples could not be loaded"
            action={{ label: 'Retry', onClick: reload }}
          >
            {`Pipelines can't be profiled until the sample list loads. ${samplesError}`}
          </Alert>
        )}
        {!isLoading && !error && pipelineRows.length > 0 && filtered.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            title="No pipelines match these filters"
            description="Clear a filter to see more pipelines."
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFilter('');
                navigate('/pipelines', { replace: true });
              }}
            >
              Clear filters
            </Button>
          </EmptyState>
        ) : !isLoading && !error && pipelineRows.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            title="No pipelines"
            description="This group has no pipelines to analyze."
          />
        ) : (
          <>
            <div className="table-wrap">
            <Table
              aria-label="Pipelines"
              columns={columns}
              visibleColumns={[
                'name',
                'ratingScore',
                'ratingReasons',
                'findingCount',
                'inEvents',
                'usPerEvent',
                'cpuSeconds',
                'discardedShare',
                'profiledAt',
              ]}
              items={pageRows}
              isLoading={isLoading}
              sortDescriptor={sort}
              onSortChange={(s) => {
                setSort(s);
                resetPage();
              }}
            />
            </div>
            {filtered.length > PAGE_SIZE && (
              <div className="table-footer">
                <Pagination
                  aria-label="Pipelines pagination"
                  total={filtered.length}
                  current={page}
                  pageSize={PAGE_SIZE}
                  onChange={(p) => setPage(p)}
                />
              </div>
            )}
          </>
        )}
      </div>

      <Drawer
        isOpen={batchOpen}
        onClose={() => setBatchOpen(false)}
        title={`Profile ${batch.length} ${batch.length === 1 ? 'pipeline' : 'pipelines'}`}
        width={520}
        footer={
          <div className="drawer-footer">
            <Button variant="tertiary" onClick={() => setBatchOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              leadingIcon={Play}
              disabled={batch.length === 0 || !!profiling}
              onClick={() => {
                setBatchOpen(false);
                void runProfiles(batchRequests);
              }}
            >
              Run profiles
            </Button>
          </div>
        }
      >
        <div className="drawer-stack">
          <Text>
            {captureCount > 0
              ? `Pipelines are profiled one at a time. ${captureCount === batch.length ? 'Each' : `${fmtInt(captureCount)} of them`} first captures live events from the Workers for ${CAPTURE_SECONDS} seconds (longer for pipelines that keep state between events) using the filter shown, which is built from the routes and Sources that feed the pipeline. If a capture comes back empty and the pipeline has a saved sample, the sample is used.`
              : 'Pipelines are profiled one at a time with the saved sample shown. Samples were matched by name unless you chose one.'}
          </Text>
          <Text color="subtle">
            To use a different filter or sample for a pipeline, cancel and profile it on its own from its page.
          </Text>
          <dl className="batch-list">
            {batch.map((p) => (
              <Fragment key={p.id}>
                <dt>
                  <Text variant="body-md-semibold">{p.pack ? `${p.pack} / ${p.name}` : p.name}</Text>
                </dt>
                <dd>
                  {!trafficError && p.capture ? (
                    <>
                      <Text color="subtle">
                        {p.capture.through
                          ? `Live capture, then run through ${p.capture.through.label}`
                          : p.capture.level === 0
                            ? 'Live capture at the Source'
                            : p.capture.level === 2
                              ? 'Live capture between pipeline stages'
                              : 'Live capture before routing'}
                      </Text>
                      <CodeBlock>{p.capture.filter}</CodeBlock>
                      {p.sampleName && <Text color="subtle">{`If empty: ${p.sampleName}`}</Text>}
                    </>
                  ) : (
                    <Text color="subtle">{`Saved sample: ${p.sampleName ?? EMPTY}`}</Text>
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </Drawer>
    </Page>
  );
}
