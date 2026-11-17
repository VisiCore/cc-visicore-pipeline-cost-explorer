import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  defineColumns,
  Drawer,
  EmptyState,
  Progress,
  Switch,
  Table,
  Tag,
  Text,
  TextArea,
} from '@capra/core';
import { ArrowUpRightFromSquare, Play } from '@capra/icons';
import { Page } from '../components/Page';
import { EventSourceFields, useEventSource, type EventChoice } from '../components/EventSource';
import { CodeBlock, LinkButton, MetricCard } from '../components/shared';
import { useAppData, type PipelineRow } from '../state/AppData';
import {
  comparePipelines,
  EmptyCaptureError,
  gatherEvents,
  isStateful,
  pipelineSignature,
  type Comparison,
  type GatheredEvents,
} from '../lib/profiler';
import { isActive } from '../lib/analysis';
import { EMPTY, fmtDateTime, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { criblPipelineUrl, pipelineHref } from '../lib/useParamList';
import type { FnConf, Pipeline } from '../lib/types';

/** One function of the edited pipeline, remembering where it sits in the saved one. */
interface DraftFn {
  origin: number;
  fn: FnConf;
  moved?: boolean;
}

interface Result extends Comparison {
  /** `origin` of each function of the edited pipeline, in the order it was run. */
  editedOrigins: number[];
}

interface TestRow {
  [key: string]: unknown;
  id: string;
  origin: number;
  position: number;
  type: string;
  description: string;
  /** Whether the function runs in the edited pipeline. */
  state: string;
  changes: string[];
  /** Microseconds per event entering the pipeline, so the column adds up to the pipeline total. */
  currentUs?: number;
  editedUs?: number;
  deltaUs?: number;
  currentIn?: number;
  editedIn?: number;
}

/** Differences smaller than this are never called real, however steady the runs were. */
const MIN_NOISE = 0.05;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changesOf(draft: DraftFn, original: FnConf): string[] {
  const out: string[] = [];
  if (!!draft.fn.disabled !== !!original.disabled) out.push(draft.fn.disabled ? 'Disabled' : 'Enabled');
  if (
    (draft.fn.filter ?? 'true') !== (original.filter ?? 'true') ||
    !!draft.fn.final !== !!original.final ||
    !same(draft.fn.conf ?? {}, original.conf ?? {})
  ) {
    out.push('Edited');
  }
  if (draft.moved) out.push('Moved');
  return out;
}

const signed = (n: number, text: string) => (n > 0 ? `+${text}` : text);

/** Edit a pipeline's functions in the app and measure the edit against the saved pipeline. */
export function PipelineTest() {
  const { pipelineKey = '' } = useParams();
  const { isLoading, error, pipelines, pipelineRows } = useAppData();
  const navigate = useNavigate();
  const conf = pipelines.find((p) => p.key === pipelineKey);
  const row = pipelineRows.find((p) => p.id === pipelineKey);
  const name = row ? (row.pack ? `${row.pack} / ${row.name}` : row.name) : pipelineKey;
  const parents = [
    { label: 'Pipelines', href: '/pipelines' },
    { label: name, href: pipelineHref(pipelineKey) },
  ];

  if (!conf || !row) {
    return (
      <Page title="Test a change" parents={parents}>
        {!isLoading && !error && (
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
        )}
      </Page>
    );
  }

  return (
    <Page title="Test a change" parents={parents}>
      {/* Keyed by the saved configuration, so edits never outlive the pipeline they were made against. */}
      <TestBench key={`${conf.key}:${pipelineSignature(conf)}`} conf={conf} row={row} name={name} />
    </Page>
  );
}

function TestBench({ conf, row, name }: { conf: Pipeline; row: PipelineRow; name: string }) {
  const { groups, groupId, samples, profiling } = useAppData();
  const [params, setParams] = useSearchParams();
  const original = useMemo(() => conf.conf.functions ?? [], [conf]);
  const [draft, setDraft] = useState<DraftFn[]>(() => original.map((fn, origin) => ({ origin, fn })));
  const [gathered, setGathered] = useState<GatheredEvents>();
  const [result, setResult] = useState<Result>();
  const [running, setRunning] = useState<{ label: string; percent: number }>();
  const [runError, setRunError] = useState<string>();
  const [runOpen, setRunOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Leaving the page (or the pipeline changing underneath it) ends any run in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  const edited: Pipeline = useMemo(
    () => ({ ...conf, conf: { ...conf.conf, functions: draft.map((d) => d.fn) } }),
    [conf, draft],
  );
  const editedSignature = pipelineSignature(edited);
  const changed = editedSignature !== pipelineSignature(conf);
  const stateful = isStateful(conf) || isStateful(edited);
  // Events that were repeated can't be reused once the pipeline has a function that keeps state.
  const reusable = gathered && !(gathered.repeated && stateful) ? gathered : undefined;

  const editingParam = params.get('fn');
  const editing = editingParam === null ? undefined : draft.find((d) => d.origin === Number(editingParam));
  const edit = (origin?: number) => {
    const next = new URLSearchParams(params);
    if (origin === undefined) next.delete('fn');
    else next.set('fn', String(origin));
    setParams(next, { replace: true });
  };

  const update = (origin: number, fn: FnConf) =>
    setDraft((list) => list.map((d) => (d.origin === origin ? { ...d, fn } : d)));
  const move = (origin: number, direction: -1 | 1) =>
    setDraft((list) => {
      const from = list.findIndex((d) => d.origin === origin);
      // Comments aren't shown, so a move steps over them to the next real function.
      let to = from + direction;
      while (to >= 0 && to < list.length && list[to].fn.id === 'comment') to += direction;
      if (from < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, { ...item, moved: true });
      return next;
    });
  const resetAll = () => setDraft(original.map((fn, origin) => ({ origin, fn })));

  const run = async (choice: EventChoice) => {
    if (!groupId || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunOpen(false);
    setRunError(undefined);
    try {
      let events = choice.kind === 'reuse' ? reusable : undefined;
      if (!events) {
        setRunning({ label: choice.kind === 'capture' ? 'Capturing events' : 'Loading sample', percent: 0 });
        const sample = choice.kind === 'sample' ? samples.find((s) => s.key === choice.sampleKey) : undefined;
        if (choice.kind === 'sample' && !sample) throw new Error('The selected sample no longer exists');
        events = await gatherEvents(
          groupId,
          choice.kind === 'capture' ? { kind: 'capture', plan: choice.plan } : { kind: 'sample', sample: sample! },
          stateful,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setGathered(events);
      }
      const editedOrigins = draft.map((d) => d.origin);
      const comparison = await comparePipelines(groupId, conf, edited, events, controller.signal, (done, total) =>
        setRunning({ label: `Run ${Math.min(done + 1, total)} of ${total}`, percent: Math.round((done / total) * 100) }),
      );
      if (!controller.signal.aborted) setResult({ ...comparison, editedOrigins });
    } catch (e) {
      if (!controller.signal.aborted) {
        setRunError(
          e instanceof EmptyCaptureError
            ? `${e.message}. Check the capture filter, or use a saved sample.`
            : (e as Error).message,
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(undefined);
      }
    }
  };

  const rows = useMemo<TestRow[]>(() => {
    const perEvent = (ms: number | undefined, events: number) => (ms === undefined ? undefined : (ms * 1000) / events);
    return draft
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.fn.id !== 'comment')
      .map(({ d, i }) => {
        const cur = result?.current.functions.find((f) => f.index === d.origin);
        const at = result ? result.editedOrigins.indexOf(d.origin) : -1;
        const ed = at < 0 ? undefined : result!.edited.functions.find((f) => f.index === at);
        // A function that didn't run on one side cost nothing there, which is what the difference should show.
        const currentUs = result ? (perEvent(cur?.durationMs, result.events) ?? 0) : undefined;
        const editedUs = result ? (perEvent(ed?.durationMs, result.events) ?? 0) : undefined;
        return {
          id: String(d.origin),
          origin: d.origin,
          position: i + 1,
          type: d.fn.id,
          description: d.fn.description ?? '',
          state: isActive(d.fn, edited) ? 'Enabled' : 'Disabled',
          changes: changesOf(d, original[d.origin]),
          currentUs: cur ? currentUs : undefined,
          editedUs: ed ? editedUs : undefined,
          deltaUs: result && (cur || ed) ? editedUs! - currentUs! : undefined,
          currentIn: cur?.eventsIn,
          editedIn: ed?.eventsIn,
        };
      });
  }, [draft, edited, original, result]);

  const columns = useMemo(
    () =>
      defineColumns<TestRow>([
        { id: 'position', label: 'Position', render: (v) => fmtInt(v as number) },
        {
          id: 'type',
          label: 'Function',
          render: (_v, item) => (
            <LinkButton label={`Edit ${item.type}, function ${item.position}`} onClick={() => edit(item.origin)}>
              {item.type}
            </LinkButton>
          ),
        },
        { id: 'description', label: 'Description', render: (v) => (v as string) || EMPTY },
        { id: 'state', label: 'State' },
        {
          id: 'changes',
          label: 'Change',
          render: (_v, item) =>
            item.changes.length ? (
              <Tag size="sm" color="info">
                {item.changes.join(', ')}
              </Tag>
            ) : (
              EMPTY
            ),
        },
        { id: 'currentIn', label: 'Events in, current', render: (v) => fmtInt(v as number | undefined) },
        { id: 'editedIn', label: 'Events in, edited', render: (v) => fmtInt(v as number | undefined) },
        { id: 'currentUs', label: 'Current (µs per event)', render: (v) => fmtMicros(v as number | undefined) },
        { id: 'editedUs', label: 'Edited (µs per event)', render: (v) => fmtMicros(v as number | undefined) },
        {
          id: 'deltaUs',
          label: 'Difference (µs per event)',
          render: (v) => (v === undefined ? EMPTY : signed(v as number, fmtMicros(v as number))),
        },
      ]),
    // `edit` only closes over URL params, which it re-reads on call
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params],
  );

  const group = groups.find((g) => g.id === groupId);
  const criblUrl = group ? criblPipelineUrl(group, conf) : undefined;
  const stale = !!result && result.editedSignature !== editedSignature;

  const currentUs = result ? (result.current.totalMs * 1000) / result.events : undefined;
  const editedUs = result ? (result.edited.totalMs * 1000) / result.events : undefined;
  const delta = currentUs && editedUs !== undefined ? (editedUs - currentUs) / currentUs : undefined;
  const noise = result ? Math.max(result.spread, MIN_NOISE) : MIN_NOISE;
  const withinNoise = delta !== undefined && Math.abs(delta) <= noise;
  const savedSeconds =
    result && row.inEvents !== undefined && currentUs !== undefined && editedUs !== undefined
      ? (row.inEvents * (currentUs - editedUs)) / 1_000_000
      : undefined;

  return (
    <>
      <div className="span-12">
        <Text>
          {`Edit the functions of ${name} here, then run the saved and edited versions against the same events to see what the edit is worth. Nothing on this page is saved to Cribl, and edits are lost when you leave it.`}
        </Text>
      </div>

      {result && (
        <>
          <div className="span-3">
            <MetricCard label="Time per event, current" value={`${fmtMicros(currentUs)} µs`} />
          </div>
          <div className="span-3">
            <MetricCard
              label="Time per event, edited"
              value={`${fmtMicros(editedUs)} µs`}
              note={
                delta === undefined
                  ? undefined
                  : withinNoise
                    ? `${signed(delta, fmtPercent(delta))}, within noise`
                    : `${signed(delta, fmtPercent(delta))}`
              }
              noteColor={withinNoise ? 'default' : (delta ?? 0) < 0 ? 'success' : 'danger'}
            />
          </div>
          <div className="span-3">
            <MetricCard
              label="CPU time saved, selected range"
              value={savedSeconds === undefined || withinNoise ? '--' : `${fmtSeconds(savedSeconds)} s`}
              note={
                withinNoise
                  ? 'No measurable change'
                  : row.inEvents === undefined
                    ? undefined
                    : `${fmtInt(row.inEvents)} events in`
              }
            />
          </div>
          <div className="span-3">
            <MetricCard
              label="Output"
              value={
                result.outputMatch === 'same' ? 'Identical' : result.outputMatch === 'different' ? 'Different' : 'Not comparable'
              }
              note={
                result.currentOut === result.editedOut
                  ? `${fmtInt(result.currentOut)} events out`
                  : `${fmtInt(result.currentOut)} events out, now ${fmtInt(result.editedOut)}`
              }
              noteColor={result.outputMatch === 'different' ? 'warning' : 'default'}
            />
          </div>
        </>
      )}

      {stale && (
        <div className="span-12">
          <Alert appearance="warning">
            The edits have changed since this comparison was run. Run it again to measure the current edits.
          </Alert>
        </div>
      )}
      {runError && (
        <div className="span-12">
          <Alert appearance="danger" title="The comparison could not be run" onDismiss={() => setRunError(undefined)}>
            {runError}
          </Alert>
        </div>
      )}
      {running && (
        <div className="span-12 profiling-bar" role="status" aria-live="polite">
          <div className="profiling-bar-text">
            <Text variant="body-sm-semibold">{running.label}</Text>
            <Progress aria-label="Comparison progress" size="sm" value={running.percent} />
          </div>
          <Button variant="secondary" size="sm" onClick={() => abortRef.current?.abort()}>
            Stop
          </Button>
        </div>
      )}

      <div className="span-12">
        <div className="filter-bar">
          <Text color="subtle">
            {changed ? 'Select a function to edit it.' : 'Select a function to edit its filter or configuration, disable it, or move it.'}
          </Text>
          <div className="filter-bar-actions">
            {criblUrl && (
              // A native anchor: this leaves the app for the Cribl UI, so it must not go through the app's router.
              <a className="external-link" href={criblUrl} target="_blank" rel="noreferrer">
                Open in Cribl
                <ArrowUpRightFromSquare size="sm" />
              </a>
            )}
            <Button variant="tertiary" disabled={!changed || !!running} onClick={resetAll}>
              Discard edits
            </Button>
            <Button
              variant="primary"
              leadingIcon={Play}
              disabled={!changed || !!running || !!profiling}
              onClick={() => setRunOpen(true)}
            >
              Run comparison
            </Button>
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            title="No functions"
            description="This pipeline has no functions to change."
          />
        ) : (
          <div className="table-wrap">
            <Table
              aria-label={`Functions in ${name}, current and edited`}
              columns={columns}
              visibleColumns={[
                'position',
                'type',
                'description',
                'state',
                'changes',
                'currentIn',
                'editedIn',
                'currentUs',
                'editedUs',
                'deltaUs',
              ]}
              items={rows}
            />
          </div>
        )}
      </div>

      {result && (
        <div className="span-12">
          <Card>
            <Card.Header>
              <Card.Title>How this was measured</Card.Title>
              <Card.Description>
                {`${fmtDateTime(result.at)}. ${result.sourceName}: ${fmtInt(result.sourceEvents)} events${
                  result.repeated ? `, repeated to ${fmtInt(result.events)}` : ', each run once'
                }. Each version ran 3 times, alternating, and the fastest time per function is kept.`}
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <div className="drawer-stack">
                <Text>
                  {`The two fastest runs of the same version were ${fmtPercent(result.spread)} apart, so a difference smaller than ${fmtPercent(noise)} is treated as noise. Times are per event entering the pipeline, so the function rows add up to the pipeline total.`}
                </Text>
                {result.outputMatch === 'unstable' && (
                  <Alert appearance="info" title="Output could not be compared">
                    This pipeline produces a different number of events each time the same version is run, for
                    example because it samples at random. Timings are still valid.
                  </Alert>
                )}
                {result.outputMatch === 'same' && (
                  <Text>
                    {`Both versions produced the same ${fmtInt(result.currentOut)} events from these inputs, compared field by field (internal fields starting with two underscores are ignored).`}
                  </Text>
                )}
                {result.ignoredFields.length > 0 && (
                  <Text>
                    {`Left out of the output comparison because ${result.ignoredFields.length === 1 ? 'it changes' : 'they change'} between runs of the same version: ${result.ignoredFields.join(', ')}.`}
                  </Text>
                )}
                {result.outputMatch === 'different' && result.firstDifference && (
                  <>
                    <Alert appearance="warning" title="The edited version produces different output">
                      {`Check that the difference is one you intend. The first output event that differs is number ${fmtInt(result.firstDifference.position)}.`}
                    </Alert>
                    <div className="compare-grid">
                      <div className="drawer-section">
                        <Text variant="body-md-semibold">Current</Text>
                        <CodeBlock>{result.firstDifference.current ?? 'No event at this position'}</CodeBlock>
                      </div>
                      <div className="drawer-section">
                        <Text variant="body-md-semibold">Edited</Text>
                        <CodeBlock>{result.firstDifference.edited ?? 'No event at this position'}</CodeBlock>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Card.Content>
          </Card>
        </div>
      )}

      <Drawer
        isOpen={!!editing}
        onClose={() => edit(undefined)}
        title={editing ? `Edit ${editing.fn.id} #${draft.indexOf(editing) + 1}` : ''}
        width={560}
        aria-label="Edit function"
      >
        {editing && (
          <FunctionEditor
            // Remounts when the function is changed from outside the form (moved or reset).
            key={`${editing.origin}:${draft.indexOf(editing)}:${JSON.stringify(editing.fn)}`}
            draft={editing}
            original={original[editing.origin]}
            onApply={(fn) => {
              update(editing.origin, fn);
              edit(undefined);
            }}
            onMove={(direction) => move(editing.origin, direction)}
            onClose={() => edit(undefined)}
          />
        )}
      </Drawer>

      <Drawer isOpen={runOpen} onClose={() => setRunOpen(false)} title="Run comparison" width={520}>
        {runOpen && (
          <RunForm
            row={row}
            reuse={reusable && { count: reusable.events.length, sourceName: reusable.sourceName }}
            onRun={(choice) => void run(choice)}
            onClose={() => setRunOpen(false)}
          />
        )}
      </Drawer>
    </>
  );
}

function RunForm({
  row,
  reuse,
  onRun,
  onClose,
}: {
  row: PipelineRow;
  reuse?: { count: number; sourceName: string };
  onRun: (choice: EventChoice) => void;
  onClose: () => void;
}) {
  const source = useEventSource(row, reuse);
  return (
    <div className="drawer-stack">
      <Text>
        The saved pipeline and your edited version are each run 3 times against the same events in the Leader's
        preview sandbox. Nothing is sent to Destinations and no configuration changes.
      </Text>
      <EventSourceFields source={source} />
      <div className="drawer-footer">
        <Button variant="tertiary" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          leadingIcon={Play}
          disabled={!source.choice}
          onClick={() => source.choice && onRun(source.choice)}
        >
          {source.kind === 'capture' ? 'Capture and compare' : 'Run comparison'}
        </Button>
      </div>
    </div>
  );
}

function FunctionEditor({
  draft,
  original,
  onApply,
  onMove,
  onClose,
}: {
  draft: DraftFn;
  original: FnConf;
  onApply: (fn: FnConf) => void;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState(draft.fn.filter ?? 'true');
  const [confText, setConfText] = useState(JSON.stringify(draft.fn.conf ?? {}, null, 2));
  const [disabled, setDisabled] = useState(!!draft.fn.disabled);
  const [final, setFinal] = useState(!!draft.fn.final);

  let parsed: Record<string, unknown> | undefined;
  let confError: string | undefined;
  try {
    const value: unknown = JSON.parse(confText);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    else confError = 'The configuration must be a JSON object.';
  } catch (e) {
    confError = `Not valid JSON: ${(e as Error).message}`;
  }

  const isOriginal =
    filter === (original.filter ?? 'true') &&
    disabled === !!original.disabled &&
    final === !!original.final &&
    !!parsed &&
    same(parsed, original.conf ?? {});
  const restore = () => {
    setFilter(original.filter ?? 'true');
    setConfText(JSON.stringify(original.conf ?? {}, null, 2));
    setDisabled(!!original.disabled);
    setFinal(!!original.final);
  };

  return (
    <div className="drawer-stack">
      {draft.fn.description && <Text color="subtle">{draft.fn.description}</Text>}

      <TextArea
        label="Filter"
        helperText="A JavaScript expression. The function runs only for events it matches."
        autoSize={{ minRows: 1, maxRows: 6 }}
        value={filter}
        onChange={setFilter}
      />
      <div className="drawer-section">
        <label className="switch-row">
          <Switch aria-label="Disabled" size="sm" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          <Text>Disabled</Text>
        </label>
        <label className="switch-row">
          <Switch aria-label="Final" size="sm" checked={final} onChange={(e) => setFinal(e.target.checked)} />
          <Text>Final: matched events skip the functions after this one</Text>
        </label>
      </div>

      <div className="drawer-section">
        <Text variant="body-md-semibold">Position</Text>
        <div className="button-row">
          <Button variant="secondary" size="sm" onClick={() => onMove(-1)}>
            Move earlier
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onMove(1)}>
            Move later
          </Button>
        </div>
        <Text color="subtle">Moving applies straight away and discards unapplied edits in this form.</Text>
      </div>

      <TextArea
        label="Configuration"
        appearance={confError ? 'danger' : 'default'}
        helperText={confError ?? 'The function’s settings as JSON, in the form Cribl stores them.'}
        rows={16}
        value={confText}
        onChange={setConfText}
      />

      <div className="drawer-footer">
        <Button variant="tertiary" disabled={isOriginal} onClick={restore}>
          Restore saved values
        </Button>
        <Button variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!parsed || !filter.trim()}
          onClick={() =>
            parsed &&
            // Values left as saved keep their saved form (an unset flag stays unset), so an untouched
            // function still counts as unchanged.
            onApply({
              ...draft.fn,
              filter: filter.trim() === (original.filter ?? 'true') ? original.filter : filter.trim(),
              conf: same(parsed, original.conf ?? {}) ? original.conf : parsed,
              disabled: disabled === !!original.disabled ? original.disabled : disabled,
              final: final === !!original.final ? original.final : final,
            })
          }
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
