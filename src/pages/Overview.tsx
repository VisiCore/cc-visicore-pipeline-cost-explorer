import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, Link, Progress, Skeleton, Text } from '@capra/core';
import { Page } from '../components/Page';
import { LinkButton, MetricCard, SeverityTag } from '../components/shared';
import { useAppData, type FunctionRow } from '../state/AppData';
import type { WorkerLoad } from '../lib/types';
import { fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { listQuery, pipelineHref } from '../lib/useParamList';

const TOP_N = 8;

function CardSkeleton() {
  return <Skeleton loading title paragraph={{ rows: 4 }} />;
}

export function Overview() {
  const { isLoading, error, pipelineRows, functionRows, profiledCount, groupId, workerLoad, rangeSeconds } =
    useAppData();
  const navigate = useNavigate();
  const openFunction = (row: FunctionRow) => navigate(`/functions?fn=${encodeURIComponent(row.id)}`);

  const stats = useMemo(() => {
    const active = functionRows.filter((f) => f.state === 'enabled');
    const withTraffic = pipelineRows.filter((p) => (p.inEvents ?? 0) > 0).length;
    const high = functionRows.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'high').length, 0);
    const medium = functionRows.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'medium').length, 0);

    const hasCpu = functionRows.some((f) => (f.cpuSeconds ?? 0) > 0);
    const measured = functionRows.filter((f) => f.usPerEvent !== undefined);
    const costly = [...measured]
      .sort((a, b) =>
        hasCpu ? (b.cpuSeconds ?? 0) - (a.cpuSeconds ?? 0) : (b.usPerEvent ?? 0) - (a.usPerEvent ?? 0),
      )
      .slice(0, TOP_N);

    const flagged = functionRows
      .filter((f) => f.severityRank >= 2)
      .sort((a, b) => b.severityRank - a.severityRank || (b.cpuSeconds ?? 0) - (a.cpuSeconds ?? 0))
      .slice(0, TOP_N);

    // Pipelines doing real work whose output is then mostly thrown away, costliest first.
    const discarded = pipelineRows
      .filter((p) => (p.discardedShare ?? 0) >= 0.5 && p.functionCount > 0 && (p.inEvents ?? 0) > 0)
      .sort((a, b) => (b.wastedCpuSeconds ?? 0) - (a.wastedCpuSeconds ?? 0) || (b.inEvents ?? 0) - (a.inEvents ?? 0))
      .slice(0, TOP_N);

    const pipelineEvents = pipelineRows.reduce((n, p) => n + (p.inEvents ?? 0), 0);
    // A pipeline with no functions costs nothing, so its traffic counts as accounted for.
    const profiledEvents = pipelineRows.reduce(
      (n, p) => n + (p.profiledAt !== undefined || p.functionCount === 0 ? (p.inEvents ?? 0) : 0),
      0,
    );
    const estimatedCpu = pipelineRows.reduce((n, p) => n + (p.cpuSeconds ?? 0), 0);

    return {
      active: active.length,
      withTraffic,
      high,
      medium,
      hasCpu,
      costly,
      flagged,
      discarded,
      coverage: pipelineEvents > 0 ? profiledEvents / pipelineEvents : undefined,
      estimatedCpu,
    };
  }, [functionRows, pipelineRows]);

  const maxCost = stats.costly.length
    ? Math.max(...stats.costly.map((f) => (stats.hasCpu ? (f.cpuSeconds ?? 0) : (f.usPerEvent ?? 0))))
    : 0;

  return (
    <Page title="Overview">
      {!error && !isLoading && pipelineRows.length > 0 && profiledCount === 0 && (
        <div className="span-12">
          <Alert
            appearance="info"
            title="No pipelines have been profiled yet"
            action={{ label: 'Profile pipelines', onClick: () => navigate('/pipelines') }}
          >
            Configuration findings are ready below. To measure how much time each function takes, profile pipelines
            with a sample of their data.
          </Alert>
        </div>
      )}

      <div className="span-3">
        <MetricCard
          label="Pipelines"
          value={isLoading ? '--' : fmtInt(pipelineRows.length)}
          note={isLoading ? undefined : `${fmtInt(stats.withTraffic)} with traffic`}
          drill={{
            label: 'View pipelines with traffic',
            onClick: () => navigate(`/pipelines${listQuery({ show: ['traffic'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Active functions"
          value={isLoading ? '--' : fmtInt(stats.active)}
          drill={{
            label: 'View active functions',
            onClick: () => navigate(`/functions${listQuery({ state: ['enabled'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="High-severity findings"
          value={isLoading ? '--' : fmtInt(stats.high)}
          note={isLoading ? undefined : `${fmtInt(stats.medium)} medium`}
          noteColor={stats.medium > 0 ? 'warning' : 'default'}
          drill={{
            label: 'View functions with high-severity findings',
            onClick: () => navigate(`/functions${listQuery({ severity: ['high'] })}`),
          }}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Profiled pipelines"
          value={isLoading ? '--' : `${fmtInt(profiledCount)} of ${fmtInt(pipelineRows.length)}`}
          drill={{
            label: profiledCount > 0 ? 'View profiled pipelines' : 'View pipelines to profile',
            onClick: () => navigate(`/pipelines${listQuery({ show: [profiledCount > 0 ? 'profiled' : 'traffic'] })}`),
          }}
        />
      </div>

      <div className="span-6">
        <Card>
          <Card.Header>
            <Card.Title>{stats.hasCpu ? 'Highest CPU time' : 'Slowest functions'}</Card.Title>
            <Card.Description>
              {stats.hasCpu
                ? 'Measured time per event × events through the pipeline in the selected time range'
                : 'Measured time per event'}
            </Card.Description>
            <Card.Action>
              <Button variant="tertiary" size="sm" onClick={() => navigate('/functions')}>
                View all
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <CardSkeleton />
            ) : stats.costly.length === 0 ? (
              <EmptyState
                illustration="Hibernating"
                title="No measurements yet"
                description="Profile a pipeline to see which of its functions take the most time."
              >
                <Button variant="primary" size="sm" onClick={() => navigate('/pipelines')}>
                  Profile pipelines
                </Button>
              </EmptyState>
            ) : (
              <ul className="rank-list">
                {stats.costly.map((f) => {
                  const cost = stats.hasCpu ? (f.cpuSeconds ?? 0) : (f.usPerEvent ?? 0);
                  return (
                    <li key={f.id} className="rank-row">
                      <div className="rank-row-main">
                        <LinkButton label={`${f.type}, function ${f.position} in ${f.pipeline}`} onClick={() => openFunction(f)}>
                          {`${f.type} #${f.position}`}
                        </LinkButton>
                        <Link href={pipelineHref(f.pipelineKey)}>{f.pipeline}</Link>
                      </div>
                      <div className="rank-row-bar">
                        <Progress
                          aria-label={`Relative cost of ${f.type}, function ${f.position} in ${f.pipeline}`}
                          size="sm"
                          value={maxCost > 0 ? Math.round((cost / maxCost) * 100) : 0}
                        />
                      </div>
                      <div className="rank-row-value">
                        <Text variant="body-sm-semibold">
                          {stats.hasCpu ? `${fmtSeconds(f.cpuSeconds ?? 0)} s` : `${fmtMicros(f.usPerEvent)} µs`}
                        </Text>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>

      <div className="span-6">
        <Card>
          <Card.Header>
            <Card.Title>Functions to review</Card.Title>
            <Card.Description>{`Medium and high severity findings${groupId ? ` in ${groupId}` : ''}`}</Card.Description>
            <Card.Action>
              <Button variant="tertiary" size="sm" onClick={() => navigate(`/functions${listQuery({ severity: ['high', 'medium'] })}`)}>
                View all
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <CardSkeleton />
            ) : stats.flagged.length === 0 ? (
              <EmptyState
                illustration="Celebration"
                title="Nothing flagged"
                description="No medium or high severity findings in this group's pipelines."
              />
            ) : (
              <ul className="rank-list">
                {stats.flagged.map((f) => (
                  <li key={f.id} className="rank-row">
                    <div className="rank-row-main">
                      <LinkButton label={`${f.type}, function ${f.position} in ${f.pipeline}`} onClick={() => openFunction(f)}>
                        {`${f.type} #${f.position}`}
                      </LinkButton>
                      <Link href={pipelineHref(f.pipelineKey)}>{f.pipeline}</Link>
                    </div>
                    <div className="rank-row-finding">
                      <LinkButton
                        label={`Show all functions with the finding ${f.findings[0].title}`}
                        onClick={() => navigate(`/functions${listQuery({ finding: [f.findings[0].title] })}`)}
                      >
                        {f.findings[0].title}
                      </LinkButton>
                    </div>
                    <div className="rank-row-value">
                      <SeverityTag severity={f.severity} count={f.findingCount} />
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
            <Card.Title>Output discarded downstream</Card.Title>
            <Card.Description>
              Pipelines that process events which are then dropped or sent to a DevNull Destination
            </Card.Description>
            <Card.Action>
              <Button variant="tertiary" size="sm" onClick={() => navigate(`/pipelines${listQuery({ show: ['discarded'] })}`)}>
                View all
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <CardSkeleton />
            ) : stats.discarded.length === 0 ? (
              <EmptyState
                illustration="Celebration"
                title="No discarded output found"
                description="No pipeline with traffic has most of its output thrown away downstream."
              />
            ) : (
              <ul className="rank-list">
                {stats.discarded.map((p) => (
                  <li key={p.id} className="rank-row">
                    <div className="rank-row-main">
                      <Link href={pipelineHref(p.id)}>{p.pack ? `${p.pack} / ${p.name}` : p.name}</Link>
                      <Text variant="body-sm-normal" color="subtle">
                        {p.fate?.paths.find((x) => x.discarded)?.reason ?? ''}
                      </Text>
                    </div>
                    <div className="rank-row-finding">
                      <Text variant="body-sm-normal">{`${fmtPercent(p.discardedShare)} of ${fmtInt(p.inEvents)} events`}</Text>
                    </div>
                    <div className="rank-row-value">
                      <Text variant="body-sm-semibold">
                        {p.wastedCpuSeconds === undefined ? 'Not profiled' : `${fmtSeconds(p.wastedCpuSeconds)} s`}
                      </Text>
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
            <Card.Title>Worker load check</Card.Title>
            <Card.Description>How the profiled estimates compare with what the Workers report</Card.Description>
          </Card.Header>
          <Card.Content>
            {isLoading ? (
              <CardSkeleton />
            ) : !workerLoad || workerLoad.workers === 0 ? (
              <EmptyState
                illustration="Hibernating"
                title="No Worker load data"
                description="Worker details or load metrics are not available for this group and time range."
              />
            ) : (
              <WorkerLoadCheck
                load={workerLoad}
                rangeSeconds={rangeSeconds}
                estimatedCpu={stats.estimatedCpu}
                coverage={stats.coverage}
                profiledCount={profiledCount}
              />
            )}
          </Card.Content>
        </Card>
      </div>
    </Page>
  );
}

function WorkerLoadCheck({
  load,
  rangeSeconds,
  estimatedCpu,
  coverage,
  profiledCount,
}: {
  load: WorkerLoad;
  rangeSeconds: number;
  estimatedCpu: number;
  coverage: number | undefined;
  profiledCount: number;
}) {
  const loadSeconds = load.busyCores * rangeSeconds;
  const explained = loadSeconds > 0 && profiledCount > 0 ? estimatedCpu / loadSeconds : undefined;
  // Only draw a conclusion once most of the traffic has actually been measured.
  const conclusion =
    explained === undefined || coverage === undefined
      ? 'Profile the pipelines that carry traffic to compare their estimated cost with Worker load.'
      : coverage < 0.8
        ? 'Too little of the traffic is profiled to judge where Worker load comes from. Profile the remaining busy pipelines.'
        : explained < 0.25
          ? 'Pipeline functions explain only a small part of Worker load. Most of it is elsewhere: receiving and parsing events at Sources, serializing and sending at Destinations, and other processes on the hosts.'
          : explained <= 1.2
            ? 'Pipeline functions account for a substantial part of Worker load, so the function rankings are a good guide to where to optimize.'
            : 'The estimate exceeds measured load, so the Leader timings overstate cost on these Workers. Use the rankings, not the absolute seconds.';
  return (
    <div className="drawer-stack">
      <dl className="detail-list">
        <dt>
          <Text color="subtle">Workers</Text>
        </dt>
        <dd>
          <Text>{`${fmtInt(load.workers)} with ${fmtInt(load.cores)} cores`}</Text>
        </dd>
        <dt>
          <Text color="subtle">Average load</Text>
        </dt>
        <dd>
          <Text>
            {`${fmtSeconds(load.busyCores)} cores busy${load.cores > 0 ? `, ${fmtPercent(load.busyCores / load.cores)} of capacity` : ''}`}
          </Text>
        </dd>
        <dt>
          <Text color="subtle">Profiled pipeline functions</Text>
        </dt>
        <dd>
          <Text>
            {explained === undefined
              ? '--'
              : `${fmtSeconds(estimatedCpu)} s, ${fmtPercent(explained)} of Worker load`}
          </Text>
        </dd>
        <dt>
          <Text color="subtle">Traffic accounted for</Text>
        </dt>
        <dd>
          <Text>{coverage === undefined ? '--' : `${fmtPercent(coverage)} of pipeline events`}</Text>
        </dd>
      </dl>
      <Text>{conclusion}</Text>
      <Text variant="body-sm-normal" color="subtle">
        Load is the hosts' load average, which counts every process on the machine, so it is an upper bound on what
        Cribl uses.
      </Text>
    </div>
  );
}
