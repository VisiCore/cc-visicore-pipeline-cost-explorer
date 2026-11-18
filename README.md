# Pipeline Cost Explorer

Find the functions in your pipelines that are inefficient or that use the most processing time.

## Summary

Pipeline Cost Explorer is a Cribl app for pipeline performance review. It helps you see which functions cost the most CPU given real traffic, spot configuration patterns that are commonly slow, and decide where optimization effort pays off.

## What This App Does

* Primary purpose: show which pipelines in a Worker Group are inefficient, why, and what each costs, then let you test a fix before making it.
* Key capabilities:
  * **Pipeline efficiency ratings**: every pipeline doing work is rated Inefficient, Review, Efficient or Not measured, with the reason and its CPU cost, least efficient first.
  * **Configuration findings** for each function: risky regular expressions, oversized Mask rule sets, regex and CIDR lookups, repeated parsing, late volume reduction, unreachable and disabled functions, and more.
  * **Measured timings** per function, taken by running live-captured events or a saved sample through the pipeline with Cribl's pipeline preview and CPU profiling.
  * **CPU time estimates** that combine measured time per event with each pipeline's actual event throughput over the last 1 hour to 7 days.
  * **Discarded output detection**: finds pipelines whose output is dropped or sent to a DevNull Destination downstream.
  * **Top fixes**: specific changes ranked by the CPU time at stake, including functions that would save work if moved earlier.
  * **Check against Worker CPU**: compares estimated pipeline cost with the CPU the Workers' Cribl processes report.
  * **Test a change**: edit a pipeline's functions inside the app and measure the edited version against the saved one on the same events, with a check that the output is still the same. Nothing is saved to Cribl.
  * Covers pipelines inside Packs as well as the group's own pipelines.
* Intended users: Cribl admins and pipeline authors.
* Works with: Cribl Stream Worker Groups. Edge Fleets get configuration findings and per-event timings only, because Fleets do not report pipeline event counts to the Leader.

## When To Use This App

* Worker CPU is high and you need to know which pipeline and function is responsible.
* You are reviewing pipelines before a volume increase.
* You inherited pipelines or Packs and want a quick list of what to clean up.

## Before You Install

* Measured timings need events to run: either live traffic to capture, or a saved sample file (Processing, Knowledge, Sample Data). Configuration findings need neither.
* Profiling runs on the Leader in the preview sandbox. Timings rank functions reliably against each other, but absolute values on Workers differ with hardware and load.
* CPU time is an estimate, not a reading from the Workers. The Overview compares it with the CPU the Workers' Cribl processes report.
* Ratings use fixed thresholds (15 and 50 µs per event) and say how well a pipeline does its work, not how much it matters. The CPU time beside each rating shows what is at stake.

## Permissions

The app is read-only with respect to your configuration. It requests:

| API path | Method | Why |
|---|---|---|
| `/master/groups`, `/master/groups/*` | GET | List Worker Groups and Fleets |
| `/m/*/pipelines`, `/m/*/packs`, `/m/*/p/*/pipelines` (and their child paths) | GET | Read pipeline configuration |
| `/m/*/system/samples`, `/m/*/system/samples/*`, `/m/*/p/*/system/samples`, `/m/*/p/*/system/samples/*` | GET | List and read saved samples |
| `/m/*/routes`, `/m/*/p/*/routes`, `/m/*/system/inputs` (and their child paths) | GET | Work out which live events reach a pipeline, from the routes and Sources that feed it |
| `/m/*/system/outputs` (and child paths) | GET | Read Destination types and post-processing pipelines, to find output sent to DevNull and to capture events for post-processing pipelines |
| `/master/workers` (and child paths) | GET | Read Worker core counts, to compare estimated cost with Worker CPU |
| `/m/*/system/capture` | POST | Capture live events as profiling input, 10 seconds at a time. Read-only; captured events are not stored. |
| `/m/*/preview` | POST | Run events through a pipeline, or an edited copy of it, to time each function. Nothing is sent to Destinations and nothing is saved. |
| `/system/metrics/query` | POST | Read per-pipeline event counts |
| `/w/*/system/metrics/query`, `/m/*/system/metrics/query` | POST | Ask each Worker for the CPU its Cribl processes use |

It makes no external network calls.

## Data The App Stores

Profile results, the sample chosen for each pipeline, and each user's last Worker Group and time range are kept in the app's own key-value store. Uninstalling the app removes them.

## Using The App

1. Choose a Worker Group in the page header.
2. Open **Pipelines** and select **Profile matched**. The app lists what each busy pipeline will be measured with, then profiles them one at a time once you confirm.
3. Return to **Overview**. **Pipeline efficiency** rates each pipeline and says why; **Top fixes** lists specific changes.
4. Select **Test a fix** on a pipeline. Edit a function, run the comparison, and check the time saved and that the output is unchanged.
5. Make the change in Cribl. The app never changes your configuration.

The in-app **Documentation** page explains how each number is calculated.

## Support

This app is intended for internal use and is not a Cribl-supported product. Contact the app's maintainer in your organization for help.
