import { useRef } from 'react';
import { Prose, TableOfContents } from '@capra/core';

export function Documentation() {
  const contentRef = useRef<HTMLElement>(null);
  return (
    <div className="page-scroll">
      <div className="page-grid doc-grid">
        <div className="doc-reading">
          <Prose as="article" ref={contentRef}>
            <h1>Function Profiler</h1>
            <p>
              Function Profiler finds the functions in a Worker Group's pipelines that are inefficient or that consume
              the most processing time. It combines three sources: the pipeline configuration, measured per-function
              timings from pipeline preview, and per-pipeline event counts from Cribl's internal metrics.
            </p>

            <h2>Getting started</h2>
            <ol>
              <li>Choose a Worker Group or Fleet in the page header. Your choice is remembered.</li>
              <li>
                Open <strong>Functions</strong> to see configuration findings right away. No profiling is needed for
                these.
              </li>
              <li>
                Open <strong>Pipelines</strong>, select a pipeline's name to open it, select{' '}
                <strong>Profile pipeline</strong>, choose live capture or a saved sample that
                represents its data, and run the profile.
              </li>
              <li>
                Return to <strong>Overview</strong> or <strong>Functions</strong>. Functions are now ranked by measured
                cost.
              </li>
            </ol>

            <h2>Drilling down</h2>
            <ul>
              <li>Labels on the summary cards open the list behind the number, already filtered.</li>
              <li>A pipeline's name opens that pipeline: its functions in execution order with cost and findings.</li>
              <li>A function's name opens its details: measurements, findings, filter, and configuration.</li>
              <li>A finding's name lists every function in the group with the same finding.</li>
            </ul>
            <p>Filters are kept in the page address, so a filtered view can be bookmarked or shared.</p>

            <h2>Where the numbers come from</h2>
            <h3>Configuration findings</h3>
            <p>
              Every function's configuration is checked against a set of rules for patterns that are commonly
              expensive. Findings are heuristics: they say a pattern is worth a look, they do not prove it is slow.
              Examples:
            </p>
            <ul>
              <li>Regular expressions with nested quantifiers or several greedy wildcards.</li>
              <li>Mask functions with many rules or wildcard field lists.</li>
              <li>Lookups in regex or CIDR match mode.</li>
              <li>The same field parsed more than once in a pipeline.</li>
              <li>Code, Grok, DNS Lookup, Redis, and Sensitive Data Scanner functions.</li>
              <li>Drop, Sampling, and Suppress functions placed after expensive functions.</li>
              <li>Functions that can never run because an earlier function is Final with a filter of true.</li>
            </ul>

            <h3>Measured timings</h3>
            <p>
              Profiling runs events through the pipeline using Cribl's pipeline preview with CPU profiling turned on.
              Preview reports the time spent in each function. The events are repeated up to 1,000 so that start-up
              cost does not dominate, and each pipeline is run twice with the faster result kept. A pipeline with
              functions that keep state between events (Aggregations, Rollup Metrics, Suppress, Sampling, Dynamic
              Sampling) is never given repeated events, because seeing the same events again changes what those
              functions do. Each of its events is run once, and it is run four times instead of twice. The events
              come from one of two places:
            </p>
            <ul>
              <li>
                <strong>Live capture</strong> taps events arriving from Sources on the Workers for up to 10 seconds,
                up to 1,000 events, selected by a filter expression. This is the closest thing to real traffic.
                A quiet pipeline with stateful functions is captured up to three times in a row to collect enough
                distinct events. Captured events are never saved.
              </li>
              <li>
                <strong>Saved sample</strong> uses a sample file from the Worker Group or from the pipeline's Pack.
                Use this when the pipeline has no traffic right now, or when you want a repeatable comparison.
              </li>
            </ul>
            <ul>
              <li>
                <strong>Time per event (µs)</strong> is the function's time divided by the events that reached it.
              </li>
              <li>
                <strong>Share of pipeline time</strong> is the function's time as a fraction of all functions in the
                pipeline.
              </li>
            </ul>
            <p>
              Preview runs on the Leader, not on your Workers, and nothing is sent to Destinations. Treat the timings
              as relative: they rank functions against each other reliably, but absolute values on your Workers will
              differ with hardware and load.
            </p>

            <h3>CPU time</h3>
            <p>
              <strong>CPU time (s)</strong> is an estimate: the measured time per pipeline event multiplied by the
              number of events that entered the pipeline in the selected time range (the{' '}
              <code>pipe.in_events</code> metric). It answers "which function costs the most given real traffic". It
              is empty for pipelines that have not been profiled or that had no traffic in the range.
            </p>

            <h2>Output discarded downstream</h2>
            <p>
              A pipeline can be efficient and still be wasted work, if the events it produces are then thrown away.
              The app traces each pipeline's output to find this:
            </p>
            <ul>
              <li>For a pipeline on a route or QuickConnect link, it reads the Destination that route sends to.</li>
              <li>
                For a pre-processing pipeline, it uses route metrics to see which routes actually received that
                Source's events, then reads where those routes send them.
              </li>
              <li>For a Pack pipeline, it follows the route into the Pack, or the Pack's own Sources.</li>
            </ul>
            <p>
              Output counts as discarded when it is sent to a DevNull Destination, or to a pipeline whose first
              function drops every event. Pipelines with at least half their output discarded are listed on the
              Overview and flagged on their own page, which also shows every path the output takes.
            </p>
            <p>
              This is traced from configuration and metrics, not from following individual events. Check the paths
              shown before acting, and remember that a pipeline inside a Pack is given the Pack's result as a whole.
            </p>

            <h2>Worker load check</h2>
            <p>
              The Overview compares the estimated CPU time of profiled pipelines with the load the Workers report,
              so you can tell whether pipeline functions are where the load comes from.
            </p>
            <ul>
              <li>
                <strong>Average load</strong> is the sum of the Workers' load averages over the selected time range,
                expressed as cores busy.
              </li>
              <li>
                <strong>Profiled pipeline functions</strong> is the estimated CPU time of all profiled pipelines, and
                its share of that load.
              </li>
              <li>
                <strong>Traffic accounted for</strong> is the share of pipeline events that went through a profiled
                pipeline or one with no functions. A conclusion is only drawn once this reaches 80%.
              </li>
            </ul>
            <p>
              Load average counts every process on the host, not only Cribl, so it is an upper bound. A low share
              means most Worker load is outside pipeline functions: receiving and parsing at Sources, serializing
              and sending at Destinations, or other software on the machine.
            </p>

            <h2>Choosing the events</h2>
            <p>
              Timings depend on the events used. A parser is cheap on events it does not match and expensive on ones
              it does, so the events should be the ones the pipeline really receives.
            </p>
            <h3>Live capture filter</h3>
            <p>
              The capture filter is a JavaScript expression evaluated against each live event. The app suggests one
              from how the pipeline is wired in:
            </p>
            <ul>
              <li>Routes that send to the pipeline: their filters are combined, and events are captured before routing.</li>
              <li>QuickConnect links from a Source to the pipeline: events from that Source, captured before routing.</li>
              <li>
                Sources that use the pipeline for pre-processing: events from that Source, captured as they leave
                the Source.
              </li>
              <li>For a Pack pipeline, whatever sends events into the Pack is combined with the Pack's own routes.</li>
            </ul>
            <p>Check the suggestion before running:</p>
            <ul>
              <li>It ignores route order and Final flags, so it can match events that an earlier route takes.</li>
              <li>
                Nothing is suggested for pipelines attached only to a Destination. Enter an expression yourself,
                such as a match on <code>__inputId</code>.
              </li>
              <li>A capture comes back empty if no matching events arrive within 10 seconds.</li>
            </ul>
            <h3>Profiling many pipelines</h3>
            <p>
              <strong>Profile matched</strong> on the Pipelines page lists every unprofiled pipeline that is
              receiving events and has a suggested capture filter or a saved sample, shows what each will be profiled
              with, and runs them one at a time once you confirm. Live capture is used where a filter can be
              suggested; if a capture comes back empty and the pipeline has a saved sample, the sample is used.
            </p>
            <h3>Saved samples</h3>
            <p>
              When a sample's name contains the pipeline's name, it is suggested. A suggestion is only remembered
              once you run a profile with it yourself. Samples are managed in Cribl under Processing, Knowledge,
              Sample Data. This app reads samples but never creates or changes them.
            </p>

            <h2>Testing a change</h2>
            <p>
              <strong>Test a change</strong> on a pipeline's page lets you try an edit and measure it before touching
              the pipeline in Cribl. Select a function to change its filter or configuration, disable it, mark it
              Final, or move it earlier or later. Then run the comparison.
            </p>
            <ul>
              <li>
                The saved pipeline and your edited version are run against exactly the same events, three times
                each, taking turns, with the fastest time per function kept.
              </li>
              <li>
                Times are shown per event entering the pipeline, so the function rows add up to the pipeline total
                and moving a Drop earlier shows up as lower cost in the functions after it.
              </li>
              <li>
                The page reports how far apart the two fastest runs of the same version were. A difference between
                the versions that is smaller than that, or smaller than 5%, is marked as within noise.
              </li>
              <li>
                The output events of the two versions are compared, ignoring internal fields that start with two
                underscores. If they differ, the first differing event is shown for both versions. A field that
                changes between runs of the same version, such as a timestamp set when the event is produced, is
                left out and named. If the number of events changes between runs, the output cannot be compared.
              </li>
              <li>
                After the first run you can choose <strong>Same events</strong> to measure further edits against the
                events already collected.
              </li>
            </ul>
            <p>
              Nothing on that page is saved. Both versions are sent to Cribl's preview with the request, the
              pipeline in Cribl is not changed, and your edits are discarded when you leave the page. To keep a
              change, make the same edit in Cribl.
            </p>

            <h2>What the app stores</h2>
            <p>
              Profile results, your sample choice per pipeline, and your last Worker Group and time range are saved in
              this app's own key-value store. A saved profile is ignored automatically when the pipeline's functions
              change. The app makes no changes to pipelines, routes, or any other Cribl configuration.
            </p>

            <h2>Troubleshooting</h2>
            <h3>Timing columns show --</h3>
            <p>The pipeline has not been profiled, or its functions changed since it was last profiled.</p>
            <h3>CPU time shows -- after profiling</h3>
            <p>
              No events entered the pipeline in the selected time range, or throughput metrics are unavailable. Try a
              longer range.
            </p>
            <h3>A profile fails</h3>
            <p>
              Preview has a 20 second limit. Very slow pipelines or very large sample events can exceed it; try a
              smaller sample. A live capture that returns no events means nothing matched the filter in time; widen the
              filter or use a saved sample. Pipelines inside Packs are profiled with their configuration sent inline, so functions
              that depend on Pack-local lookups or other Pack knowledge objects may report errors.
            </p>
            <h3>Access denied</h3>
            <p>
              The app can only call the API paths declared in its permissions. If an admin restricted them, ask for
              read access to pipelines, packs, samples, preview, and metrics queries to be restored.
            </p>
          </Prose>
        </div>
        <aside className="doc-toc">
          <TableOfContents contentRef={contentRef} />
        </aside>
      </div>
    </div>
  );
}
