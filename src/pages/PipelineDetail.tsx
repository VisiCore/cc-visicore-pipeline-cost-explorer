import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, defineColumns, EmptyState, Progress, Table, Tag, Text } from '@capra/core';
import { ArrowUpRightFromSquare, Flask, Play } from '@capra/icons';
import { Page } from '../components/Page';
import { FunctionDrawer, STATE_LABEL } from '../components/FunctionDrawer';
import { ProfileDrawer } from '../components/ProfileDrawer';
import { LinkButton, MetricCard, RatingTag, SeverityTag, sortRows, type Sort } from '../components/shared';
import { useAppData, type FunctionRow } from '../state/AppData';
import { EMPTY, fmtAge, fmtCoreShare, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { criblPipelineUrl, listQuery, pipelineTestHref } from '../lib/useParamList';

/** One pipeline: its functions in execution order, with cost and findings for each. */
export function PipelineDetail() {
  const { pipelineKey = '' } = useParams();
  const { isLoading, error, groups, groupId, pipelines, pipelineRows, functionRows, profiling, rangeSeconds } =
    useAppData();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [profileOpen, setProfileOpen] = useState(false);
  // Execution order is the natural reading of a pipeline, so it is the default.
  const [sort, setSort] = useState<Sort | undefined>({ column: 'position', direction: 'ascending' });

  const pipeline = pipelineRows.find((p) => p.id === pipelineKey);
  const functions = useMemo(
    () => sortRows(functionRows.filter((f) => f.pipelineKey === pipelineKey), sort),
    [functionRows, pipelineKey, sort],
  );

  const selectedId = params.get('fn');
  const selected = functions.find((f) => f.id === selectedId);
  const select = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('fn', id);
    else next.delete('fn');
    setParams(next, { replace: true });
  };

  const columns = useMemo(
    () =>
      defineColumns<FunctionRow>([
        { id: 'position', label: 'Position', allowsSorting: true, render: (v) => fmtInt(v as number) },
        {
          id: 'type',
          label: 'Function',
          allowsSorting: true,
          render: (_v, item) => (
            <LinkButton label={`${item.type}, function ${item.position}`} onClick={() => select(item.id)}>
              {item.type}
            </LinkButton>
          ),
        },
        { id: 'description', label: 'Description', render: (v) => (v as string) || EMPTY },
        { id: 'state', label: 'State', allowsSorting: true, render: (_v, item) => STATE_LABEL[item.state] },
        {
          id: 'severityRank',
          label: 'Findings',
          allowsSorting: true,
          render: (_v, item) => <SeverityTag severity={item.severity} count={item.findingCount} />,
        },
        {
          id: 'sampleEventsIn',
          label: 'Profiled events in',
          allowsSorting: true,
          render: (v) => fmtInt(v as number | undefined),
        },
        {
          id: 'sampleEventsOut',
          label: 'Profiled events out',
          allowsSorting: true,
          render: (v) => fmtInt(v as number | undefined),
        },
        {
          id: 'usPerPipelineEvent',
          label: 'Cost per event (µs)',
          allowsSorting: true,
          render: (v) => fmtMicros(v as number | undefined),
        },
        {
          id: 'share',
          label: 'Share of pipeline time',
          allowsSorting: true,
          render: (v, item) =>
            v === undefined ? (
              EMPTY
            ) : (
              <div className="share-cell">
                <Progress
                  aria-label={`${item.type}, function ${item.position}: share of pipeline time`}
                  size="sm"
                  value={Math.round((v as number) * 100)}
                />
              </div>
            ),
        },
        {
          id: 'noise',
          label: 'Variation between runs',
          allowsSorting: true,
          render: (v) => (v === undefined ? EMPTY : `±${fmtPercent(v as number)}`),
        },
        {
          id: 'cpuSeconds',
          label: 'CPU time (s)',
          allowsSorting: true,
          render: (v) => fmtSeconds(v as number | undefined),
        },
      ]),
    // `select` only closes over URL params, which it re-reads on call
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params],
  );

  const group = groups.find((g) => g.id === groupId);
  const conf = pipelines.find((p) => p.key === pipelineKey);
  const criblUrl = group && conf ? criblPipelineUrl(group, conf) : undefined;

  const title = pipeline ? (pipeline.pack ? `${pipeline.pack} / ${pipeline.name}` : pipeline.name) : pipelineKey;
  const parent = { label: 'Pipelines', href: '/pipelines' };

  if (!isLoading && !error && !pipeline) {
    return (
      <Page title={title} parent={parent}>
        <div className="span-12">
          <EmptyState
            illustration="MissingSock"
            title="Pipeline not found"
            description="This pipeline does not exist in the selected Worker Group. It may have been renamed or removed, or belong to a different group."
          >
            <Button variant="secondary" size="sm" onClick={() => navigate('/pipelines')}>
              View all pipelines
            </Button>
          </EmptyState>
        </div>
      </Page>
    );
  }

  const reduction =
    pipeline?.inEvents && pipeline.outEvents !== undefined ? 1 - pipeline.outEvents / pipeline.inEvents : undefined;

  return (
    <Page title={title} parent={parent}>
      {pipeline && pipeline.functionCount > 0 && pipeline.rating !== 'idle' && (
        <div className="span-12 rating-line">
          <RatingTag rating={pipeline.rating} />
          <Text>
            {pipeline.ratingReasons.length
              ? pipeline.ratingReasons.join(' · ')
              : pipeline.rating === 'efficient'
                ? 'Nothing measured or configured here stands out.'
                : 'Profile this pipeline to rate it.'}
          </Text>
          {pipeline.profiledAt !== undefined && (
            <Text variant="body-sm-normal" color="subtle">
              {`Profiled ${fmtAge(pipeline.profiledAt).toLowerCase()} with ${(pipeline.profileSource ?? 'a sample').toLowerCase()}, ${fmtInt(pipeline.profileSourceEvents ?? pipeline.profileEvents)} events${pipeline.noise === undefined ? '' : `, ±${fmtPercent(pipeline.noise)}`}`}
            </Text>
          )}
        </div>
      )}
      <div className="span-3">
        <MetricCard
          label="Events in"
          value={isLoading ? '--' : fmtInt(pipeline?.inEvents)}
          note={reduction === undefined ? undefined : `${fmtPercent(Math.max(0, reduction))} removed`}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Cost per event"
          value={pipeline?.usPerEvent === undefined ? '--' : `${fmtMicros(pipeline.usPerEvent)} µs`}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Estimated CPU time"
          value={pipeline?.cpuSeconds === undefined ? '--' : `${fmtSeconds(pipeline.cpuSeconds)} s`}
          note={pipeline?.cpuSeconds === undefined ? undefined : fmtCoreShare(pipeline.cpuSeconds, rangeSeconds)}
        />
      </div>
      <div className="span-3">
        <MetricCard
          label="Findings"
          value={isLoading ? '--' : fmtInt(pipeline?.findingCount)}
          note={pipeline?.highCount ? `${fmtInt(pipeline.highCount)} high` : undefined}
          noteColor="danger"
          drill={
            pipeline
              ? {
                  label: 'View findings for this pipeline on the Functions page',
                  onClick: () =>
                    navigate(`/functions${listQuery({ pipeline: [pipelineKey], severity: ['high', 'medium', 'low'] })}`),
                }
              : undefined
          }
        />
      </div>

      {pipeline?.fate && (pipeline.discardedShare ?? 0) >= 0.5 && pipeline.functionCount > 0 && (
        <div className="span-12">
          <Alert appearance="warning" title="Most of this pipeline's output is discarded downstream">
            {`${fmtPercent(pipeline.discardedShare)} of the events it produces are dropped or sent to a DevNull Destination after it has processed them${
              pipeline.wastedCpuSeconds !== undefined
                ? `, about ${fmtSeconds(pipeline.wastedCpuSeconds)} s of CPU in the selected range`
                : ''
            }. If nothing else uses that output, stop the events reaching this pipeline rather than tuning its functions.`}
          </Alert>
        </div>
      )}

      {pipeline && pipeline.profiledAt === undefined && pipeline.functionCount > 0 && (
        <div className="span-12">
          <Alert appearance="info" action={{ label: 'Profile pipeline', onClick: () => setProfileOpen(true) }}>
            This pipeline has not been profiled, so timing columns are empty. Findings come from configuration
            analysis.
          </Alert>
        </div>
      )}

      <div className="span-12">
        <div className="filter-bar">
          <div className="filter-bar-actions">
            {criblUrl && (
              // A native anchor: this leaves the app for the Cribl UI, so it must not go through the app's router.
              <a className="external-link" href={criblUrl} target="_blank" rel="noreferrer">
                Open in Cribl
                <ArrowUpRightFromSquare size="sm" />
              </a>
            )}
            <Button
              variant="secondary"
              leadingIcon={Flask}
              disabled={!pipeline || pipeline.functionCount === 0}
              onClick={() => navigate(pipelineTestHref(pipelineKey))}
            >
              Test a change
            </Button>
            <Button
              variant={pipeline?.profiledAt === undefined ? 'primary' : 'secondary'}
              leadingIcon={Play}
              disabled={!pipeline || !!profiling}
              onClick={() => setProfileOpen(true)}
            >
              {pipeline?.profiledAt === undefined ? 'Profile pipeline' : 'Profile again'}
            </Button>
          </div>
        </div>
        {!isLoading && pipeline && functions.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            title="No functions"
            description="This pipeline has no functions, so events pass through it unchanged."
          />
        ) : (
          <div className="table-wrap">
            <Table
              aria-label={`Functions in ${title}`}
              columns={columns}
              visibleColumns={[
                'position',
                'type',
                // Columns that say the same thing on every row are left out.
                ...(functions.some((f) => f.description) ? (['description'] as const) : []),
                ...(functions.some((f) => f.state !== 'enabled') ? (['state'] as const) : []),
                'severityRank',
                'usPerPipelineEvent',
                'share',
                'cpuSeconds',
              ]}
              items={functions}
              isLoading={isLoading}
              sortDescriptor={sort}
              onSortChange={setSort}
            />
          </div>
        )}
      </div>

      {pipeline?.fate && (
        <div className="span-12">
          <Card>
            <Card.Header>
              <Card.Title>Where the output goes</Card.Title>
              <Card.Description>
                Traced from the routes and Sources that run this pipeline, with event counts for the selected range
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <ul className="rank-list">
                {pipeline.fate.paths.map((path, i) => (
                  <li key={i} className="rank-row">
                    <div className="rank-row-main">
                      <Text>{path.via}</Text>
                      <Text variant="body-sm-normal" color="subtle">
                        {`Destination: ${path.destination}`}
                      </Text>
                    </div>
                    <div className="rank-row-finding">
                      <Text variant="body-sm-normal">
                        {path.events === undefined ? 'Volume not measured' : `${fmtInt(path.events)} events`}
                      </Text>
                    </div>
                    <div className="rank-row-value">
                      {path.discarded ? (
                        <Tag size="sm" color="warning">
                          {path.reason ?? 'Discarded'}
                        </Tag>
                      ) : (
                        <Tag size="sm">Delivered</Tag>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card.Content>
          </Card>
        </div>
      )}

      <FunctionDrawer
        row={selected}
        onClose={() => select(undefined)}
        showPipelineLink={false}
        onShowFinding={(findingTitle) => navigate(`/functions${listQuery({ finding: [findingTitle] })}`)}
      />
      <ProfileDrawer pipeline={profileOpen ? pipeline : undefined} onClose={() => setProfileOpen(false)} />
    </Page>
  );
}
