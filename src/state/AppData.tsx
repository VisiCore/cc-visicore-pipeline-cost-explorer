import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@capra/core';
import {
  getRouteTraffic,
  getTraffic,
  getWorkerLoad,
  kvGet,
  kvMerge,
  kvSet,
  listGroups,
  listInputs,
  listOutputs,
  listPipelines,
  listRoutes,
  listSamples,
} from '../lib/api';
import { computeFates } from '../lib/fate';
import { analyzePipeline, measuredFindings, SEVERITY_RANK, topSeverity } from '../lib/analysis';
import {
  capturePlanFor,
  EmptyCaptureError,
  isStateful,
  matchSample,
  pipelineSignature,
  profilePipeline,
} from '../lib/profiler';
import type {
  CapturePlan,
  Fate,
  Finding,
  FnConf,
  FnState,
  Group,
  Input,
  Output,
  Pipeline,
  PipelineProfile,
  RangeKey,
  Route,
  RouteTraffic,
  Sample,
  Severity,
  Traffic,
  WorkerLoad,
} from '../lib/types';

export const RANGES: { key: RangeKey; ms: number }[] = [
  { key: '1h', ms: 3_600_000 },
  { key: '6h', ms: 6 * 3_600_000 },
  { key: '12h', ms: 12 * 3_600_000 },
  { key: '24h', ms: 24 * 3_600_000 },
  { key: '7d', ms: 7 * 24 * 3_600_000 },
];

export interface FunctionRow {
  [key: string]: unknown;
  id: string;
  pipelineKey: string;
  pipeline: string;
  index: number;
  position: number;
  type: string;
  description: string;
  filter: string;
  state: FnState;
  conf: FnConf;
  findings: Finding[];
  findingCount: number;
  severity: Severity | 'none';
  severityRank: number;
  /** Microseconds per event entering this function. */
  usPerEvent?: number;
  /** Share of the pipeline's measured time, 0–1. */
  share?: number;
  /** Estimated CPU seconds spent in this function over the selected time range. */
  cpuSeconds?: number;
  /** Events of the profiling sample that reached this function, and that it passed on. */
  sampleEventsIn?: number;
  sampleEventsOut?: number;
}

export interface PipelineRow {
  [key: string]: unknown;
  id: string;
  name: string;
  pack: string;
  functionCount: number;
  findingCount: number;
  highCount: number;
  inEvents?: number;
  outEvents?: number;
  /** `Sample.key` of the chosen or guessed sample. */
  sampleId?: string;
  sampleName?: string;
  sampleIsGuess: boolean;
  /** Events in the sample run the current profile was measured with. */
  profileEvents?: number;
  /** What the current profile was measured with: a sample's name, or live capture. */
  profileSource?: string;
  profileSourceEvents?: number;
  /** Where to capture this pipeline's live events, when it can be worked out from how it is wired in. */
  capture?: CapturePlan;
  /** What happens to this pipeline's output downstream, when it can be traced. */
  fate?: Fate;
  /** Share of this pipeline's output that is discarded downstream, 0–1. */
  discardedShare?: number;
  /** Estimated CPU seconds spent producing output that is then discarded. */
  wastedCpuSeconds?: number;
  /** Microseconds of pipeline processing per event entering the pipeline. */
  usPerEvent?: number;
  cpuSeconds?: number;
  profiledAt?: number;
}

export interface ProfileRequest {
  pipelineKey: string;
  /** Profile against events captured live with this plan. */
  capture?: CapturePlan;
  /** Profile against this saved sample, or fall back to it when a capture comes back empty. */
  sampleKey?: string;
  /** The user picked this sample themselves, so keep it as the pipeline's sample. */
  remember?: boolean;
}

interface ProfilingState {
  done: number;
  total: number;
  current: string;
}

interface AppData {
  groups: Group[];
  groupId?: string;
  setGroupId: (id: string) => void;
  range: RangeKey;
  setRange: (range: RangeKey) => void;
  isLoading: boolean;
  error?: string;
  warnings: string[];
  trafficError?: string;
  /** Set when the sample list could not be loaded, as opposed to there being no samples. */
  samplesError?: string;
  reload: () => void;
  pipelines: Pipeline[];
  samples: Sample[];
  /** The group's route table and Sources, used to work out where to capture a pipeline's live events. */
  routes: Route[];
  inputs: Input[];
  /** Worker capacity and load for the selected range; undefined while loading or if unavailable. */
  workerLoad?: WorkerLoad;
  /** Length of the selected time range, in seconds. */
  rangeSeconds: number;
  pipelineRows: PipelineRow[];
  functionRows: FunctionRow[];
  profiledCount: number;
  profiling?: ProfilingState;
  /** Profiles the given pipelines one after another. Always user-initiated. */
  runProfiles: (requests: ProfileRequest[]) => Promise<void>;
  cancelProfiling: () => void;
}

const Ctx = createContext<AppData | undefined>(undefined);

export function useAppData(): AppData {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAppData must be used inside AppDataProvider');
  return value;
}

interface Prefs {
  groupId?: string;
  range?: RangeKey;
}

/** Fewer events than this through a function is too few to judge its per-event cost. */
const MIN_EVENTS_FOR_FINDINGS = 100;

const kvSafe = (s: string) => encodeURIComponent(s);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupIdState] = useState<string>();
  const [range, setRangeState] = useState<RangeKey>('24h');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [trafficError, setTrafficError] = useState<string>();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [traffic, setTraffic] = useState<Record<string, Traffic>>({});
  const [profiles, setProfiles] = useState<Record<string, PipelineProfile>>({});
  const [sampleChoice, setSampleChoice] = useState<Record<string, string>>({});
  const [profiling, setProfiling] = useState<ProfilingState>();
  const [samplesError, setSamplesError] = useState<string>();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [inputs, setInputs] = useState<Input[]>([]);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [routeTraffic, setRouteTraffic] = useState<RouteTraffic[]>([]);
  const [workerLoad, setWorkerLoad] = useState<WorkerLoad>();
  /** Pack route tables, loaded only for Packs whose pipelines are receiving traffic. */
  const [packRoutes, setPackRoutes] = useState<Record<string, Route[]>>({});
  const [reloadTick, setReloadTick] = useState(0);
  const [bootTick, setBootTick] = useState(0);
  /** The group the UI currently shows; async work started for another group must not commit. */
  const groupRef = useRef<string | undefined>(undefined);
  const userKey = useRef<string>('shared');
  const abortRef = useRef<AbortController | null>(null);

  const savePrefs = useCallback((prefs: Prefs) => {
    void kvSet(`prefs/${userKey.current}`, prefs);
  }, []);

  // Bootstrap: who is the user, what did they last look at, which groups exist.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await window.getCriblUser?.().catch(() => undefined);
        if (user?.id) userKey.current = kvSafe(user.id);
        const [list, prefs] = await Promise.all([listGroups(), kvGet<Prefs>(`prefs/${userKey.current}`)]);
        if (cancelled) return;
        setGroups(list);
        if (prefs?.range && RANGES.some((r) => r.key === prefs.range)) setRangeState(prefs.range);
        const initial =
          list.find((g) => g.id === prefs?.groupId) ?? list.find((g) => g.id === 'default') ?? list[0];
        if (initial) {
          groupRef.current = initial.id;
          setError(undefined);
          setGroupIdState(initial.id);
        }
        else {
          setError('No Worker Groups or Fleets are visible to this app.');
          setIsLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootTick]);

  // Inventory for the selected group (read-only).
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    (async () => {
      try {
        const [inventory, sampleList, savedProfiles, savedChoice, routeList, inputList, outputList] = await Promise.all([
          listPipelines(groupId),
          listSamples(groupId).then(
            (list) => ({ list, error: undefined as string | undefined }),
            (e: Error) => ({ list: [] as Sample[], error: e.message }),
          ),
          kvGet<Record<string, PipelineProfile>>(`profiles/${kvSafe(groupId)}`),
          kvGet<Record<string, string>>(`samples/${kvSafe(groupId)}`),
          // Only used to suggest a capture filter, so an unreadable route table is not an error.
          listRoutes(groupId).catch(() => [] as Route[]),
          listInputs(groupId).catch(() => [] as Input[]),
          listOutputs(groupId).catch(() => [] as Output[]),
        ]);
        if (cancelled) return;
        setPipelines(inventory.pipelines);
        setWarnings(inventory.warnings);
        setSamples([...sampleList.list, ...inventory.packSamples]);
        setSamplesError(sampleList.error);
        setRoutes(routeList);
        setInputs(inputList);
        setOutputs(outputList);
        setProfiles(savedProfiles ?? {});
        setSampleChoice(savedChoice ?? {});
      } catch (e) {
        if (cancelled) return;
        setPipelines([]);
        setError((e as Error).message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, reloadTick]);

  // Throughput for the selected group and time range.
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    const ms = RANGES.find((r) => r.key === range)!.ms;
    const latest = Date.now();
    const earliest = latest - ms;
    getTraffic(groupId, earliest, latest)
      .then((t) => {
        if (cancelled) return;
        setTraffic(t);
        setTrafficError(undefined);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setTraffic({});
        setTrafficError(e.message);
      });
    // Supporting detail for downstream tracing and load comparison; the pages degrade without them.
    getRouteTraffic(groupId, earliest, latest)
      .catch(() => [] as RouteTraffic[])
      .then((rows) => {
        if (!cancelled) setRouteTraffic(rows);
      });
    getWorkerLoad(groupId, earliest, latest)
      .catch(() => undefined)
      .then((load) => {
        if (!cancelled) setWorkerLoad(load);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, range, reloadTick]);

  // A Pack pipeline's capture filter needs that Pack's routes. Fetching them for every Pack would
  // double the startup requests, so only Packs with pipelines that are receiving events are loaded.
  useEffect(() => {
    if (!groupId) return;
    const wanted = [
      ...new Set(
        pipelines
          .filter((p) => p.pack && (traffic[p.key]?.inEvents ?? 0) > 0 && !packRoutes[p.pack])
          .map((p) => p.pack!),
      ),
    ];
    if (!wanted.length) return;
    let cancelled = false;
    void Promise.all(
      wanted.map(async (pack) => [pack, await listRoutes(groupId, pack).catch(() => [] as Route[])] as const),
    ).then((loaded) => {
      if (!cancelled && groupRef.current === groupId) setPackRoutes((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
    });
    return () => {
      cancelled = true;
    };
  }, [groupId, pipelines, traffic, packRoutes]);

  const setGroupId = useCallback(
    (id: string) => {
      if (id === groupRef.current) return;
      // Stop any profiling run for the old group and release the lock so the new group can profile.
      abortRef.current?.abort();
      abortRef.current = null;
      setProfiling(undefined);
      groupRef.current = id;
      setGroupIdState(id);
      setIsLoading(true);
      setError(undefined);
      setWarnings([]);
      setTrafficError(undefined);
      setSamplesError(undefined);
      setPipelines([]);
      setSamples([]);
      setRoutes([]);
      setInputs([]);
      setOutputs([]);
      setRouteTraffic([]);
      setWorkerLoad(undefined);
      setPackRoutes({});
      setTraffic({});
      setProfiles({});
      setSampleChoice({});
      savePrefs({ groupId: id, range });
    },
    [range, savePrefs],
  );

  const setRange = useCallback(
    (next: RangeKey) => {
      if (next === range) return;
      setRangeState(next);
      // Don't show the old range's counts under the new range's label while the query runs.
      setTraffic({});
      setRouteTraffic([]);
      setWorkerLoad(undefined);
      savePrefs({ groupId, range: next });
    },
    [groupId, range, savePrefs],
  );

  // Before a group is selected, the only thing to retry is the startup sequence itself.
  const reload = useCallback(() => {
    if (groupRef.current) setReloadTick((t) => t + 1);
    else {
      setError(undefined);
      setIsLoading(true);
      setBootTick((t) => t + 1);
    }
  }, []);

  const { pipelineRows, functionRows, profiledCount } = useMemo(() => {
    const fates = computeFates(pipelines, routes, inputs, outputs, routeTraffic);
    const pRows: PipelineRow[] = [];
    const fRows: FunctionRow[] = [];
    let profiled = 0;

    for (const p of pipelines) {
      const analyzed = analyzePipeline(p);
      const t = traffic[p.key];
      const saved = profiles[p.key];
      // A stateful pipeline measured with repeated events gave misleading results, so such a profile
      // (from before repeats were ruled out) is treated as if the pipeline had not been profiled.
      const repeated = !!saved && (saved.sourceEvents ?? saved.events) < saved.events;
      const profile =
        saved && saved.signature === pipelineSignature(p) && !(repeated && isStateful(p)) ? saved : undefined;
      if (profile) profiled++;
      const byIndex = new Map(profile?.functions.map((f) => [f.index, f]));
      const label = p.pack ? `${p.pack} / ${p.id}` : p.id;

      let findingCount = 0;
      let highCount = 0;
      for (const a of analyzed) {
        const m = byIndex.get(a.index);
        const usPerEvent = m && m.eventsIn > 0 ? (m.durationMs * 1000) / m.eventsIn : undefined;
        const share = m && profile && profile.totalMs > 0 ? m.durationMs / profile.totalMs : undefined;
        // Cost per event entering the *pipeline*, so upstream drops are accounted for.
        const cpuSeconds =
          m && profile && t ? (t.inEvents * (m.durationMs / profile.events)) / 1000 : undefined;
        const findings = [
          // With only a handful of events reaching a function, its per-event time is mostly timer noise.
          ...(m && usPerEvent !== undefined && share !== undefined && m.eventsIn >= MIN_EVENTS_FOR_FINDINGS
            ? measuredFindings(usPerEvent, share, profile!.functions.length)
            : []),
          ...a.findings,
        ].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);
        const severity = topSeverity(findings) ?? 'none';
        findingCount += findings.length;
        highCount += findings.filter((f) => f.severity === 'high').length;
        fRows.push({
          id: `${p.key}#${a.index}`,
          pipelineKey: p.key,
          pipeline: label,
          index: a.index,
          position: a.index + 1,
          type: a.conf.id,
          description: a.conf.description ?? '',
          filter: a.conf.filter ?? 'true',
          state: a.state,
          conf: a.conf,
          findings,
          findingCount: findings.length,
          severity,
          severityRank: severity === 'none' ? 0 : SEVERITY_RANK[severity],
          usPerEvent,
          share,
          cpuSeconds,
          sampleEventsIn: m?.eventsIn,
          sampleEventsOut: m?.eventsOut,
        });
      }

      const usable = (s: Sample) => !s.pack || s.pack === p.pack;
      const chosen = samples.find((s) => s.key === sampleChoice[p.key] && usable(s));
      const guess = chosen ? undefined : matchSample(p, samples);
      const sample = chosen ?? guess;
      pRows.push({
        id: p.key,
        name: p.id,
        pack: p.pack ?? '',
        functionCount: analyzed.length,
        findingCount,
        highCount,
        inEvents: t?.inEvents,
        outEvents: t?.outEvents,
        sampleId: sample?.key,
        sampleName: sample?.sampleName,
        sampleIsGuess: !chosen && !!guess,
        usPerEvent: profile ? (profile.totalMs * 1000) / profile.events : undefined,
        cpuSeconds: profile && t ? (t.inEvents * (profile.totalMs / profile.events)) / 1000 : undefined,
        profiledAt: profile?.at,
        profileEvents: profile?.events,
        profileSource: profile?.sampleName,
        profileSourceEvents: profile?.sourceEvents,
        fate: fates[p.key],
        discardedShare: fates[p.key]?.discardedShare,
        wastedCpuSeconds:
          fates[p.key] && profile && t
            ? ((t.inEvents * (profile.totalMs / profile.events)) / 1000) * fates[p.key].discardedShare
            : undefined,
        capture: p.pack
          ? packRoutes[p.pack] && capturePlanFor(p, routes, inputs, packRoutes[p.pack])
          : capturePlanFor(p, routes, inputs),
      });
    }
    return { pipelineRows: pRows, functionRows: fRows, profiledCount: profiled };
  }, [pipelines, traffic, profiles, samples, sampleChoice, routes, inputs, outputs, routeTraffic, packRoutes]);

  const cancelProfiling = useCallback(() => abortRef.current?.abort(), []);

  const runProfiles = useCallback(
    async (requests: ProfileRequest[]) => {
      if (!groupId || abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const targetGroup = groupId;
      const pipelineKeys = requests.map((r) => r.pipelineKey);
      // Results belong to targetGroup. If the user stops the run or switches group, nothing more is
      // committed to state, so one group's results can never appear under another.
      const live = () => !controller.signal.aborted && groupRef.current === targetGroup;
      const failures: string[] = [];
      let succeeded = 0;
      let unsaved = 0;

      try {
        for (let i = 0; i < requests.length && live(); i++) {
          const { pipelineKey: key, sampleKey, capture, remember } = requests[i];
          const pipeline = pipelines.find((p) => p.key === key);
          const sample = sampleKey === undefined ? undefined : samples.find((s) => s.key === sampleKey);
          setProfiling({ done: i, total: requests.length, current: key });
          if (!pipeline || (!sample && !capture)) {
            failures.push(`${key}: no events to profile with`);
            continue;
          }
          try {
            let profile: PipelineProfile;
            try {
              profile = await profilePipeline(
                targetGroup,
                pipeline,
                capture ? { kind: 'capture', plan: capture } : { kind: 'sample', sample: sample! },
                controller.signal,
              );
            } catch (e) {
              // A quiet pipeline shouldn't fail the run when a saved sample was offered as a fallback.
              if (!(e instanceof EmptyCaptureError) || !sample || !live()) throw e;
              profile = await profilePipeline(targetGroup, pipeline, { kind: 'sample', sample }, controller.signal);
            }
            if (!live()) break;
            succeeded++;
            setProfiles((prev) => ({ ...prev, [key]: profile }));
            // Saved per pipeline so a long batch keeps its results if the tab is closed part-way.
            let saved = await kvMerge(`profiles/${kvSafe(targetGroup)}`, { [key]: profile });
            // Only a sample the user picked is remembered; a name match stays a suggestion.
            if (remember && sample && !capture) {
              if (live()) setSampleChoice((prev) => ({ ...prev, [key]: sample.key }));
              saved = (await kvMerge(`samples/${kvSafe(targetGroup)}`, { [key]: sample.key })) && saved;
            }
            if (!saved) unsaved++;
          } catch (e) {
            if (!live()) break;
            failures.push(`${key}: ${(e as Error).message}`);
          }
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setProfiling(undefined);
        }
      }

      // After a group switch the user is looking at something else; say nothing about the old run.
      if (groupRef.current !== targetGroup) return;
      if (controller.signal.aborted) {
        Toast.info(`Profiling stopped. ${succeeded} of ${pipelineKeys.length} pipelines were profiled.`);
      } else if (failures.length) {
        Toast.error(
          `${failures.length} of ${pipelineKeys.length} pipelines could not be profiled. ${failures[0]}`,
          { duration: 10000 },
        );
      } else {
        Toast.success(
          succeeded === 1 ? `Profiled ${pipelineKeys[0]}.` : `Profiled ${succeeded} pipelines.`,
        );
      }
      if (unsaved) {
        Toast.warning(
          `${unsaved === 1 ? 'One result' : `${unsaved} results`} could not be saved and will be lost when you leave this page.`,
          { duration: 10000 },
        );
      }
    },
    [groupId, pipelines, samples],
  );

  const value: AppData = {
    groups,
    groupId,
    setGroupId,
    range,
    setRange,
    isLoading,
    error,
    warnings,
    trafficError,
    samplesError,
    reload,
    pipelines,
    samples,
    routes,
    inputs,
    workerLoad,
    rangeSeconds: RANGES.find((r) => r.key === range)!.ms / 1000,
    pipelineRows,
    functionRows,
    profiledCount,
    profiling,
    runProfiles,
    cancelProfiling,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
