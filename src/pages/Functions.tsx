import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  defineColumns,
  EmptyState,
  Link,
  Pagination,
  SelectPillter,
  Table,
  Tag,
  TextField,
} from '@capra/core';
import { FilterOutlined } from '@capra/icons';
import { Page } from '../components/Page';
import { FunctionDrawer, STATE_LABEL } from '../components/FunctionDrawer';
import { clampPage, LinkButton, SeverityTag, sortRows, type Sort } from '../components/shared';
import { useAppData, type FunctionRow } from '../state/AppData';
import { EMPTY, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { pipelineHref, useParamList } from '../lib/useParamList';
import type { FnState } from '../lib/types';

const PAGE_SIZE = 25;

const SEVERITY_OPTIONS = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
  { label: 'No findings', value: 'none' },
];

const STATE_OPTIONS = (Object.keys(STATE_LABEL) as FnState[]).map((s) => ({ label: STATE_LABEL[s], value: s }));

export function Functions() {
  const { isLoading, error, functionRows, profiledCount } = useAppData();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [filter, setFilter] = useState('');
  // Pill filters live in the URL so drill-down links can preselect them, and reload and
  // back/forward restore them.
  const [severities, setSeverities] = useParamList('severity');
  const [types, setTypes] = useParamList('type');
  const [pipelines, setPipelines] = useParamList('pipeline');
  const [states, setStates] = useParamList('state');
  const [findings, setFindings] = useParamList('finding');
  const [sort, setSort] = useState<Sort | undefined>();
  const [pageState, setPage] = useState(1);
  const resetPage = () => setPage(1);

  // Lead with measured cost once any exists; until then, lead with the most severe findings.
  const hasMeasurements = functionRows.some((f) => f.usPerEvent !== undefined);
  const hasCpu = functionRows.some((f) => (f.cpuSeconds ?? 0) > 0);
  const effectiveSort: Sort =
    sort ??
    (hasCpu
      ? { column: 'cpuSeconds', direction: 'descending' }
      : hasMeasurements
        ? { column: 'usPerEvent', direction: 'descending' }
        : { column: 'severityRank', direction: 'descending' });

  const selectedId = params.get('fn');
  const selected = functionRows.find((f) => f.id === selectedId);
  const select = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('fn', id);
    else next.delete('fn');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    // Drop a stale ?fn= once data has loaded and the function no longer exists.
    if (!isLoading && selectedId && !selected) {
      const next = new URLSearchParams(params);
      next.delete('fn');
      setParams(next, { replace: true });
    }
  }, [isLoading, selectedId, selected, params, setParams]);

  const typeOptions = useMemo(
    () => [...new Set(functionRows.map((f) => f.type))].sort().map((t) => ({ label: t, value: t })),
    [functionRows],
  );
  const pipelineOptions = useMemo(
    () =>
      [...new Map(functionRows.map((f) => [f.pipelineKey, f.pipeline])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ label, value })),
    [functionRows],
  );
  const findingOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of functionRows) for (const x of f.findings) counts.set(x.title, (counts.get(x.title) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([title, count]) => ({ label: `${title} (${fmtInt(count)})`, value: title }));
  }, [functionRows]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = functionRows.filter(
      (f) =>
        (!q ||
          f.type.toLowerCase().includes(q) ||
          f.pipeline.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q) ||
          f.findings.some((x) => x.title.toLowerCase().includes(q))) &&
        (!severities.length || severities.includes(f.severity)) &&
        (!types.length || types.includes(f.type)) &&
        (!pipelines.length || pipelines.includes(f.pipelineKey)) &&
        (!states.length || states.includes(f.state)) &&
        (!findings.length || f.findings.some((x) => findings.includes(x.title))),
    );
    return sortRows(rows, effectiveSort);
    // effectiveSort is derived from the values below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [functionRows, filter, severities, types, pipelines, states, findings, effectiveSort.column, effectiveSort.direction]);

  // Rows can disappear under the current page, for example after switching to a smaller group.
  const page = clampPage(pageState, filtered.length, PAGE_SIZE);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const showFinding = (title: string) => {
    // One navigation, so the drawer closes and the filter applies together.
    const next = new URLSearchParams(params);
    next.delete('fn');
    next.set('finding', encodeURIComponent(title));
    setParams(next, { replace: true });
    resetPage();
  };

  const columns = useMemo(
    () =>
      defineColumns<FunctionRow>([
        {
          id: 'type',
          label: 'Function',
          allowsSorting: true,
          render: (_v, item) => (
            <LinkButton
              label={`${item.type}, function ${item.position} in ${item.pipeline}`}
              onClick={() => select(item.id)}
            >
              {item.type}
            </LinkButton>
          ),
        },
        {
          id: 'pipeline',
          label: 'Pipeline',
          allowsSorting: true,
          render: (_v, item) => <Link href={pipelineHref(item.pipelineKey)}>{item.pipeline}</Link>,
        },
        { id: 'position', label: 'Position', allowsSorting: true, render: (v) => fmtInt(v as number) },
        {
          id: 'severityRank',
          label: 'Findings',
          allowsSorting: true,
          render: (_v, item) => <SeverityTag severity={item.severity} count={item.findingCount} />,
        },
        {
          id: 'findingCount',
          label: 'Top finding',
          render: (_v, item) =>
            item.findings[0] ? (
              <LinkButton
                label={`Show all functions with the finding ${item.findings[0].title}`}
                onClick={() => showFinding(item.findings[0].title)}
              >
                {item.findings[0].title}
              </LinkButton>
            ) : (
              EMPTY
            ),
        },
        {
          id: 'usPerEvent',
          label: 'Time per event (µs)',
          allowsSorting: true,
          render: (v) => fmtMicros(v as number | undefined),
        },
        {
          id: 'share',
          label: 'Share of pipeline time',
          allowsSorting: true,
          render: (v) => fmtPercent(v as number | undefined),
        },
        {
          id: 'cpuSeconds',
          label: 'CPU time (s)',
          allowsSorting: true,
          render: (v) => fmtSeconds(v as number | undefined),
        },
      ]),
    // `select` and `showFinding` only close over URL params, which they re-read on call
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params],
  );

  const pillCount = severities.length + types.length + pipelines.length + states.length + findings.length;
  const hasFilters = !!filter || pillCount > 0;
  const clearFilters = () => {
    setFilter('');
    navigate('/functions', { replace: true });
    resetPage();
  };

  return (
    <Page title="Functions">
      {!isLoading && !error && functionRows.length > 0 && profiledCount === 0 && (
        <div className="span-12">
          <Alert
            appearance="info"
            action={{ label: 'Profile pipelines', onClick: () => navigate('/pipelines') }}
          >
            Timing columns are empty until pipelines are profiled. Findings below come from configuration analysis.
          </Alert>
        </div>
      )}
      <div className="span-12">
        <div className="filter-bar">
          <div className="filter-input">
            <TextField
              aria-label="Filter functions"
              placeholder="Filter functions"
              leadingSlot={<FilterOutlined />}
              value={filter}
              onChange={(v) => {
                setFilter(v);
                resetPage();
              }}
            />
          </div>
          <Tag>{`All functions (${fmtInt(functionRows.length)})`}</Tag>
          <SelectPillter
            label="Severity"
            multiSelect
            options={SEVERITY_OPTIONS}
            selectedValues={severities}
            onChange={(v) => {
              setSeverities(v);
              resetPage();
            }}
            onClear={() => setSeverities([])}
          />
          <SelectPillter
            label="Finding"
            multiSelect
            showFilter
            placeholder="Search findings"
            options={findingOptions}
            selectedValues={findings}
            onChange={(v) => {
              setFindings(v);
              resetPage();
            }}
            onClear={() => setFindings([])}
          />
          <SelectPillter
            label="Function"
            multiSelect
            showFilter
            placeholder="Search functions"
            options={typeOptions}
            selectedValues={types}
            onChange={(v) => {
              setTypes(v);
              resetPage();
            }}
            onClear={() => setTypes([])}
          />
          <SelectPillter
            label="Pipeline"
            multiSelect
            showFilter
            placeholder="Search pipelines"
            options={pipelineOptions}
            selectedValues={pipelines}
            onChange={(v) => {
              setPipelines(v);
              resetPage();
            }}
            onClear={() => setPipelines([])}
          />
          <SelectPillter
            label="State"
            multiSelect
            options={STATE_OPTIONS}
            selectedValues={states}
            onChange={(v) => {
              setStates(v);
              resetPage();
            }}
            onClear={() => setStates([])}
          />
          {pillCount > 1 && (
            <Button variant="tertiary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {!isLoading && !error && filtered.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            title={hasFilters ? 'No functions match these filters' : 'No functions'}
            description={
              hasFilters
                ? 'Clear a filter to see more functions.'
                : 'The pipelines in this group have no functions to analyze.'
            }
          >
            {hasFilters && (
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <Table
                aria-label="Functions"
                columns={columns}
                visibleColumns={[
                  'type',
                  'pipeline',
                  'position',
                  'severityRank',
                  'findingCount',
                  'usPerEvent',
                  'share',
                  'cpuSeconds',
                ]}
                items={pageRows}
                isLoading={isLoading}
                sortDescriptor={effectiveSort}
                onSortChange={(s) => {
                  setSort(s);
                  resetPage();
                }}
              />
            </div>
            {filtered.length > PAGE_SIZE && (
              <div className="table-footer">
                <Pagination
                  aria-label="Functions pagination"
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

      <FunctionDrawer row={selected} onClose={() => select(undefined)} onShowFinding={showFinding} />
    </Page>
  );
}
