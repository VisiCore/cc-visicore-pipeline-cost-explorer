import type {
  Group,
  Input,
  Output,
  Pipeline,
  PipelineConf,
  Route,
  RouteTraffic,
  Sample,
  Traffic,
  WorkerLoad,
} from './types';

declare global {
  interface Window {
    CRIBL_API_URL: string;
    CRIBL_BASE_PATH: string;
    getCriblUser?: () => Promise<{ id: string; username: string }>;
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${window.CRIBL_API_URL}${path}`, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 403) message = `Access denied for ${path.split('?')[0]} (check config/policies.yml)`;
    throw new ApiError(res.status, message);
  }
  return res;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await request(path, { signal })).json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return res.json() as Promise<T>;
}

interface Items<T> {
  items: T[];
}

const enc = encodeURIComponent;

/** Worker Groups and Edge Fleets (anything that runs pipelines). */
export async function listGroups(): Promise<Group[]> {
  const { items } = await getJson<Items<Group & { isSearch?: boolean }>>('/master/groups');
  return items
    .filter((g) => g.type === 'stream' || g.type === 'edge')
    .map((g) => ({ id: g.id, type: g.type, description: g.description }));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type RawPipeline = { id: string; conf?: PipelineConf };

/** Every pipeline in the group, including pipelines that live inside Packs. */
export async function listPipelines(
  groupId: string,
): Promise<{ pipelines: Pipeline[]; packSamples: Sample[]; warnings: string[] }> {
  const g = enc(groupId);
  const warnings: string[] = [];
  const [own, packs] = await Promise.all([
    getJson<Items<RawPipeline>>(`/m/${g}/pipelines`),
    getJson<Items<{ id: string }>>(`/m/${g}/packs`).catch((e: Error) => {
      warnings.push(`Packs could not be listed: ${e.message}`);
      return { items: [] };
    }),
  ]);

  const pipelines: Pipeline[] = own.items
    // `pack:<id>` entries are references to a Pack, not pipelines with functions of their own.
    .filter((p) => !p.id.startsWith('pack:'))
    .map((p) => ({ key: p.id, id: p.id, conf: p.conf ?? {} }));

  const packSamples: Sample[] = [];
  const perPack = await mapLimit(packs.items, 6, async (pack) => {
    // A Pack's own samples are a convenience; failing to list them must not hide its pipelines.
    const samples = getJson<Items<RawSample>>(`/m/${g}/p/${enc(pack.id)}/system/samples`)
      .then((res) =>
        res.items
          // Packs also list the built-in template samples, which the group already offers.
          .filter((s) => !s.isTemplate)
          .map<Sample>((s) => ({ ...s, key: `${pack.id}::${s.id}`, pack: pack.id })),
      )
      .catch(() => [] as Sample[]);
    try {
      const res = await getJson<Items<RawPipeline>>(`/m/${g}/p/${enc(pack.id)}/pipelines`);
      packSamples.push(...(await samples));
      return res.items.map<Pipeline>((p) => ({
        key: `${pack.id}.${p.id}`,
        id: p.id,
        pack: pack.id,
        conf: p.conf ?? {},
      }));
    } catch (e) {
      warnings.push(`Pack ${pack.id}: ${(e as Error).message}`);
      return [];
    }
  });
  for (const list of perPack) pipelines.push(...list);
  return { pipelines, packSamples, warnings };
}

type RawSample = Omit<Sample, 'key' | 'pack'> & { isTemplate?: boolean };

export async function listSamples(groupId: string): Promise<Sample[]> {
  const { items } = await getJson<Items<RawSample>>(`/m/${enc(groupId)}/system/samples`);
  return items.map((s) => ({ ...s, key: s.id }));
}

export async function getSampleEvents(
  groupId: string,
  sample: Sample,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const scope = sample.pack ? `/p/${enc(sample.pack)}` : '';
  const body = await getJson<unknown>(
    `/m/${enc(groupId)}${scope}/system/samples/${enc(sample.id)}/content`,
    signal,
  );
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const items = (body as Items<Record<string, unknown>>)?.items;
  return Array.isArray(items) ? items : [];
}

/** The group's route table, or a Pack's own route table when `pack` is given. */
export async function listRoutes(groupId: string, pack?: string): Promise<Route[]> {
  const scope = pack ? `/p/${enc(pack)}` : '';
  const { items } = await getJson<Items<{ routes?: Route[] }>>(`/m/${enc(groupId)}${scope}/routes`);
  return items.flatMap((table) => table.routes ?? []);
}

/** The group's Sources, read for the pipelines attached to them directly. */
export async function listInputs(groupId: string): Promise<Input[]> {
  const { items } = await getJson<Items<Input>>(`/m/${enc(groupId)}/system/inputs`);
  return items;
}

/** The group's Destinations, read for their type (to recognize ones that discard events). */
export async function listOutputs(groupId: string): Promise<Output[]> {
  const { items } = await getJson<Items<Output>>(`/m/${enc(groupId)}/system/outputs`);
  return items.map((o) => ({ id: o.id, type: o.type, pipeline: o.pipeline }));
}

const groupWhere = (groupId: string) => `__worker_group == '${groupId.replace(/['\\]/g, '\\$&')}'`;

/** Events each route received from each Source, which shows where a Source's events actually end up. */
export async function getRouteTraffic(groupId: string, earliest: number, latest: number): Promise<RouteTraffic[]> {
  const res = await postJson<{ results?: Record<string, unknown>[] }>('/system/metrics/query', {
    where: groupWhere(groupId),
    aggs: { aggregations: ['sum("route.in_events").as("in_events")'], splitBys: ['id', 'input'], cumulative: true },
    earliest,
    latest,
  });
  return (res.results ?? [])
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({ routeId: String(row.id), input: String(row.input ?? ''), inEvents: Number(row.in_events ?? 0) }));
}

/**
 * Worker count, cores, and average load for a group. Load is the hosts' load average, which counts
 * every process on the machine, not only Cribl, so it is an upper bound on what Cribl is using.
 */
/** Workers asked directly for their CPU use; enough to characterize a group without flooding a large Fleet. */
const MAX_CPU_WORKERS = 20;

/** CPU used by one Worker's Cribl processes over the range, in cores. Asked of the Worker itself. */
async function workerCpuCores(workerId: string, earliest: number, latest: number): Promise<number | undefined> {
  try {
    const res = await postJson<{ results?: Record<string, unknown>[] }>(`/w/${enc(workerId)}/system/metrics/query`, {
      where: 'true',
      aggs: { aggregations: ['avg("system.cpu_perc").as("cpu")'], splitBys: ['__worker_process'], cumulative: true },
      earliest,
      latest,
    });
    if (!res.results?.length) return undefined;
    // Each worker process reports the percentage of one core it is using.
    return res.results.reduce((n, row) => n + Number(row.cpu ?? 0), 0) / 100;
  } catch {
    return undefined;
  }
}

export async function getWorkerLoad(groupId: string, earliest: number, latest: number): Promise<WorkerLoad> {
  const [workers, load] = await Promise.all([
    getJson<Items<{ id: string; group?: string; disconnected?: boolean; info?: { cpus?: number } }>>(
      `/master/workers?filterExp=${enc(`group=='${groupId.replace(/['\\]/g, '\\$&')}'`)}&limit=1000`,
    ),
    postJson<{ results?: Record<string, unknown>[] }>('/system/metrics/query', {
      where: groupWhere(groupId),
      aggs: { aggregations: ['avg("system.load_avg").as("load")'], splitBys: ['__worker_node'], cumulative: true },
      earliest,
      latest,
    }),
  ]);
  // A node that is not connected contributes neither capacity nor load.
  const mine = workers.items.filter((w) => w.group === groupId && !w.disconnected);
  const cpu = (
    await mapLimit(mine.slice(0, MAX_CPU_WORKERS), 4, (w) => workerCpuCores(w.id, earliest, latest))
  ).filter((c): c is number => c !== undefined);
  return {
    criblCores: cpu.length ? cpu.reduce((n, c) => n + c, 0) : undefined,
    cpuWorkers: cpu.length,
    workers: mine.length,
    cores: mine.reduce((n, w) => n + Number(w.info?.cpus ?? 0), 0),
    // No samples is "unknown", which must not be shown as an idle group.
    busyCores: load.results?.length ? load.results.reduce((n, row) => n + Number(row.load ?? 0), 0) : undefined,
  };
}

export const CAPTURE_SECONDS = 10;
export const CAPTURE_MAX_EVENTS = 1000;

/**
 * Captures live events matching `filter` on the Workers at the given tap point (see CapturePlan).
 * Read-only: it taps the stream and changes nothing. Ends when enough events are captured or the
 * time is up, whichever comes first.
 */
export async function captureEvents(
  groupId: string,
  filter: string,
  level: 0 | 1 | 2,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const res = await request(`/m/${enc(groupId)}/system/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter, maxEvents: CAPTURE_MAX_EVENTS, duration: CAPTURE_SECONDS, level }),
    signal,
  });
  const events: Record<string, unknown>[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      // The stream can carry control records alongside events.
      if (event.__criblEventType === undefined || event.__criblEventType === 'event') events.push(event);
    } catch {
      /* skip a partial trailing line */
    }
  }
  return events;
}

/** Per-pipeline event counts for a group over [earliest, latest] (epoch ms), keyed by pipeline key. */
export async function getTraffic(groupId: string, earliest: number, latest: number): Promise<Record<string, Traffic>> {
  const res = await postJson<{ results?: Record<string, unknown>[] }>('/system/metrics/query', {
    where: `__worker_group == '${groupId.replace(/['\\]/g, '\\$&')}'`,
    aggs: {
      aggregations: [
        'sum("pipe.in_events").as("in_events")',
        'sum("pipe.out_events").as("out_events")',
        'sum("pipe.dropped_events").as("dropped_events")',
      ],
      splitBys: ['id'],
      cumulative: true,
    },
    earliest,
    latest,
  });
  const out: Record<string, Traffic> = {};
  for (const row of res.results ?? []) {
    if (typeof row.id !== 'string') continue;
    out[row.id] = {
      inEvents: Number(row.in_events ?? 0),
      outEvents: Number(row.out_events ?? 0),
      droppedEvents: Number(row.dropped_events ?? 0),
    };
  }
  return out;
}

export interface PreviewStats {
  duration: number;
  functions: {
    func: string;
    duration: number;
    eventsIn: number;
    eventsOut: number;
    bytesIn: number;
    bytesOut: number;
  }[];
}

export interface PreviewResult {
  stats: PreviewStats;
  /** The events the pipeline produced. */
  items: Record<string, unknown>[];
}

/**
 * Runs events through a pipeline in the Leader's preview sandbox (`mode: pipe`) with CPU profiling,
 * which makes the response include per-function timings. Nothing is routed or sent to Destinations,
 * and no configuration is changed.
 */
export async function previewPipeline(
  groupId: string,
  pipeline: Pipeline,
  events: Record<string, unknown>[],
  signal?: AbortSignal,
): Promise<PreviewResult> {
  const res = await postJson<{ stats?: PreviewStats; items?: Record<string, unknown>[]; message?: string }>(
    `/m/${enc(groupId)}/preview`,
    {
      mode: 'pipe',
      pipelineId: pipeline.id,
      // Always sent inline: Pack pipelines aren't addressable by ID from the group context, and for
      // the rest it guarantees the measured config is the one the results are shown against.
      pipelineConf: pipeline.conf,
      sampleId: '',
      events,
      cpuProfile: true,
      timeout: 20000,
    },
    signal,
  );
  if (!res.stats?.functions) throw new Error(res.message || 'Preview returned no function statistics');
  // A preview that timed out or failed part-way still returns statistics, for the events it got to.
  // Timings from it would be divided by the full event count and come out too low.
  const reached = res.stats.functions[0]?.eventsIn;
  if (reached !== undefined && reached < events.length) {
    throw new Error(`Preview processed only ${reached} of ${events.length} events; try again or use fewer events`);
  }
  // Control records such as stats can travel alongside the output events.
  const items = (res.items ?? []).filter((e) => e.__criblEventType === undefined || e.__criblEventType === 'event');
  return { stats: res.stats, items };
}

/* ---------- KV store (persistence is optional; the app works without it) ---------- */

/** `ok: false` means the read failed, which is different from the key not existing (`ok: true`, no value). */
export type KvRead<T> = { ok: true; value?: T } | { ok: false };

export async function kvRead<T>(key: string): Promise<KvRead<T>> {
  let text: string;
  try {
    text = await (await request(`/kvstore/${key}`)).text();
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? { ok: true } : { ok: false };
  }
  try {
    let value: unknown = JSON.parse(text);
    // Tolerate a value that was stored double-encoded.
    if (typeof value === 'string') value = JSON.parse(value);
    return { ok: true, value: value as T };
  } catch {
    // The key exists but doesn't hold JSON this app wrote, so there is nothing in it to preserve.
    return { ok: true };
  }
}

/** Best-effort read for values that are safe to lose, such as preferences. */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const res = await kvRead<T>(key);
  return res.ok ? res.value : undefined;
}

/** Writes only keys this app owns (its own preferences and cached profile results). Resolves false on failure. */
export async function kvSet(key: string, value: unknown): Promise<boolean> {
  try {
    await request(`/kvstore/${key}`, {
      method: 'PUT',
      // The KV store keeps strings. Sent as JSON, the body is parsed and then stored as the literal
      // text "[object Object]", so the JSON is sent as plain text and parsed again on read.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(value),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds entries to a stored map without dropping what is already there. The current value is re-read
 * first so other users' entries survive, and nothing is written when that read fails, because
 * writing then would replace the whole map with only the new entries.
 */
export async function kvMerge<T>(key: string, entries: Record<string, T>): Promise<boolean> {
  const current = await kvRead<Record<string, T>>(key);
  if (!current.ok) return false;
  return kvSet(key, { ...current.value, ...entries });
}
