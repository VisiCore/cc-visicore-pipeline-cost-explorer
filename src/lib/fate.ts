import { isActive } from './analysis';
import type { Fate, FatePath, Input, Output, Pipeline, Route, RouteTraffic } from './types';

/**
 * Works out what happens to a pipeline's output after it leaves the pipeline, to find pipelines
 * that spend compute on events which are then thrown away. It combines configuration (which route
 * sends to which Destination) with route metrics (which Source's events each route actually
 * received), so pre-processing pipelines are followed through the routes their events really take.
 */

const isAlwaysTrue = (filter?: string) => !filter || filter.trim() === '' || filter.trim() === 'true';

/** A pipeline whose first active function drops every event. */
export function dropsEverything(pipeline: Pipeline | undefined): boolean {
  if (!pipeline) return false;
  const first = (pipeline.conf.functions ?? []).find((fn) => isActive(fn, pipeline));
  return !!first && first.id === 'drop' && isAlwaysTrue(first.filter);
}

/** The `input` value route metrics report for a Source. Internal metrics report as `cribl:`. */
const inputPrefix = (input: Input) => `${input.type === 'criblmetrics' ? 'cribl' : input.type}:${input.id}`;
/** Some Sources add a `:suffix` to their ID; a bare prefix match would also take in Source `foo2`. */
const fromInput = (reported: string, prefix: string) => reported === prefix || reported.startsWith(`${prefix}:`);

export function computeFates(
  pipelines: Pipeline[],
  routes: Route[],
  inputs: Input[],
  outputs: Output[],
  traffic: RouteTraffic[],
  /** Route tables of the Packs whose pipelines should be traced individually, keyed by Pack ID. */
  packRoutes: Record<string, Route[]> = {},
): Record<string, Fate> {
  const byId = new Map(pipelines.filter((p) => !p.pack).map((p) => [p.id, p]));
  const outputType = new Map(outputs.map((o) => [o.id, o.type]));
  const enabledRoutes = routes.filter((r) => !r.disabled);
  const routeById = new Map(enabledRoutes.filter((r) => r.id).map((r) => [r.id!, r]));
  const liveInputs = inputs.filter((i) => !i.disabled);
  const routeEvents = new Map<string, number>();
  for (const t of traffic) routeEvents.set(t.routeId, (routeEvents.get(t.routeId) ?? 0) + t.inEvents);

  const discardReason = (output: string | undefined, viaPipeline?: string): string | undefined => {
    if (output && outputType.get(output) === 'devnull') return 'Sent to a DevNull Destination';
    if (viaPipeline && dropsEverything(byId.get(viaPipeline))) return `Dropped by the ${viaPipeline} pipeline`;
    return undefined;
  };

  const pathFor = (via: string, output: string | undefined, events: number | undefined, viaPipeline?: string): FatePath => {
    const reason = discardReason(output, viaPipeline);
    return { via, destination: output ?? 'default', events, discarded: !!reason, reason };
  };

  /** Follows events from the given Sources through the group routes they were actually seen on. */
  const followInputs = (matches: (input: string) => boolean, skipRoute: (routeId: string) => boolean): FatePath[] => {
    const perRoute = new Map<string, number>();
    for (const t of traffic) {
      if (!matches(t.input) || skipRoute(t.routeId) || !routeById.has(t.routeId)) continue;
      perRoute.set(t.routeId, (perRoute.get(t.routeId) ?? 0) + t.inEvents);
    }
    return [...perRoute.entries()].map(([routeId, events]) => {
      const r = routeById.get(routeId)!;
      return pathFor(`Route ${r.name ?? routeId}`, r.output, events, r.pipeline);
    });
  };

  const out: Record<string, Fate> = {};
  for (const p of pipelines) {
    // A pipeline that exists to drop events is the thing doing the discarding, not a victim of it.
    if (dropsEverything(p)) continue;
    const target = p.pack ? `pack:${p.pack}` : p.id;

    // Routes and QuickConnect links that run this pipeline (or its Pack) and then send onward.
    let paths: FatePath[] = [
      ...enabledRoutes
        .filter((r) => r.pipeline === target)
        .map((r) => pathFor(`Route ${r.name ?? r.id ?? ''}`, r.output, r.id ? (routeEvents.get(r.id) ?? 0) : undefined)),
      ...liveInputs.flatMap((i) =>
        (i.connections ?? [])
          .filter((c) => c.pipeline === target)
          .map((c) => pathFor(`QuickConnect from ${i.id}`, c.output, undefined)),
      ),
    ];

    if (p.pack) {
      // A Pack with its own Sources: their events run the Pack's pipelines, then continue to group routes.
      const marker = `:${p.pack}.`;
      if (!paths.length) {
        paths.push(...followInputs((input) => input.includes(marker), (routeId) => routeId.startsWith(`${p.pack}.`)));
      }
    } else {
      // Also used for pre-processing: that Source's events continue to whichever routes take them. This
      // is in addition to any route that runs the pipeline directly, since a pipeline can be used both ways.
      const prefixes = liveInputs.filter((i) => i.pipeline === p.id).map(inputPrefix);
      if (prefixes.length) {
        paths.push(...followInputs((input) => prefixes.some((x) => fromInput(input, x)), () => false));
      }
    }
    if (!paths.length) continue;

    // Inside a Pack, each pipeline only handles the events its own Pack routes send it.
    let unattributed = false;
    const inner = p.pack ? packRoutes[p.pack]?.filter((r) => !r.disabled && r.pipeline === p.id) : undefined;
    if (p.pack && inner) {
      // No Pack route runs this pipeline, so nothing can be said about where its output goes.
      if (!inner.length) continue;
      const innerEvents = inner.reduce((n, r) => n + (r.id ? (routeEvents.get(`${p.pack}.${r.id}`) ?? 0) : 0), 0);
      const names = inner.map((r) => r.name ?? r.id ?? '').join(', ');
      // With one way out of the Pack, this pipeline's events all take it. With several that end
      // differently, there is no telling which of them this pipeline's events take.
      unattributed = new Set(paths.map((x) => x.discarded)).size > 1;
      const single = paths.length === 1;
      paths = paths.map((x) => ({
        ...x,
        via: `Pack route ${names}, then ${x.via.replace(/^Route /, 'route ')}`,
        events: single ? innerEvents : x.events,
      }));
    }

    const measured = paths.filter((x) => x.events !== undefined);
    const total = measured.reduce((n, x) => n + (x.events ?? 0), 0);
    const discarded = measured.filter((x) => x.discarded).reduce((n, x) => n + (x.events ?? 0), 0);
    // With no measured volume, fall back to counting paths so an all-discarded pipeline is still caught.
    const discardedShare = total > 0 ? discarded / total : paths.filter((x) => x.discarded).length / paths.length;
    out[p.key] = {
      paths: paths.sort((a, b) => (b.events ?? 0) - (a.events ?? 0)),
      discardedShare,
      // QuickConnect volume isn't measured, so a share worked out from the routes alone may be far off.
      incomplete: unattributed || (total > 0 && measured.length < paths.length),
    };
  }
  return out;
}
