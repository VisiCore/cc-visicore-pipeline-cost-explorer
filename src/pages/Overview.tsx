import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, defineColumns, EmptyState, Link, Skeleton, Table, Tag, Text } from '@capra/core';
import { Page } from '../components/Page';
import { LinkButton, MetricCard, RatingTag } from '../components/shared';
import { useAppData, type FunctionRow, type PipelineRow } from '../state/AppData';
import type { WorkerLoad } from '../lib/types';
import { EMPTY, fmtCoreShare, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { listQuery, pipelineHref, pipelineTestHref } from '../lib/useParamList';

const TOP_PIPELINES = 8;
const TOP_FIXES = 5;
const TOP_FUNCTIONS = 5;

const wholeSeconds = (n: number | undefined) => (n === undefined ? EMPTY : `${fmtInt(Math.round(n))} s`);

export function Overview() {
  const {
    isLoading,
    pipelineRows,
    functionRows,
    profiledCount,
    workerLoad,
    rangeSeconds,
    recommendations,
    trafficUnknown,
  } = useAppData();
  const navigate = useNavigate();
  const openFunction = (row: FunctionRow) => navigate(`/functions?fn=${encodeURIComponent(row.id)}`);

  const stats = useMemo(() => {
    const high = functionRows.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'high').length, 0);
    const medium = functionRows.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'medium').length, 0);

    const costly = functionRows
      .filter((f) => (f.cpuSeconds ?? 0) > 0)
      .sort((a, b) => (b.cpuSeconds ?? 0) - (a.cpuSeconds ?? 0))
      .slice(0, TOP_FUNCTIONS);

    // The pipelines worth ranking: anything that is doing work, or is flagged.
    const ranked = pipelineRows
      .filter((p) => p.functionCount > 0 && p.rating !== 'idle')
      .sort((a, b) => b.ratingScore - a.ratingScore);
    const inefficient = ranked.filter((p) => p.rating === 'inefficient').length;
    const review = ranked.filter((p) => p.rating === 'review').length;

    const working = pipelineRows.filter((p) => p.functionCount > 0 && (p.inEvents ?? 0) > 0);
    const unprofiled = working.filter((p) => p.profiledAt === undefined);
    const pipelineEvents = working.reduce((n, p) => n + (p.inEvents ?? 0), 0);
    const unprofiledEvents = unprofiled.reduce((n, p) => n + (p.inEvents ?? 0), 0);
    const withCpu = pipelineRows.filter((p) => p.cpuSeconds !== undefined);
    const wasted = pipelineRows.filter(
      (p) => (p.discardedShare ?? 0) >= 0.5 && p.functionCount > 0 && (p.inEvents ?? 0) > 0,
    );

    return {
      high,
      medium,
      costly,
      ranked,
      inefficient,
      review,
      unprofiled: unprofiled.length,
      unmeasuredShare: pipelineEvents > 0 ? unprofiledEvents / pipelineEvents : undefined,
      estimatedCpu: withCpu.length ? withCpu.reduce((n, p) => n + (p.cpuSeconds ?? 0), 0) : undefined,
      wastedPipelines: wasted.length,
      wastedCpu: wasted.some((p) => p.wastedCpuSeconds !== undefined)
        ? wasted.reduce((n, p) => n + (p.wastedCpuSeconds ?? 0), 0)
        : undefined,
    };
  }, [functionRows, pipelineRows]);

  const columns = useMemo(
    () =>
      defineColumns<PipelineRow>([
        {
          id: 'name',
          label: 'Pipeline',
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
        { id: 'rating', label: 'Rating', render: (_v, item) => <RatingTag rating={item.rating} /> },
        {
          id: 'ratingReasons',
          label: 'Why',
          render: (_v, item) =>
            item.ratingReasons.length === 0
              ? item.rating === 'unmeasured'
                ? 'Profile it to find out'
                : EMPTY
              : item.ratingReasons.length === 1
                ? item.ratingReasons[0]
                : `${item.ratingReasons[0]} (+${item.ratingReasons.length - 1} more)`,
        },
        { id: 'inEvents', label: 'Events in', render: (v) => fmtInt(v as number | undefined) },
        { id: 'usPerEvent', label: 'Cost per event (µs)', render: (v) => fmtMicros(v as number | undefined) },
        { id: 'cpuSeconds', label: 'CPU time', render: (v) => wholeSeconds(v as number | undefined) },
        {
          id: 'id',
          label: 'Next step',
          render: (_v, item) =>
            item.profiledAt === undefined ? (
              <Button variant="tertiary" size="sm" onClick={() => navigate(pipelineHref(item.id))}>
                Profile
              </Button>
            ) : item.rating === 'efficient' ? (
              EMPTY
            ) : (
              <Button variant="tertiary" size="sm" onClick={() => navigate(pipelineTestHref(item.id))}>
                Test a fix
              </Button>
            ),
        },
      ]),
    [navigate],
  );

  const firstRun = !isLoading && profiledCount === 0 && pipelineRows.length > 0;
  const fixes = recommendations.slice(0, TOP_FIXES);
  const maxCost = stats.costly.length ? (stats.costly[0].cpuSeconds ?? 0) : 0;
  const profilePath = `/pipelines${listQuery({ show: trafficUnknown ? ['unprofiled'] : ['traffic', 'unprofiled'] })}`;

  return (
    <Page title="Overview">
      {!isLoading && !firstRun && (stats.unmeasuredShare ?? 0) > 0.2 && (
        <div className="span-12">
          <Alert
            appearance="info"
            action={{
              label: `Profile ${fmtInt(stats.unprofiled)} ${stats.unprofiled === 1 ? 'pipeline' : 'pipelines'}`,
              onClick: () => navigate(profilePath),
            }}
          >
            {`${fmtPercent(stats.unmeasuredShare)} of traffic isn't measured yet, so the ratings below may change.`}
          </Alert>
        </div>
      )}

      <div className="span-3">
        <MetricCard
          label="Inefficient pipelines"
          value={isLoading ? '--' : fmtInt(stats.inefficient)}
          note={isLoading ? undefined : `${fmtInt(stats.review)} to review`}
          noteColor={stats.review > 0 ? 'warning' : 'default'}
          drill={{
            label: 'View inefficient pipelines',
            onClick: () => navigate(`/pipelines${listQuery({ show: ['inefficient'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Pipeline CPU"
          value={isLoading || stats.estimatedCpu === undefined ? '--' : fmtCoreShare(stats.estimatedCpu, rangeSeconds)}
          note={
            stats.estimatedCpu === undefined ? 'Not measured yet' : `${wholeSeconds(stats.estimatedCpu)}, profiled pipelines`
          }
          drill={{
            label: 'View profiled pipelines',
            onClick: () => navigate(`/pipelines${listQuery({ show: ['profiled'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Wasted on discarded output"
          value={
            isLoading
              ? '--'
              : stats.wastedPipelines === 0
                ? 'None'
                : stats.wastedCpu === undefined
                  ? 'Unknown'
                  : wholeSeconds(stats.wastedCpu)
          }
          note={
            isLoading || stats.wastedPipelines === 0
              ? undefined
              : `${fmtInt(stats.wastedPipelines)} ${stats.wastedPipelines === 1 ? 'pipeline' : 'pipelines'}`
          }
          noteColor="warning"
          drill={{
            label: 'View pipelines whose output is discarded',
            onClick: () => navigate(`/pipelines${listQuery({ show: ['discarded'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Findings"
          value={isLoading ? '--' : `${fmtInt(stats.high)} high`}
          note={isLoading ? undefined : `${fmtInt(stats.medium)} medium`}
          drill={{
            label: 'View functions with findings',
            onClick: () => navigate(`/functions${listQuery({ severity: ['high', 'medium'] })}`),
          }}
        />
      </div>

      {firstRun ? (
        <div className="span-12">
          <EmptyState
            illustration="Hibernating"
            title="Measure your busiest pipelines"
            description="Captures live events and runs them through Cribl's preview to time every function. Nothing is sent to Destinations."
          >
            <Button variant="primary" size="sm" onClick={() => navigate(profilePath)}>
              Profile pipelines
            </Button>
          </EmptyState>
        </div>
      ) : (
        <div className="span-12">
          <Card>
            <Card.Header>
              <Card.Title>Pipeline efficiency</Card.Title>
              <Card.Description>Pipelines doing work in the selected range, least efficient first</Card.Description>
              <Card.Action>
                <Button
                  variant="tertiary"
                  size="sm"
                  onClick={() => navigate(`/pipelines${listQuery({ show: trafficUnknown ? [] : ['traffic'] })}`)}
                >
                  View all
                </Button>
              </Card.Action>
            </Card.Header>
            <Card.Content>
              {!isLoading && stats.ranked.length === 0 ? (
                <EmptyState
                  illustration="Hibernating"
                  title="No pipelines to rate"
                  description="No pipeline with functions received events in the selected range."
                />
              ) : (
                <div className="table-wrap">
                  <Table
                    aria-label="Pipeline efficiency"
                    columns={columns}
                    visibleColumns={['name', 'rating', 'ratingReasons', 'inEvents', 'usPerEvent', 'cpuSeconds', 'id']}
                    items={stats.ranked.slice(0, TOP_PIPELINES)}
                    isLoading={isLoading}
                  />
                </div>
              )}
            </Card.Content>
          </Card>
        </div>
      )}

      <div className="span-6">
        <Card>
          <Card.Header>
            <Card.Title>Top fixes</Card.Title>
            <Card.Description>Specific changes, ranked by the CPU time at stake</Card.Description>
            <Card.Action>
              <Button
                variant="tertiary"
                size="sm"
                onClick={() => navigate(`/functions${listQuery({ severity: ['high', 'medium'] })}`)}
              >
                All findings
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <Skeleton loading title paragraph={{ rows: 4 }} />
            ) : fixes.length === 0 ? (
              <EmptyState
                illustration="Celebration"
                title="No fixes to suggest"
                description="Nothing specific is flagged in this group's pipelines."
              />
            ) : (
              <ul className="rank-list">
                {fixes.map((r) => (
                  <li key={r.id} className="rank-row">
                    <div className="rank-row-main">
                      <LinkButton label={`${r.title}, in ${r.where}`} onClick={() => navigate(r.action.href)}>
                        {r.title}
                      </LinkButton>
                      <Text variant="body-sm-normal" color="subtle">
                        {r.where}
                      </Text>
                    </div>
                    <div className="rank-row-value">
                      {r.seconds === undefined ? (
                        <Tag size="sm">Not measured</Tag>
                      ) : (
                        <Tag size="sm" color={r.secondsKind === 'saves' ? 'success' : 'default'}>
                          {r.secondsKind === 'saves'
                            ? `Saves about ${wholeSeconds(r.seconds)}`
                            : `${wholeSeconds(r.seconds)} CPU`}
                        </Tag>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>

      <div className="span-6">
        <Card>
          <Card.Header>
            <Card.Title>Costliest functions</Card.Title>
            <Card.Description>CPU time in the selected range</Card.Description>
            <Card.Action>
              <Button variant="tertiary" size="sm" onClick={() => navigate('/functions')}>
                View all
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <Skeleton loading title paragraph={{ rows: 4 }} />
            ) : stats.costly.length === 0 ? (
              <EmptyState
                illustration="Hibernating"
                title="No measurements yet"
                description="Profile a pipeline to see which functions take the most time."
              />
            ) : (
              <ul className="rank-list">
                {stats.costly.map((f) => (
                  <li key={f.id} className="rank-row">
                    <div className="rank-row-main">
                      <LinkButton
                        label={`${f.type}, function ${f.position} in ${f.pipeline}`}
                        onClick={() => openFunction(f)}
                      >
                        {`${f.type} #${f.position}`}
                      </LinkButton>
                      <Text variant="body-sm-normal" color="subtle">
                        {f.pipeline}
                      </Text>
                    </div>
                    <div className="rank-row-bar">
                      {/* A plain bar: the length compares functions, and a percentage here would read as a share of all CPU. */}
                      <svg className="cost-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                        <rect className="cost-bar-track" width="100" height="6" rx="3" />
                        <rect
                          className="cost-bar-fill"
                          width={maxCost > 0 ? Math.max(2, ((f.cpuSeconds ?? 0) / maxCost) * 100) : 0}
                          height="6"
                          rx="3"
                        />
                      </svg>
                    </div>
                    <div className="rank-row-value">
                      <Text variant="body-sm-semibold">{wholeSeconds(f.cpuSeconds)}</Text>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>

      {!isLoading && workerLoad && workerLoad.workers > 0 && (workerLoad.criblCores || workerLoad.busyCores) && (
        <div className="span-12">
          <Card>
            <Card.Header>
              <Card.Title>Estimate vs. Worker CPU</Card.Title>
            </Card.Header>
            <Card.Content>
              <WorkerCheck
                load={workerLoad}
                rangeSeconds={rangeSeconds}
                estimatedCpu={stats.estimatedCpu}
                unmeasuredShare={stats.unmeasuredShare}
              />
            </Card.Content>
          </Card>
        </div>
      )}
    </Page>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="figure">
      <Text variant="body-sm-normal" color="subtle">
        {label}
      </Text>
      <Text variant="body-md-semibold">{value}</Text>
    </div>
  );
}

function WorkerCheck({
  load,
  rangeSeconds,
  estimatedCpu,
  unmeasuredShare,
}: {
  load: WorkerLoad;
  rangeSeconds: number;
  estimatedCpu: number | undefined;
  unmeasuredShare: number | undefined;
}) {
  // Real CPU from the Workers when they answered; otherwise the hosts' load average as a rough ceiling.
  const measured = !!load.criblCores && !!load.cpuWorkers;
  // When only some Workers were asked, assume the rest are similar.
  const cores = measured ? (load.criblCores! * load.workers) / load.cpuWorkers! : (load.busyCores ?? 0);
  const estimatedCores = estimatedCpu === undefined ? undefined : estimatedCpu / rangeSeconds;
  const explained = estimatedCores !== undefined && cores > 0 ? estimatedCores / cores : undefined;
  const basis = measured ? 'the CPU Cribl uses on the Workers' : "the Workers' load average";
  // Only draw a conclusion once most of the traffic has actually been measured.
  const conclusion =
    explained === undefined
      ? 'Profile pipelines to compare their estimated cost with what the Workers use.'
      : (unmeasuredShare ?? 0) > 0.2
        ? 'Too much traffic is unmeasured to compare yet.'
        : explained < 0.25
          ? `Pipeline functions are a small part of ${basis}, so tuning them will not move Worker CPU much.`
          : explained <= 1.2
            ? `Pipeline functions are a large part of ${basis}, so fixing the pipelines above should show on the Workers.`
            : `The estimate is higher than ${basis}, so trust the rankings rather than the absolute seconds.`;
  return (
    <div className="drawer-section">
      <div className="figure-row">
        <Figure label="Workers" value={`${fmtInt(load.workers)}, ${fmtInt(load.cores)} cores`} />
        <Figure
          label={measured ? 'CPU used by Cribl' : 'Load average'}
          value={`${fmtSeconds(cores)} cores${load.cores > 0 ? ` (${fmtPercent(cores / load.cores)})` : ''}`}
        />
        <Figure
          label="Estimated for pipeline functions"
          value={
            estimatedCores === undefined
              ? EMPTY
              : `${fmtSeconds(estimatedCores)} cores${explained === undefined ? '' : ` (${fmtPercent(explained)} of it)`}`
          }
        />
      </div>
      <Text>{conclusion}</Text>
    </div>
  );
}
