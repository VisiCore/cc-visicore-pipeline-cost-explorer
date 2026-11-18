import { isActive } from './analysis';
import type { FnConf, Pipeline, PipelineProfile, Severity } from './types';

/**
 * Turns what the app knows into a short ranked list of things worth doing, each with the CPU time
 * at stake where it can be estimated. Every recommendation leads to a page where it can be checked.
 */

export type RecommendationKind = 'discarded' | 'reorder' | 'finding';

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  /** What to do, in a few words. */
  title: string;
  /** The pipeline it applies to. */
  where: string;
  detail: string;
  /** CPU seconds over the selected range: an estimated saving, or the cost of the thing flagged. */
  seconds?: number;
  secondsKind?: 'saves' | 'costs';
  action: { label: string; href: string };
}

/** A reducer that could run earlier, and what that would save per profiling run. */
export interface MoveSuggestion {
  /** Index of the reducer in `conf.functions`. */
  from: number;
  /** Index of the function it would be placed in front of. */
  to: number;
  /** Share of events the reducer removes, 0–1. */
  removes: number;
  /** Functions it would jump ahead of. */
  skipped: number;
  /** Milliseconds saved per profiling run. */
  savedMs: number;
}

/** Only functions whose effect is the same wherever they run; sampling earlier changes what is sampled. */
const MOVABLE = new Set(['drop', 'regex_filter']);

/** Fields present on an event before any function runs, so a filter using only these can run anywhere. */
const BASE_FIELDS = new Set(['_raw', '_time', 'source', 'sourcetype', 'host', 'index', '__inputId', 'cribl_breaker']);

const NOT_FIELDS = new Set([
  'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'in', 'new', 'void', 'delete', 'this',
  'C', 'Math', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'RegExp', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity', '__e',
]);

/** Field names an expression reads: bare identifiers, and `__e['name']` lookups. */
export function fieldsRead(expr: string): Set<string> {
  const out = new Set<string>();
  for (const m of expr.matchAll(/__e\[\s*(['"])(.+?)\1\s*\]/g)) out.add(m[2]);
  // Strings and regex literals are data, not field names.
  const code = expr
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ')
    .replace(/\/(?:\\.|[^/\n\\])+\/[gimsuy]*/g, ' ');
  for (const m of code.matchAll(/(\.?)\s*\b([A-Za-z_$][\w$]*)\b/g)) {
    if (m[1] !== '.' && !NOT_FIELDS.has(m[2])) out.add(m[2]);
  }
  return out;
}

/** Fields a function is known to create, or undefined when that can't be told from its configuration. */
function fieldsCreated(fn: FnConf): Set<string> | undefined {
  const conf = fn.conf ?? {};
  if (fn.id === 'eval') {
    const add = Array.isArray(conf.add) ? (conf.add as { name?: string }[]) : [];
    // Removing or keeping fields can take away what a later filter reads.
    if (conf.remove || conf.keep) return undefined;
    return new Set(add.map((a) => String(a.name ?? '')));
  }
  if (fn.id === 'regex_extract') {
    const sources = [conf.regex, ...(Array.isArray(conf.regexList) ? (conf.regexList as { regex?: unknown }[]).map((r) => r.regex) : [])];
    const out = new Set<string>();
    for (const src of sources) for (const m of String(src ?? '').matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)) out.add(m[1]);
    return out;
  }
  if (fn.id === 'comment') return new Set();
  return undefined;
}

/**
 * For a profiled pipeline, finds a Drop or Regex Filter that removes events late and could run
 * earlier, judged from which fields its filter reads and which functions create them. This is a
 * candidate to test, not a guarantee: the test page checks that the output stays the same.
 */
export function suggestMove(pipeline: Pipeline, profile: PipelineProfile): MoveSuggestion | undefined {
  const fns = pipeline.conf.functions ?? [];
  const measured = new Map(profile.functions.map((f) => [f.index, f]));
  let best: MoveSuggestion | undefined;

  fns.forEach((fn, from) => {
    const m = measured.get(from);
    if (!MOVABLE.has(fn.id) || !m || m.eventsIn < 50 || fn.final) return;
    const removes = 1 - m.eventsOut / m.eventsIn;
    if (removes < 0.1) return;

    const reads = fieldsRead(`${fn.filter ?? 'true'} ${fn.id === 'regex_filter' ? JSON.stringify(fn.conf ?? {}) : ''}`);
    const baseOnly = [...reads].every((f) => BASE_FIELDS.has(f));
    let to = from;
    let savedMs = 0;
    let skipped = 0;
    for (let i = from - 1; i >= 0; i--) {
      const prior = fns[i];
      if (!isActive(prior, pipeline)) continue;
      const created = fieldsCreated(prior);
      // Stop at anything that ends processing, removes events itself, or may create a field the filter needs.
      if (prior.final || MOVABLE.has(prior.id)) break;
      if (created ? [...created].some((f) => reads.has(f)) : !baseOnly) break;
      if (prior.id === 'comment') continue;
      const cost = measured.get(i);
      // Events it removes would never reach the function it jumps ahead of.
      if (cost) savedMs += cost.durationMs * removes;
      skipped++;
      to = i;
    }
    if (to < from && skipped > 0 && savedMs > (best?.savedMs ?? 0)) best = { from, to, removes, skipped, savedMs };
  });
  return best;
}

export interface RecommendInput {
  pipelines: Pipeline[];
  profiles: Record<string, PipelineProfile | undefined>;
  rows: {
    id: string;
    name: string;
    pack: string;
    functionCount: number;
    inEvents?: number;
    cpuSeconds?: number;
    profiledAt?: number;
    discardedShare?: number;
    wastedCpuSeconds?: number;
    fate?: { paths: { discarded: boolean; reason?: string }[] };
  }[];
  functions: {
    id: string;
    pipelineKey: string;
    pipeline: string;
    type: string;
    position: number;
    index: number;
    state: string;
    severity: Severity | 'none';
    cpuSeconds?: number;
    share?: number;
    findings: { severity: Severity; title: string; recommendation: string }[];
  }[];
}

const MAX_FINDINGS = 4;
const MAX_IDLE_FINDINGS = 2;
/** Findings that come from a measurement alone and name no configuration problem. */
const MEASURED_ONLY = new Set(['Pipeline hot spot', 'Slow per-event processing', 'Above-average per-event cost']);
const enc = encodeURIComponent;
const label = (row: { name: string; pack: string }) => (row.pack ? `${row.pack} / ${row.name}` : row.name);
const percent = (ratio: number) => (ratio > 0 && ratio < 0.01 ? 'Less than 1%' : `${Math.round(ratio * 100)}%`);

export function recommend({ pipelines, profiles, rows, functions }: RecommendInput): Recommendation[] {
  const out: Recommendation[] = [];
  const byKey = new Map(pipelines.map((p) => [p.key, p]));

  const working = rows.filter((r) => r.functionCount > 0 && (r.inEvents ?? 0) > 0);
  const events = working.reduce((n, r) => n + (r.inEvents ?? 0), 0);

  // 1. Work whose result is thrown away.
  for (const r of rows) {
    if ((r.discardedShare ?? 0) < 0.5 || r.functionCount === 0 || (r.inEvents ?? 0) === 0) continue;
    const reason = r.fate?.paths.find((p) => p.discarded)?.reason ?? 'Discarded downstream';
    out.push({
      id: `discarded:${r.id}`,
      kind: 'discarded',
      title: 'Stop processing output that is discarded',
      where: label(r),
      detail: `${percent(r.discardedShare ?? 0)} of its output is thrown away after processing. ${reason}. If nothing else uses that output, keep those events out of the pipeline.`,
      seconds: r.wastedCpuSeconds,
      secondsKind: 'saves',
      action: { label: 'View pipeline', href: `/pipelines/${enc(r.id)}` },
    });
  }

  // 2. Events removed late that could be removed early.
  for (const r of rows) {
    const pipeline = byKey.get(r.id);
    const profile = profiles[r.id];
    if (!pipeline || !profile || r.profiledAt === undefined) continue;
    const move = suggestMove(pipeline, profile);
    if (!move || profile.totalMs <= 0) continue;
    const share = move.savedMs / profile.totalMs;
    // Not worth a recommendation unless it is a visible part of the pipeline's cost.
    if (share < 0.05) continue;
    const fn = pipeline.conf.functions![move.from];
    const target = pipeline.conf.functions![move.to];
    out.push({
      id: `reorder:${r.id}:${move.from}`,
      kind: 'reorder',
      title: `Move ${fn.id} #${move.from + 1} ahead of ${target.id} #${move.to + 1}`,
      where: label(r),
      detail: `It removes ${percent(move.removes)} of events, but ${move.skipped === 1 ? 'one function runs' : `${move.skipped} functions run`} on them first. Its filter appears not to need fields created by ${move.skipped === 1 ? 'that function' : 'those functions'}, so running it earlier should cut about ${percent(share)} of this pipeline's cost. Test it to confirm the output stays the same.`,
      seconds: r.cpuSeconds === undefined ? undefined : r.cpuSeconds * share,
      secondsKind: 'saves',
      action: { label: 'Test this change', href: `/pipelines/${enc(r.id)}/test?move=${move.from}:${move.to}` },
    });
  }

  // 3. Configuration findings on the functions that cost the most.
  const trafficOf = new Map(rows.map((r) => [r.id, r.inEvents ?? 0]));
  const flagged = functions
    .filter((f) => f.state === 'enabled' && (f.severity === 'high' || f.severity === 'medium'))
    .sort(
      (a, b) =>
        (b.cpuSeconds ?? 0) - (a.cpuSeconds ?? 0) ||
        (trafficOf.get(b.pipelineKey) ?? 0) - (trafficOf.get(a.pipelineKey) ?? 0) ||
        (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0),
    );
  let idle = 0;
  let listed = 0;
  const seen = new Set<string>();
  for (const f of flagged) {
    if (listed >= MAX_FINDINGS) break;
    // One per pipeline: the costliest flagged function is where to start.
    if (seen.has(f.pipelineKey)) continue;
    const busy = (trafficOf.get(f.pipelineKey) ?? 0) > 0;
    // A flagged function in a pipeline with no traffic costs nothing today; a couple are enough as a reminder.
    if (!busy && events > 0 && ++idle > MAX_IDLE_FINDINGS) continue;
    // A finding about the configuration says what to fix; a function that is merely slow has no fix to
    // offer here, and already shows in the cost ranking.
    const specific = f.findings.find((x) => !MEASURED_ONLY.has(x.title) && x.severity !== 'low');
    if (!specific) continue;
    seen.add(f.pipelineKey);
    listed++;
    const cost =
      !busy && events > 0
        ? 'This pipeline received no events in the selected range, so it costs nothing right now.'
        : f.share === undefined
          ? 'Not measured yet, so its cost is unknown.'
          : `This function is ${percent(f.share)} of the pipeline's measured time.`;
    out.push({
      id: `finding:${f.id}`,
      kind: 'finding',
      title: `${f.type} #${f.position}: ${specific.title.charAt(0).toLowerCase()}${specific.title.slice(1)}`,
      where: f.pipeline,
      detail: `${specific.recommendation} ${cost}`,
      seconds: f.cpuSeconds,
      secondsKind: 'costs',
      action: { label: 'Test a change', href: `/pipelines/${enc(f.pipelineKey)}/test?fn=${f.index}` },
    });
  }

  // Estimated savings first, largest first; then costs; then things with no number yet.
  const rank = (r: Recommendation) => (r.seconds === undefined ? 0 : r.secondsKind === 'saves' ? 2 : 1);
  return out.sort((a, b) => rank(b) - rank(a) || (b.seconds ?? 0) - (a.seconds ?? 0));
}

/** How efficient a pipeline is, as far as can be told from what has been measured. */
export type Rating = 'inefficient' | 'review' | 'efficient' | 'unmeasured' | 'idle';

export const RATING_RANK: Record<Rating, number> = { inefficient: 4, review: 3, unmeasured: 2, efficient: 1, idle: 0 };

/** Per-event cost, in microseconds, above which a pipeline is worth a look, and above which it is clearly heavy. */
export interface Thresholds {
  reviewUs: number;
  heavyUs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { reviewUs: 15, heavyUs: 50 };

/** Stored thresholds are only used when they make sense: positive, and review below heavy. */
export function validThresholds(value: unknown): Thresholds | undefined {
  const v = value as Partial<Thresholds> | null;
  return typeof v?.reviewUs === 'number' && typeof v.heavyUs === 'number' && v.reviewUs > 0 && v.reviewUs < v.heavyUs
    ? { reviewUs: v.reviewUs, heavyUs: v.heavyUs }
    : undefined;
}

/**
 * Rates one pipeline. "Inefficient" means there is measured evidence of wasted work: output that is
 * thrown away, a heavy per-event cost, events removed late, or a flagged function that dominates
 * the pipeline. "Review" means something is worth a look. Reasons come most serious first.
 */
export function ratePipeline(p: {
  functionCount: number;
  inEvents?: number;
  profiled: boolean;
  usPerEvent?: number;
  discardedShare?: number;
  /** Share of the pipeline's cost a suggested reorder would save, and the function to move. */
  move?: { share: number; what: string };
  /** Configuration findings on its functions: the finding, and that function's share of pipeline time. */
  findings: { severity: Severity; title: string; share?: number }[];
}, thresholds: Thresholds = DEFAULT_THRESHOLDS): { rating: Rating; reasons: string[] } {
  const busy = (p.inEvents ?? 0) > 0;
  const strong: string[] = [];
  const mild: string[] = [];
  if (busy && (p.discardedShare ?? 0) >= 0.5) strong.push('Output is discarded downstream');
  if (p.usPerEvent !== undefined && p.usPerEvent >= thresholds.heavyUs) strong.push(`${Math.round(p.usPerEvent)} µs per event`);
  else if (p.usPerEvent !== undefined && p.usPerEvent >= thresholds.reviewUs) mild.push(`${Math.round(p.usPerEvent)} µs per event`);
  if (p.move && p.move.share >= 0.2) strong.push(`${p.move.what} removes events late`);
  else if (p.move && p.move.share >= 0.05) mild.push(`${p.move.what} removes events late`);
  const specific = p.findings.filter((f) => !MEASURED_ONLY.has(f.title) && f.severity !== 'low');
  for (const f of specific) {
    (f.severity === 'high' && (f.share ?? 0) >= 0.25 ? strong : mild).push(f.title);
  }
  const reasons = [...new Set([...strong, ...mild])];
  if (p.functionCount === 0) return { rating: busy ? 'efficient' : 'idle', reasons: busy ? ['No functions'] : [] };
  // A pipeline known to have had no events costs nothing right now, whatever its configuration says.
  if (!p.profiled && p.inEvents !== undefined && !busy) return { rating: 'idle', reasons };
  // Without a measurement, configuration findings alone can only say "look at this".
  if (!p.profiled) return { rating: strong.length || mild.length ? 'review' : busy ? 'unmeasured' : 'idle', reasons };
  return { rating: strong.length ? 'inefficient' : mild.length ? 'review' : 'efficient', reasons };
}
