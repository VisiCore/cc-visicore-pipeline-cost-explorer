import {
  captureEvents,
  CAPTURE_SECONDS,
  getSampleEvents,
  previewPipeline,
  type PreviewResult,
  type PreviewStats,
} from './api';
import { isActive } from './analysis';
import type { CapturePlan, FnProfile, Input, Pipeline, PipelineProfile, Route, Sample } from './types';

/** Events sent per preview run. More events amortize process start-up and JIT warm-up in the timings. */
const TARGET_EVENTS = 1000;
/** Keeps the request body comfortably inside the platform proxy limits. */
const MAX_BODY_BYTES = 1_500_000;
/** Each run is a fresh sandbox process; the fastest run per function is the least noisy estimate. */
const RUNS = 2;
/** Fewer events per run means noisier timings, so runs without repeated events are measured more often. */
const RUNS_DISTINCT = 4;
/** Back-to-back captures made to collect enough distinct events for a pipeline that cannot have them repeated. */
export const MAX_CAPTURES = 3;
/** Each configuration is measured this many times in a comparison, alternating between the two. */
const COMPARE_ROUNDS = 3;

/**
 * Functions whose result depends on the events that came before: they count, group, or thin out
 * events over time. Feeding them the same events again changes what they do, so their pipelines are
 * only ever measured with distinct events.
 */
const STATEFUL = new Set([
  // A Chain runs another pipeline, which may itself keep state, and a Code function can keep anything
  // between events, so both are treated as if they do.
  'chain',
  'code',
  'aggregation',
  'aggregate_metrics',
  'rollup_metrics',
  'suppress',
  'sampling',
  'dynamic_sampling',
  'drop_dimensions',
]);

export function isStateful(pipeline: Pipeline): boolean {
  return (pipeline.conf.functions ?? []).some((fn) => STATEFUL.has(fn.id) && isActive(fn, pipeline));
}

/** Identifies the configuration a profile was measured against. Descriptions don't affect behavior, so they are left out. */
export function pipelineSignature(pipeline: Pipeline): string {
  const { functions = [], description: _description, ...settings } = pipeline.conf;
  const text = JSON.stringify([functions.map(({ description: _d, ...fn }) => fn), settings]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The events for one run, within the size budget. With `repeat`, the sample is repeated until there
 * are enough events to time reliably; without it, each event is used once.
 */
export function buildEvents(sample: Record<string, unknown>[], repeat = true): Record<string, unknown>[] {
  if (!sample.length) return [];
  // Measured in UTF-8 bytes, which is what goes over the wire; string length undercounts non-ASCII events.
  const avgBytes = new TextEncoder().encode(JSON.stringify(sample)).length / sample.length;
  const budget = Math.max(1, Math.min(TARGET_EVENTS, Math.floor(MAX_BODY_BYTES / Math.max(avgBytes, 1))));
  const count = repeat ? budget : Math.min(budget, sample.length);
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) events.push(sample[i % sample.length]);
  return events;
}

/** Maps preview stats (one entry per active function, in order) back onto function indexes. */
function align(pipeline: Pipeline, stats: PreviewStats): number[] {
  const active = (pipeline.conf.functions ?? [])
    .map((fn, index) => ({ fn, index }))
    .filter(({ fn }) => isActive(fn, pipeline));
  if (active.length !== stats.functions.length || active.some(({ fn }, i) => fn.id !== stats.functions[i].func)) {
    throw new Error('Preview statistics do not line up with the pipeline’s functions; reload and try again');
  }
  return active.map(({ index }) => index);
}

/** Where a profiling run gets its events: a saved sample, or events captured live for this run. */
export type ProfileInput =
  | { kind: 'sample'; sample: Sample }
  | { kind: 'capture'; plan: CapturePlan };

export const LIVE_CAPTURE = 'Live capture';

/** The capture ran but nothing matched in time; callers may fall back to a saved sample. */
export class EmptyCaptureError extends Error {
  constructor() {
    super(`No events matched the capture filter in ${CAPTURE_SECONDS} seconds`);
  }
}

/** The events a run was built from, and the events actually sent. */
export interface GatheredEvents {
  /** A sample's name, or live capture. */
  sourceName: string;
  sampleId: string;
  /** Distinct events collected. */
  sourceEvents: number;
  events: Record<string, unknown>[];
  /** False when every event is used once, which pipelines with stateful functions need. */
  repeated: boolean;
}

/** Collects the events to measure a pipeline with. `stateful` forbids repeating them. */
export async function gatherEvents(
  groupId: string,
  input: ProfileInput,
  stateful: boolean,
  signal?: AbortSignal,
): Promise<GatheredEvents> {
  let source: Record<string, unknown>[];
  if (input.kind === 'sample') {
    source = await getSampleEvents(groupId, input.sample, signal);
    if (!source.length) throw new Error(`Sample "${input.sample.sampleName}" has no events`);
  } else {
    source = await captureEvents(groupId, input.plan.filter, input.plan.level, signal);
    if (!source.length) throw new EmptyCaptureError();
    // Events can't be repeated for a stateful pipeline, so a quiet one is captured for longer instead.
    for (let n = 1; stateful && n < MAX_CAPTURES && source.length < TARGET_EVENTS; n++) {
      const more = await captureEvents(groupId, input.plan.filter, input.plan.level, signal);
      if (!more.length) break;
      source = source.concat(more);
    }
  }
  const events = buildEvents(source, !stateful);
  return {
    sourceName: input.kind === 'sample' ? input.sample.sampleName : LIVE_CAPTURE,
    sampleId: input.kind === 'sample' ? input.sample.id : '',
    sourceEvents: source.length,
    events,
    repeated: events.length > source.length,
  };
}

const totalOf = (stats: PreviewStats) => stats.functions.reduce((sum, f) => sum + f.duration, 0);

/**
 * Keeps whichever run of the same configuration was faster overall. The whole run is kept, not the
 * best time of each function, so the function times shown always add up to a run that happened.
 */
function fastest(a: PreviewStats | undefined, b: PreviewStats): PreviewStats {
  return !a || totalOf(b) < totalOf(a) ? b : a;
}

/** Gap between the two smallest values: how repeatable the smallest one is. */
function gap(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const [min, next] = [...values].sort((x, y) => x - y);
  return next - min;
}

/** Summarizes several runs of one configuration: the fastest whole run, with how repeatable it was. */
function toProfile(pipeline: Pipeline, runs: PreviewStats[], gathered: GatheredEvents): PipelineProfile {
  const stats = runs.reduce<PreviewStats | undefined>(fastest, undefined)!;
  const indexes = align(pipeline, stats);
  const functions: FnProfile[] = stats.functions.map((f, i) => ({
    index: indexes[i],
    durationMs: f.duration,
    eventsIn: f.eventsIn,
    eventsOut: f.eventsOut,
    bytesIn: f.bytesIn,
    bytesOut: f.bytesOut,
    noiseMs: gap(runs.map((r) => r.functions[i].duration)),
  }));
  const totals = runs.map(totalOf);
  const totalGap = gap(totals);
  const fastestTotal = Math.min(...totals);
  return {
    signature: pipelineSignature(pipeline),
    sampleId: gathered.sampleId,
    sampleName: gathered.sourceName,
    sourceEvents: gathered.sourceEvents,
    events: gathered.events.length,
    totalMs: functions.reduce((sum, f) => sum + f.durationMs, 0),
    spread: totalGap !== undefined && fastestTotal > 0 ? totalGap / fastestTotal : undefined,
    at: Date.now(),
    functions,
  };
}

export async function profilePipeline(
  groupId: string,
  pipeline: Pipeline,
  input: ProfileInput,
  signal?: AbortSignal,
): Promise<PipelineProfile> {
  const gathered = await gatherEvents(groupId, input, isStateful(pipeline), signal);
  const runs: PreviewStats[] = [];
  const count = gathered.repeated ? RUNS : RUNS_DISTINCT;
  for (let run = 0; run < count; run++) {
    const { stats } = await previewPipeline(groupId, pipeline, gathered.events, signal);
    align(pipeline, stats);
    runs.push(stats);
  }
  return toProfile(pipeline, runs, gathered);
}

/** How the two configurations' output events compare. */
export type OutputMatch = 'same' | 'different' | 'unstable';

export interface Comparison {
  at: number;
  /** Signature of the edited configuration this result belongs to. */
  editedSignature: string;
  sourceName: string;
  sourceEvents: number;
  events: number;
  repeated: boolean;
  current: PipelineProfile;
  edited: PipelineProfile;
  /** How far apart the two fastest runs of the same configuration were, as a ratio of the fastest; the larger of the two sides. */
  spread: number;
  outputMatch: OutputMatch;
  currentOut: number;
  editedOut: number;
  /** Fields left out of the comparison because they change between runs of the same configuration. */
  ignoredFields: string[];
  /** The first output event that differs, when the outputs differ. */
  firstDifference?: { position: number; current?: string; edited?: string };
}

type OutEvent = Record<string, string>;

/**
 * An output event as a Destination would see it, each field serialized for comparison. Internal `__`
 * fields are bookkeeping, not output.
 */
function visible(event: Record<string, unknown>): OutEvent {
  const out: OutEvent = {};
  for (const key of Object.keys(event).sort()) if (!key.startsWith('__')) out[key] = canonical(event[key]);
  return out;
}

/** JSON with object keys in a fixed order, so two equal values always serialize the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const render = (event: OutEvent | undefined) =>
  event && `{\n${Object.entries(event).map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`).join(',\n')}\n}`;

function differs(a: OutEvent | undefined, b: OutEvent | undefined, ignore: Set<string>): boolean {
  if (!a || !b) return a !== b;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!ignore.has(key) && a[key] !== b[key]) return true;
  }
  return false;
}

/**
 * Fields whose value changes between runs of the same configuration, such as a timestamp taken when
 * the event was produced. Returns undefined when the runs don't even produce the same number of
 * events, in which case nothing can be compared.
 */
function volatileFields(runs: OutEvent[][]): Set<string> | undefined {
  const fields = new Set<string>();
  for (const run of runs.slice(1)) {
    if (run.length !== runs[0].length) return undefined;
    run.forEach((event, i) => {
      const first = runs[0][i];
      for (const key of new Set([...Object.keys(event), ...Object.keys(first)])) {
        if (event[key] !== first[key]) fields.add(key);
      }
    });
  }
  return fields;
}

/**
 * Measures a pipeline as it is and with an edited configuration, against exactly the same events.
 * The two are run alternately so that drift on the Leader affects both equally. Nothing is saved:
 * both configurations are sent inline to the preview sandbox.
 */
export async function comparePipelines(
  groupId: string,
  current: Pipeline,
  edited: Pipeline,
  gathered: GatheredEvents,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Comparison> {
  const sides = [
    { pipeline: current, runs: [] as PreviewStats[], outputs: [] as OutEvent[][] },
    { pipeline: edited, runs: [] as PreviewStats[], outputs: [] as OutEvent[][] },
  ];
  const total = COMPARE_ROUNDS * 2;
  let done = 0;
  onProgress?.(done, total);
  for (let round = 0; round < COMPARE_ROUNDS; round++) {
    // Swap who goes first each round, so neither side always runs on a warmer or cooler Leader.
    for (const side of round % 2 ? [sides[1], sides[0]] : sides) {
      const result: PreviewResult = await previewPipeline(groupId, side.pipeline, gathered.events, signal);
      align(side.pipeline, result.stats);
      side.runs.push(result.stats);
      side.outputs.push(result.items.map(visible));
      onProgress?.(++done, total);
    }
  }

  // The comparison uses each side's fastest whole run, so what matters is how repeatable that run is:
  // the gap to the next fastest. One slow outlier among the runs doesn't make the fastest less reliable.
  const spreadOf = (totals: number[]) => {
    const [min, next] = [...totals].sort((x, y) => x - y);
    return min > 0 && next !== undefined ? (next - min) / min : 0;
  };
  const [cur, ed] = sides;
  // Fields that change between runs of the same configuration say nothing about the edit, so they are
  // left out. If even the event count changes between runs (random sampling), nothing can be compared.
  const curVolatile = volatileFields(cur.outputs);
  const edVolatile = volatileFields(ed.outputs);
  const stable = !!curVolatile && !!edVolatile;
  // Only a field that varies in both versions is left out. One that varies only in the edited version
  // is something the edit introduced, and has to show up as a difference.
  const ignore = new Set([...(curVolatile ?? [])].filter((field) => edVolatile?.has(field)));
  const a = cur.outputs[0];
  const b = ed.outputs[0];
  let at = -1;
  for (let i = 0; i < Math.max(a.length, b.length) && at < 0; i++) if (differs(a[i], b[i], ignore)) at = i;

  return {
    at: Date.now(),
    editedSignature: pipelineSignature(edited),
    sourceName: gathered.sourceName,
    sourceEvents: gathered.sourceEvents,
    events: gathered.events.length,
    repeated: gathered.repeated,
    current: toProfile(current, cur.runs, gathered),
    edited: toProfile(edited, ed.runs, gathered),
    spread: Math.max(spreadOf(cur.runs.map(totalOf)), spreadOf(ed.runs.map(totalOf))),
    outputMatch: !stable ? 'unstable' : at < 0 ? 'same' : 'different',
    currentOut: cur.outputs[0].length,
    editedOut: ed.outputs[0].length,
    ignoredFields: stable ? [...ignore].sort() : [],
    firstDifference: stable && at >= 0 ? { position: at + 1, current: render(a[at]), edited: render(b[at]) } : undefined,
  };
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stripExt = (s: string) => s.replace(/(\.(log|json|js|txt|csv))+$/i, '');

/**
 * Best-guess sample for a pipeline, by name. A guess needs the pipeline's whole name to appear in the
 * sample's name as complete words, so `main` does not match `domain_controller.log`. Short generic
 * names are never guessed. Among matches, the closest name wins, then the Pack's own sample.
 */
export function matchSample(pipeline: Pipeline, samples: Sample[]): Sample | undefined {
  const want = tokens(pipeline.id);
  if (want.join('').length < 6) return undefined;
  let best: { sample: Sample; extra: number } | undefined;
  for (const s of samples) {
    if (!s.numEvents || (s.pack ? s.pack !== pipeline.pack : s.isPackOnly)) continue;
    const have = tokens(stripExt(s.sampleName));
    let at = -1;
    for (let i = 0; i + want.length <= have.length && at < 0; i++) {
      if (want.every((t, k) => have[i + k] === t)) at = i;
    }
    if (at < 0 && tokens(s.id).join('_') !== want.join('_')) continue;
    const extra = at < 0 ? 0 : have.length - want.length;
    const better =
      !best ||
      extra < best.extra ||
      (extra === best.extra && !!s.pack && !best.sample.pack) ||
      (extra === best.extra && !!s.pack === !!best.sample.pack && (s.numEvents ?? 0) > (best.sample.numEvents ?? 0));
    if (better) best = { sample: s, extra };
  }
  return best?.sample;
}

const always = (filter?: string) => !filter || filter.trim() === '' || filter.trim() === 'true';

/** ORs filters together; any catch-all makes the result `true`. */
function anyOf(filters: (string | undefined)[]): string | undefined {
  if (!filters.length) return undefined;
  if (filters.some(always)) return 'true';
  const unique = [...new Set(filters.map((f) => f!.trim()))];
  return unique.length === 1 ? unique[0] : unique.map((f) => `(${f})`).join(' || ');
}

/** Matches events from a Source. Internal metrics report as `cribl:`, and some Sources add a suffix to their ID. */
function fromInput(input: Input): string {
  const type = input.type === 'criblmetrics' ? 'cribl' : input.type;
  const id = `${type}:${input.id.replace(/['\\]/g, '\\$&')}`;
  // The suffix, when there is one, follows a colon; a bare prefix match would also take in Source `foo2`.
  return `(__inputId=='${id}' || __inputId.startsWith('${id}:'))`;
}

/**
 * A capture plan that approximates the events a pipeline receives, worked out from how the pipeline
 * is wired in: routes that send to it, Sources that use it for pre-processing, and QuickConnect
 * links. For a Pack pipeline, whatever sends events into the Pack is combined with the Pack's own
 * routes. It ignores route order and Final flags, so it can match events an earlier route takes, and
 * it knows nothing about pipelines attached to Destinations. Returns undefined when nothing
 * references the pipeline.
 */
export function capturePlanFor(
  pipeline: Pipeline,
  groupRoutes: Route[],
  inputs: Input[],
  packRoutes: Route[] = [],
): CapturePlan | undefined {
  const live = inputs.filter((i) => !i.disabled);
  // Everything that delivers events to `target` after pre-processing: routes and QuickConnect links.
  const into = (target: string) =>
    anyOf([
      ...groupRoutes.filter((r) => !r.disabled && r.pipeline === target).map((r) => r.filter),
      ...live.filter((i) => i.connections?.some((c) => c.pipeline === target)).map(fromInput),
    ]);

  if (pipeline.pack) {
    const outer = into(`pack:${pipeline.pack}`);
    const inner = anyOf(packRoutes.filter((r) => !r.disabled && r.pipeline === pipeline.id).map((r) => r.filter));
    if (!outer || !inner) return undefined;
    const filter = outer === 'true' ? inner : inner === 'true' ? outer : `(${outer}) && (${inner})`;
    return { filter, level: 1 };
  }

  const routed = into(pipeline.id);
  if (routed) return { filter: routed, level: 1 };
  // A pre-processing pipeline sees events before routing, so they have to be tapped at the Source.
  const pre = anyOf(live.filter((i) => i.pipeline === pipeline.id).map(fromInput));
  return pre ? { filter: pre, level: 0 } : undefined;
}
