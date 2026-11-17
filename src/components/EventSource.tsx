import { useEffect, useState } from 'react';
import { Alert, SelectField, Text, TextArea, ToggleButtonGroup } from '@capra/core';
import { useAppData, type PipelineRow } from '../state/AppData';
import { CAPTURE_MAX_EVENTS, CAPTURE_SECONDS, listRoutes } from '../lib/api';
import { capturePlanFor, isStateful, MAX_CAPTURES } from '../lib/profiler';
import { fmtInt } from '../lib/format';
import type { CapturePlan, Route } from '../lib/types';

type Kind = 'reuse' | 'capture' | 'sample';

/** The events the user chose to measure with; undefined until the choice is complete. */
export type EventChoice =
  | { kind: 'reuse' }
  | { kind: 'capture'; plan: CapturePlan }
  | { kind: 'sample'; sampleKey: string };

/** Events kept from an earlier run that can be measured against again. */
export interface ReusableEvents {
  count: number;
  sourceName: string;
}

/**
 * State for choosing which events to run through a pipeline: a live capture, a saved sample, or
 * (when offered) the events of the previous run. Render it with `EventSourceFields`.
 */
export function useEventSource(pipeline: PipelineRow, reuse?: ReusableEvents) {
  const { groupId, pipelines, routes, inputs, samples, samplesError } = useAppData();
  const conf = pipelines.find((p) => p.key === pipeline.id);
  const choices = samples.filter((s) => (s.pack ? s.pack === pipeline.pack : !s.isPackOnly));

  // A Pack pipeline's traffic is decided by the Pack's own routes as well, which are fetched on demand.
  const [packRoutes, setPackRoutes] = useState<Route[] | undefined>(pipeline.pack ? undefined : []);
  useEffect(() => {
    if (!pipeline.pack || !groupId) return;
    let cancelled = false;
    listRoutes(groupId, pipeline.pack)
      .catch(() => [] as Route[])
      .then((list) => {
        if (!cancelled) setPackRoutes(list);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, pipeline.pack]);

  const plan = conf && packRoutes ? capturePlanFor(conf, routes, inputs, packRoutes) : undefined;
  const suggested = plan?.filter;
  // An edited filter keeps the suggested tap point; with no suggestion, events are tapped before routing.
  const level = plan?.level ?? 1;
  // Live traffic is the more faithful input, so it leads whenever the pipeline is actually receiving events.
  const [kind, setKind] = useState<Kind>(
    reuse ? 'reuse' : (pipeline.inEvents ?? 0) > 0 || choices.length === 0 ? 'capture' : 'sample',
  );
  const [sampleKey, setSampleKey] = useState<string | null>(pipeline.sampleId ?? null);
  // undefined until the user edits it, so the suggestion can still arrive after Pack routes load.
  const [filterEdit, setFilterEdit] = useState<string>();
  const filter = filterEdit ?? suggested ?? '';

  // The offer to reuse events can be withdrawn while the picker is open.
  const active: Kind = kind === 'reuse' && !reuse ? 'capture' : kind;
  const choice: EventChoice | undefined =
    active === 'reuse'
      ? { kind: 'reuse' }
      : active === 'capture'
        ? filter.trim()
          ? { kind: 'capture', plan: { filter: filter.trim(), level } }
          : undefined
        : sampleKey
          ? { kind: 'sample', sampleKey }
          : undefined;

  return {
    pipeline,
    reuse,
    kind: active,
    setKind,
    choices,
    samplesError,
    sampleKey,
    setSampleKey,
    filter,
    filterEdited: filterEdit !== undefined,
    setFilter: setFilterEdit,
    suggested,
    level,
    routesLoading: packRoutes === undefined,
    stateful: !!conf && isStateful(conf),
    choice,
  };
}

export function EventSourceFields({ source }: { source: ReturnType<typeof useEventSource> }) {
  const { pipeline, reuse, kind, choices, samplesError, sampleKey, filter, filterEdited, suggested, level, stateful } =
    source;
  return (
    <>
      <div className="drawer-section">
        <Text variant="body-md-semibold">Events to run</Text>
        <div>
          <ToggleButtonGroup
            aria-label="Events to run"
            disallowEmptySelection
            selectedKeys={new Set([kind])}
            onSelectionChange={(keys) => {
              const next = [...keys][0] as Kind | undefined;
              if (next) source.setKind(next);
            }}
            items={[
              ...(reuse ? [{ key: 'reuse', text: 'Same events' }] : []),
              { key: 'capture', text: 'Live capture' },
              { key: 'sample', text: 'Saved sample' },
            ]}
          />
        </div>
      </div>

      {kind === 'reuse' && reuse && (
        <Text color="subtle">
          {`Runs the ${fmtInt(reuse.count)} events from the previous run again (${reuse.sourceName}), so results can be compared with it directly.`}
        </Text>
      )}

      {kind === 'capture' && (
        <>
          <TextArea
            label="Capture filter"
            placeholder={source.routesLoading ? 'Loading routes' : "sourcetype=='my:data'"}
            helperText={
              !filterEdited && suggested
                ? level === 0
                  ? 'Built from the Sources that use this pipeline for pre-processing. Events are captured as they leave the Source.'
                  : 'Built from the routes and QuickConnect links that send to this pipeline. It ignores route order, so check it selects the events this pipeline really receives.'
                : !source.routesLoading && !suggested && !filterEdited
                  ? 'No enabled route or Source sends to this pipeline, so there is nothing to suggest. Enter an expression that selects its events, such as a Source or sourcetype match.'
                  : `A JavaScript expression evaluated against each event ${level === 0 ? 'as it leaves the Source' : 'before routing'}.`
            }
            value={filter}
            onChange={(v) => source.setFilter(v)}
          />
          <Text color="subtle">
            {stateful
              ? `Captures up to ${fmtInt(CAPTURE_MAX_EVENTS)} matching events from the Workers. This pipeline has functions that keep state between events, so each event is run once and a quiet pipeline is captured up to ${MAX_CAPTURES} times, ${CAPTURE_SECONDS} seconds each. Captured events are not saved.`
              : `Captures up to ${fmtInt(CAPTURE_MAX_EVENTS)} matching events from the Workers for up to ${CAPTURE_SECONDS} seconds. Captured events are not saved.`}
          </Text>
          {(pipeline.inEvents ?? 0) === 0 && (
            <Alert appearance="warning">
              No events entered this pipeline in the selected time range, so a capture may come back empty.
            </Alert>
          )}
        </>
      )}

      {kind === 'sample' && (
        <>
          <SelectField
            label="Sample"
            placeholder="Select a sample"
            helperText={
              pipeline.sampleIsGuess && sampleKey === pipeline.sampleId
                ? 'Matched by name. Confirm it represents the data this pipeline processes.'
                : 'Choose a sample that represents the data this pipeline processes. Timings depend on the events used.'
            }
            canSearch
            items={choices.map((s) => ({
              id: s.key,
              label: s.sampleName,
              description: `${fmtInt(s.numEvents ?? 0)} events${s.pack ? `, from Pack ${s.pack}` : ''}`,
            }))}
            value={sampleKey}
            onChange={(key) => source.setSampleKey(key === null ? null : String(key))}
          />
          {stateful && (
            <Text color="subtle">
              This pipeline has functions that keep state between events, so each sample event is run once. A
              small sample gives noisier timings.
            </Text>
          )}
          {!samplesError && choices.length === 0 && (
            <Alert appearance="warning" title="No saved samples">
              Capture or upload a sample file for this group in Cribl (Processing, then Knowledge, then Sample Data)
              and reload, or use live capture.
            </Alert>
          )}
          {samplesError && (
            <Alert appearance="warning" title="Samples could not be loaded">
              {samplesError}
            </Alert>
          )}
        </>
      )}
    </>
  );
}
