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

export function computeFates(
  pipelines: Pipeline[],
  routes: Route[],
  inputs: Input[],
  outputs: Output[],
  traffic: RouteTraffic[],
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
    const paths: FatePath[] = [
      ...enabledRoutes
        .filter((r) => r.pipeline === target)
        .map((r) => pathFor(`Route ${r.name ?? r.id ?? ''}`, r.output, r.id ? (routeEvents.get(r.id) ?? 0) : undefined)),
      ...liveInputs.flatMap((i) =>
        (i.connections ?? [])
          .filter((c) => c.pipeline === target)
          .map((c) => pathFor(`QuickConnect from ${i.id}`, c.output, undefined)),
      ),
    ];

    if (!paths.length) {
      if (p.pack) {
        // A Pack with its own Sources: their events run the Pack's pipelines, then continue to group routes.
        const marker = `:${p.pack}.`;
        paths.push(...followInputs((input) => input.includes(marker), (routeId) => routeId.startsWith(`${p.pack}.`)));
      } else {
        // A pre-processing pipeline: its Source's events continue to whichever routes take them.
        const prefixes = liveInputs.filter((i) => i.pipeline === p.id).map(inputPrefix);
        if (prefixes.length) paths.push(...followInputs((input) => prefixes.some((x) => input.startsWith(x)), () => false));
      }
    }
    if (!paths.length) continue;

    const measured = paths.filter((x) => x.events !== undefined);
    const total = measured.reduce((n, x) => n + (x.events ?? 0), 0);
    const discarded = measured.filter((x) => x.discarded).reduce((n, x) => n + (x.events ?? 0), 0);
    // With no measured volume, fall back to counting paths so an all-discarded pipeline is still caught.
    const discardedShare = total > 0 ? discarded / total : paths.filter((x) => x.discarded).length / paths.length;
    out[p.key] = { paths: paths.sort((a, b) => (b.events ?? 0) - (a.events ?? 0)), discardedShare };
  }
  return out;
}
