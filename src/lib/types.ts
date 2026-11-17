export interface Group {
  id: string;
  type: string;
  description?: string;
}

export interface FnConf {
  id: string;
  filter?: string;
  disabled?: boolean;
  final?: boolean;
  description?: string;
  groupId?: string;
  conf?: Record<string, unknown>;
}

export interface PipelineConf {
  functions?: FnConf[];
  groups?: Record<string, { name?: string; disabled?: boolean }>;
  description?: string;
}

export interface Pipeline {
  /** Unique within a group: `<pack>.<id>` for Pack pipelines, `<id>` otherwise. Matches the `id` dimension of pipe.* metrics. */
  key: string;
  id: string;
  pack?: string;
  conf: PipelineConf;
}

export interface Sample {
  /** Unique within a group: `<pack>::<id>` for samples that live inside a Pack, `<id>` otherwise. */
  key: string;
  /** Set when the sample belongs to a Pack and is only offered to that Pack's pipelines. */
  pack?: string;
  id: string;
  sampleName: string;
  numEvents?: number;
  size?: number;
  isPackOnly?: boolean;
}

export interface Traffic {
  inEvents: number;
  outEvents: number;
  droppedEvents: number;
}

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  recommendation: string;
}

export type FnState = 'enabled' | 'disabled' | 'unreachable';

export interface FnProfile {
  /** Index into the pipeline's `conf.functions`. */
  index: number;
  durationMs: number;
  eventsIn: number;
  eventsOut: number;
  bytesIn: number;
  bytesOut: number;
  /** How far apart this function's two fastest runs were, in ms: a measure of how repeatable the timing is. */
  noiseMs?: number;
}

export interface PipelineProfile {
  /** Hash of the function list the profile was measured against; a mismatch means the pipeline changed. */
  signature: string;
  sampleId: string;
  sampleName: string;
  /** Distinct events the run was built from, before repeating them up to `events`. */
  sourceEvents?: number;
  events: number;
  totalMs: number;
  /** How far apart the two fastest whole runs were, as a ratio of the fastest. */
  spread?: number;
  at: number;
  functions: FnProfile[];
}

/** A route as far as this app cares: which pipeline (or `pack:<id>`) it sends matching events to. */
export interface Route {
  id?: string;
  name?: string;
  /** Destination ID events are sent to after the pipeline. */
  output?: string;
  filter?: string;
  pipeline?: string;
  disabled?: boolean;
}

export interface Output {
  id: string;
  type: string;
}

/** Events a route received from one Source over the selected time range. */
export interface RouteTraffic {
  routeId: string;
  input: string;
  inEvents: number;
}

/** One way a pipeline's output leaves the group, and whether it is thrown away there. */
export interface FatePath {
  /** The route or QuickConnect link the events travel through. */
  via: string;
  destination: string;
  /** Undefined when the volume on this path isn't measured. */
  events?: number;
  discarded: boolean;
  /** Why the events count as discarded. */
  reason?: string;
}

/** What happens downstream to the events a pipeline produces. */
export interface Fate {
  paths: FatePath[];
  /** Share of this pipeline's downstream events that are discarded, 0–1. */
  discardedShare: number;
  /** True when some paths carry an unknown volume, so the share covers only the measured ones. */
  incomplete?: boolean;
}

/** Worker capacity and measured load for a group over the selected time range. */
export interface WorkerLoad {
  workers: number;
  cores: number;
  /**
   * Sum of the Workers' average load averages: processes running or waiting to run (on Linux, also
   * those waiting on disk). Undefined when no load samples were reported.
   */
  busyCores?: number;
  /**
   * CPU used by the Cribl worker processes, in cores, averaged over the range and summed across the
   * Workers that answered. Undefined when no Worker could be asked.
   */
  criblCores?: number;
  /** How many Workers `criblCores` covers. */
  cpuWorkers?: number;
}

/** A Source, as far as it decides which pipeline its events go through. */
export interface Input {
  id: string;
  type: string;
  disabled?: boolean;
  /** Pre-processing pipeline, applied before routing. */
  pipeline?: string | null;
  /** QuickConnect links, which bypass the route table. */
  connections?: { pipeline?: string; output?: string }[] | null;
}

/**
 * Where to tap live events for a pipeline. Level 0 is as events leave the Source, before its
 * pre-processing pipeline; level 1 is after pre-processing, before routing.
 */
export interface CapturePlan {
  filter: string;
  level: 0 | 1;
}

export type RangeKey = '1h' | '6h' | '12h' | '24h' | '7d';
