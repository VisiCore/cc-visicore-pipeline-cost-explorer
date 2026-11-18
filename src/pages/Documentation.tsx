import { useRef } from 'react';
import { Prose, TableOfContents } from '@capra/core';

export function Documentation() {
  const contentRef = useRef<HTMLElement>(null);
  return (
    <div className="page-scroll">
      <div className="page-grid doc-grid">
        <div className="doc-reading">
          <Prose as="article" ref={contentRef}>
            <h1>Pipeline Cost Explorer</h1>
            <p>
              Pipeline Cost Explorer finds the functions in a Worker Group's pipelines that are inefficient or that consume
              the most processing time. It combines three sources: the pipeline configuration, measured per-function
              timings from pipeline preview, and per-pipeline event counts from Cribl's internal metrics.
            </p>

            <h2>Getting started</h2>
            <ol>
              <li>Choose a Worker Group or Fleet in the page header. Your choice is remembered.</li>
              <li>
                On <strong>Pipelines</strong>, select <strong>Profile matched</strong> to measure every pipeline that
                is receiving events. The app shows what each will be measured with before anything runs.
              </li>
              <li>
                Return to <strong>Overview</strong>. <strong>Pipeline efficiency</strong> rates each pipeline and
                says why, least efficient first.
              </li>
              <li>
                Select <strong>Test a fix</strong> on a pipeline to measure a change against the saved pipeline
                before you make it in Cribl.
              </li>
            </ol>
            <p>
              Configuration findings on the <strong>Functions</strong> page need no profiling and are available
              straight away.
            </p>

            <h2>Pipeline ratings</h2>
            <p>
              The Overview and the Pipelines page rate every pipeline that is doing work, least efficient first,
              with the reason beside it.
            </p>
            <ul>
              <li>
                <strong>Inefficient</strong> means there is measured evidence of wasted work: most of its output is
                discarded downstream, it costs 50 µs or more per event (adjustable), a Drop or Regex Filter removes events after
                a fifth or more of the pipeline's work has been done on them, or a function with a high-severity
                configuration finding takes a quarter or more of the pipeline's time.
              </li>
              <li>
                <strong>Review</strong> means something is worth a look: 15 µs or more per event (adjustable), a smaller saving
                from moving a function earlier, or a medium or high configuration finding.
              </li>
              <li>
                <strong>Efficient</strong> means it has been profiled and none of the above applies.
              </li>
              <li>
                <strong>Not measured</strong> means it is receiving events but has not been profiled.
              </li>
            </ul>
            <p>
              A rating says how well a pipeline does its work, not how much it matters. A pipeline rated
              Inefficient that handles few events costs little; the CPU time column shows what is at stake.
            </p>

            <p>
              How strictly cost is judged is set on the <strong>Settings</strong> page and applies to everyone who
              uses the app. Choose Strict, Standard, or Lenient by what your pipelines are meant to do, or set
              your own figures. The page shows each cost as the events one core could process per second at that
              cost (50 µs per event is 20,000 events per second), and lists your profiled pipelines with the
              rating each would get, so you can see the effect before saving.
            </p>

            <h3>Time range</h3>
            <p>
              Event counts and CPU time cover the range in the page header. The buttons set the common ranges.
              Selecting the arrow beside the range opens the picker, where you can choose another quick range,
              enter a relative range such as <code>-90m</code> to <code>now</code> (add <code>@h</code> or{' '}
              <code>@d</code> to snap to the start of the hour or day), or pick exact start and end times. The
              Leader only keeps metrics for a limited period, so a range further back than that comes back empty.
            </p>

            <h3>Top fixes</h3>
            <p>
              The Overview also lists specific changes, ranked by CPU time: stop processing output that is
              discarded, move a Drop or Regex Filter earlier, or fix a flagged function. Selecting one opens the
              test page so you can measure the change before making it in Cribl. A suggested move is a candidate,
              not a guarantee: the test checks that the output stays the same.
            </p>

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
              Sampling, and also Code and Chain, which may keep state) is never given repeated events, because seeing the same events again changes what those
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
                <strong>Cost per event (µs)</strong> is the function's time divided by the events that entered the
                pipeline. It is what the function adds to the cost of each event the pipeline receives, so the
                functions of a pipeline add up to the pipeline's cost per event. A function behind a Drop costs
                less per pipeline event because fewer events reach it. The function's details also show its time
                per event it actually handled.
              </li>
              <li>
                <strong>Variation between runs</strong> is how far apart the function's two fastest runs were. A
                large figure means the timing is not steady enough to act on by itself; profile again.
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
              is empty for pipelines that have not been profiled or that had no traffic in the range. It is also
              shown as a share of one core: 864 seconds in 24 hours is 1% of one core kept busy all day.
            </p>
            <p>
              Fleets do not report pipeline event counts to the Leader. For a Fleet, CPU time and the checks that
              depend on event counts are empty; findings and per-event costs still work.
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
              <li>
                For a Pack pipeline, it finds the Pack routes that run that pipeline, then follows the route that
                sends events into the Pack (or the Pack's own Sources) to where they end up.
              </li>
            </ul>
            <p>
              Output counts as discarded when it is sent to a DevNull Destination, or to a pipeline whose first
              function drops every event. Pipelines with at least half their output discarded are listed on the
              Overview and flagged on their own page, which also shows every path the output takes.
            </p>
            <p>
              This is traced from configuration and metrics, not from following individual events. Check the paths
              shown before acting. When a Pack's events leave by several routes that end differently, or part of
              the output goes over a QuickConnect link whose volume is not measured, no percentage is shown,
              because there is no telling which path a given pipeline's events take.
            </p>

            <h2>Check against Worker CPU</h2>
            <p>
              The Overview compares the estimated CPU time of profiled pipelines with the CPU the Workers actually
              use, so you can tell whether the estimates are believable and whether pipeline functions are where
              the CPU goes.
            </p>
            <ul>
              <li>
                <strong>CPU used by Cribl</strong> is what each Worker's Cribl processes report, averaged over the
                selected range and added up, in cores. Each connected Worker is asked directly, up to 20 of them;
                with more, the figure is scaled up from those asked.
              </li>
              <li>
                <strong>Estimated for pipeline functions</strong> is the estimated CPU time of all profiled
                pipelines, expressed in cores, and its share of that CPU.
              </li>
              <li>
                <strong>Traffic profiled</strong> is the share of events through pipelines that have functions
                which went through a profiled one. A conclusion is only drawn once this reaches 80%.
              </li>
            </ul>
            <p>
              Cribl's CPU covers everything a Worker does: receiving and parsing at Sources, routing, pipeline
              functions, and sending at Destinations. A low share for functions means tuning them will not move
              Worker CPU much. If no Worker can be asked, the hosts' load average is used instead and labelled as
              such; it counts every program on the machine and is only a rough ceiling.
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
              <li>
                A Pack route that depends on an earlier pipeline in the same Pack (its filter reads{' '}
                <code>cribl_pipe</code> or <code>__packId</code>): events are captured between the two stages.
              </li>
              <li>
                Destinations that use the pipeline for post-processing: events on the routes that send to those
                Destinations, captured after the processing pipeline.
              </li>
              <li>
                A Chain function in another pipeline: that pipeline's events are captured and run through its
                functions up to the Chain, so they arrive as the chained pipeline really receives them.
              </li>
            </ul>
            <p>Check the suggestion before running:</p>
            <ul>
              <li>It ignores route order and Final flags, so it can match events that an earlier route takes.</li>
              <li>
                Nothing is suggested for a pipeline that only a Pack's own collector feeds. Enter an expression
                yourself, such as a match on <code>__inputId</code>.
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
                each, taking turns, and the fastest whole run of each version is the one shown.
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
              <li>
                <strong>Write up change</strong> produces a Markdown summary of the result and the exact edits, to
                paste into a ticket or change request.
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
