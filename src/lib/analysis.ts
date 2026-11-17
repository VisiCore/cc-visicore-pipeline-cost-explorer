import type { Finding, FnConf, FnState, Pipeline, Severity } from './types';

/**
 * Static analysis of pipeline configuration. Every rule here is a heuristic derived from the
 * function's config alone — it flags patterns that are commonly expensive, it does not measure
 * anything. Measured cost comes from profiling (see profiler.ts).
 */

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface AnalyzedFunction {
  index: number;
  conf: FnConf;
  state: FnState;
  findings: Finding[];
}

/** Functions whose per-event cost is typically well above a simple Eval. */
const EXPENSIVE = new Set([
  'serde',
  'mask',
  'grok',
  'lookup',
  'regex_extract',
  'code',
  'sensitive_data_scanner',
  'dns_lookup',
  'redis',
  'geoip',
  'auto_timestamp',
]);

/** Functions that remove events, so everything after them processes less data. */
const REDUCERS = new Set(['drop', 'sampling', 'dynamic_sampling', 'suppress', 'regex_filter']);

const isAlwaysTrue = (filter?: string) => !filter || filter.trim() === '' || filter.trim() === 'true';

function finding(severity: Severity, title: string, detail: string, recommendation: string): Finding {
  return { severity, title, detail, recommendation };
}

/** Collects every regex-looking string in a function's config (keys containing "regex"), skipping disabled entries. */
function collectRegexes(value: unknown, key = '', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/regex/i.test(key) && value.length > 2) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRegexes(v, key, out);
  } else if (value && typeof value === 'object') {
    if ((value as { disabled?: unknown }).disabled === true) return out;
    for (const [k, v] of Object.entries(value)) collectRegexes(v, k, out);
  }
  return out;
}

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface RegexFacts {
  /** A repeated group whose body can itself repeat over the same text. */
  nested: boolean;
  /** Count of greedy, unbounded `.` / `[\s\S]` wildcards. */
  greedyWildcards: number;
  leadingWildcard: boolean;
}

interface RegexElement {
  /** Followed by an unbounded quantifier, or a group that can match as one unbounded repetition. */
  unbounded: boolean;
  optional: boolean;
  /** `.` or a class that matches everything, such as [\s\S]. */
  wild: boolean;
  /** A group that is dangerous to repeat. */
  groupRisk: boolean;
}

interface RegexFrame {
  alts: RegexElement[][];
  altStart: number;
  altTexts: string[];
}

/**
 * Walks a regex source once, tracking groups, character classes and escapes, to answer structural
 * questions a flat pattern match gets wrong (escaped dots, dots inside classes, bounded quantifiers).
 * It is a heuristic for flagging patterns worth a look, not a proof of backtracking behavior.
 */
export function inspectRegex(source: string): RegexFacts {
  const delimited = /^\/([\s\S]*)\/[a-z]*$/.exec(source);
  const s = delimited ? delimited[1] : source;
  const facts: RegexFacts = { nested: false, greedyWildcards: 0, leadingWildcard: false };
  const stack: RegexFrame[] = [{ alts: [[]], altStart: 0, altTexts: [] }];
  let i = 0;
  let atoms = 0;
  const top = () => stack[stack.length - 1];

  const readQuantifier = () => {
    const c = s[i];
    let len = 0;
    let optional = false;
    let unbounded = false;
    if (c === '*') [len, optional, unbounded] = [1, true, true];
    else if (c === '+') [len, optional, unbounded] = [1, false, true];
    else if (c === '?') [len, optional, unbounded] = [1, true, false];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
      if (!m) return undefined;
      [len, optional, unbounded] = [m[0].length, Number(m[1]) === 0, m[2] !== undefined && m[3] === ''];
    } else return undefined;
    const lazy = s[i + len] === '?';
    return { len: len + (lazy ? 1 : 0), optional, unbounded, lazy };
  };

  const finishAtom = (el: RegexElement) => {
    const isFirst = atoms === 0;
    atoms++;
    const q = readQuantifier();
    if (q) {
      i += q.len;
      el.optional = q.optional;
      if (q.unbounded) {
        if (el.groupRisk) facts.nested = true;
        if (el.wild && !q.lazy) {
          facts.greedyWildcards++;
          if (isFirst) facts.leadingWildcard = true;
        }
        el.unbounded = true;
      }
    }
    const frame = top();
    frame.alts[frame.alts.length - 1].push(el);
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      finishAtom({ unbounded: false, optional: false, wild: false, groupRisk: false });
    } else if (c === '[') {
      let j = i + 1;
      if (s[j] === '^') j++;
      if (s[j] === ']') j++;
      while (j < s.length && s[j] !== ']') j += s[j] === '\\' ? 2 : 1;
      const body = s.slice(i + 1, j);
      i = j + 1;
      const wild = ['s', 'd', 'w'].some((k) => body.includes(`\\${k}`) && body.includes(`\\${k.toUpperCase()}`));
      finishAtom({ unbounded: false, optional: false, wild, groupRisk: false });
    } else if (c === '(') {
      i++;
      if (s[i] === '?') {
        if (s[i + 1] === '<' && s[i + 2] !== '=' && s[i + 2] !== '!') {
          const close = s.indexOf('>', i);
          i = close === -1 ? s.length : close + 1;
        } else {
          i += s[i + 1] === '<' ? 3 : 2;
        }
      }
      stack.push({ alts: [[]], altStart: i, altTexts: [] });
    } else if (c === ')') {
      if (stack.length === 1) {
        i++;
        continue;
      }
      const frame = stack.pop()!;
      frame.altTexts.push(s.slice(frame.altStart, i));
      i++;
      // The group can match as nothing but one unbounded repetition (everything else in an alternative is
      // optional), or it repeats a wildcard that can also consume whatever follows it.
      const solo = frame.alts.some((alt) =>
        alt.some((el, k) => el.unbounded && (el.wild || alt.every((other, n) => n === k || other.optional))),
      );
      // Alternatives where one is a prefix of another, e.g. (a|aa), split the same text several ways.
      const overlap = frame.altTexts.some((a, x) =>
        frame.altTexts.some((b, y) => x !== y && a.length > 0 && b.startsWith(a)),
      );
      finishAtom({ unbounded: solo, optional: false, wild: false, groupRisk: solo || overlap });
    } else if (c === '|') {
      const frame = top();
      frame.altTexts.push(s.slice(frame.altStart, i));
      frame.alts.push([]);
      i++;
      frame.altStart = i;
    } else if (c === '^' || c === '$') {
      i++;
    } else {
      i++;
      finishAtom({ unbounded: false, optional: false, wild: c === '.', groupRisk: false });
    }
  }
  return facts;
}

export function regexFindings(source: string): Finding[] {
  const out: Finding[] = [];
  const facts = inspectRegex(source);
  if (facts.nested) {
    out.push(
      finding(
        'high',
        'Regex with nested quantifiers',
        `${short(source)} repeats a group that can itself match the same text in more than one way. On input that almost matches, the regex engine can backtrack exponentially and stall a worker process.`,
        'Rewrite so the inner and outer repetitions cannot match the same text (make the inner part more specific, or remove one of the quantifiers).',
      ),
    );
  }
  if (facts.greedyWildcards >= 2) {
    out.push(
      finding(
        'medium',
        'Regex with multiple greedy wildcards',
        `${short(source)} has ${facts.greedyWildcards} greedy wildcards. Each one scans to the end of the input and backtracks, so cost grows quickly with event size.`,
        'Replace wildcards with negated character classes (for example [^"]* or \\S+) or anchor the pattern so the engine has less to retry.',
      ),
    );
  } else if (facts.leadingWildcard) {
    out.push(
      finding(
        'low',
        'Regex starts with a wildcard',
        `${short(source)} begins with a wildcard, so the engine scans the whole event before trying the rest of the pattern.`,
        'Drop the leading wildcard; an unanchored regex already matches anywhere in the field.',
      ),
    );
  }
  return out;
}

/** Pulls regex literals out of a JavaScript expression, telling them apart from division by what precedes the slash. */
export function regexLiterals(expr: string): string[] {
  const out: string[] = [];
  let prev = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      i = j + 1;
      prev = c;
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < expr.length && (inClass || expr[j] !== '/') && expr[j] !== '\n') {
        if (expr[j] === '\\') j++;
        else if (expr[j] === '[') inClass = true;
        else if (expr[j] === ']') inClass = false;
        j++;
      }
      if (expr[j] !== '/') {
        i++;
        continue;
      }
      j++;
      while (/[a-z]/.test(expr[j] ?? '')) j++;
      if (j - i > 3) out.push(expr.slice(i, j));
      i = j;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/** Medium and high regex findings for regex literals embedded in an expression. */
function expressionRegexFindings(expr: string, where: string): Finding[] {
  return regexLiterals(expr)
    .flatMap((literal) => regexFindings(literal))
    .filter((f) => f.severity !== 'low')
    .map((f) => ({ ...f, title: `${where}: ${f.title.toLowerCase()}` }));
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function typeFindings(fn: FnConf): Finding[] {
  const c = fn.conf ?? {};
  const out: Finding[] = [];
  const everyEvent = isAlwaysTrue(fn.filter);

  switch (fn.id) {
    case 'mask': {
      const rules = arr(c.rules).filter((r) => !r.disabled);
      const fields = Array.isArray(c.fields) ? (c.fields as string[]) : ['_raw'];
      if (rules.length > 8) {
        out.push(
          finding(
            'medium',
            `Mask applies ${rules.length} rules`,
            `Every rule is a separate regex pass over each masked field${everyEvent ? ', for every event' : ''}.`,
            'Combine rules that share a replacement, remove rules that never match, or narrow the function filter to the events that need masking.',
          ),
        );
      }
      if (fields.some((f) => f.includes('*')) || fields.length > 4) {
        out.push(
          finding(
            'medium',
            'Mask runs across many fields',
            `Masking targets ${fields.join(', ')}. Each rule runs once per matching field.`,
            'List only the fields that can contain the sensitive values.',
          ),
        );
      }
      break;
    }
    case 'eval': {
      const adds = arr(c.add).filter((a) => !a.disabled);
      const exprs = adds.map((a) => String(a.value ?? ''));
      if (adds.length > 15) {
        out.push(
          finding(
            'medium',
            `Eval evaluates ${adds.length} expressions`,
            'Each expression is evaluated for every event that passes the filter.',
            'Split by event type with narrower filters, or drop fields that no downstream consumer uses.',
          ),
        );
      }
      // Only a repeat when the same argument is parsed in more than one place.
      const parseArgs = exprs.flatMap((e) => [...e.matchAll(/JSON\.parse\(\s*([^()]*?)\s*\)/g)].map((m) => m[1]));
      const repeated = [...new Set(parseArgs)].find((arg) => parseArgs.filter((x) => x === arg).length >= 2);
      if (repeated !== undefined) {
        out.push(
          finding(
            'medium',
            'Eval parses JSON repeatedly',
            `JSON.parse(${short(repeated, 40)}) appears ${parseArgs.filter((x) => x === repeated).length} times, so the same payload is parsed more than once per event.`,
            'Parse once (a Parser function or a single temporary __field) and read from the parsed object.',
          ),
        );
      }
      for (const e of exprs) out.push(...expressionRegexFindings(e, 'Expression'));
      if (exprs.some((e) => /C\.Lookup\(/.test(e))) {
        out.push(
          finding(
            'low',
            'Eval performs inline lookups',
            'C.Lookup inside an expression runs per event and is easy to duplicate across expressions.',
            'Use a Lookup function so the match is done once per event.',
          ),
        );
      }
      break;
    }
    case 'serde': {
      // `fields` names the columns for delimited formats; only "Fields to keep" limits what is extracted.
      const keep = Array.isArray(c.keep) ? (c.keep as string[]) : [];
      const restricted = keep.length > 0 && !keep.includes('*');
      if (c.mode !== 'reserialize' && !restricted) {
        out.push(
          finding(
            'low',
            'Parser extracts every field',
            `The ${String(c.type ?? 'configured')} parser materializes all fields from ${String(c.srcField ?? '_raw')} on each event.`,
            'Set "Fields to keep" to the fields you actually use so the rest are never created or serialized downstream.',
          ),
        );
      }
      break;
    }
    case 'lookup': {
      if (c.matchMode === 'regex') {
        out.push(
          finding(
            'high',
            'Lookup uses regex matching',
            'Regex match mode tests each event against lookup rows one by one until a row matches, so cost scales with the size of the lookup table.',
            'Use exact match where possible, or keep the regex table short and ordered with the most common matches first.',
          ),
        );
      } else if (c.matchMode === 'cidr') {
        out.push(
          finding(
            'medium',
            'Lookup uses CIDR matching',
            'CIDR match mode is slower than exact matching and scales with the number of ranges.',
            'Keep the range table small, or pre-filter so only events with an address field reach the lookup.',
          ),
        );
      }
      break;
    }
    case 'code':
      out.push(
        finding(
          'medium',
          'Custom Code function',
          'Code functions run arbitrary JavaScript per event and are the most common source of unexpectedly slow pipelines.',
          'Profile this pipeline to see its real cost; replace with built-in functions where they can do the same work.',
        ),
      );
      break;
    case 'grok':
      out.push(
        finding(
          'medium',
          'Grok pattern matching',
          'Grok patterns expand into large regular expressions; unmatched events pay the full cost of every attempted pattern.',
          'Filter the function to the matching sourcetype, and prefer Regex Extract or Parser when the format is fixed.',
        ),
      );
      break;
    case 'dns_lookup':
      out.push(
        finding(
          'medium',
          'DNS lookup per event',
          'Resolution is network I/O; cache misses add latency to the whole pipeline.',
          'Confirm caching is enabled with a TTL that fits your data, and filter to events that need resolution.',
        ),
      );
      break;
    case 'redis':
      out.push(
        finding(
          'medium',
          'Redis call per event',
          'Each event waits on a network round trip, which limits throughput more than CPU does.',
          'Filter to the events that need it and keep the command list minimal.',
        ),
      );
      break;
    case 'sensitive_data_scanner':
      out.push(
        finding(
          'medium',
          'Sensitive Data Scanner',
          'Scans event content against every rule in the attached rulesets.',
          'Limit the scanned fields and attach only the rulesets that apply to this data.',
        ),
      );
      break;
    case 'auto_timestamp':
      if (!arr(c.timestamps).length) {
        out.push(
          finding(
            'low',
            'Timestamp is auto-detected',
            'Without an explicit format, the function tries a list of built-in timestamp patterns against the start of each event.',
            'Add a manual timestamp format (regex + strptime) for this data so only one pattern is tried.',
          ),
        );
      }
      break;
    case 'numerify':
      // Numerify has no include list; it is narrowed with ignored fields or a field filter expression.
      if (!(Array.isArray(c.ignoreFields) && c.ignoreFields.length) && !c.filterExpr) {
        out.push(
          finding(
            'low',
            'Numerify walks every field',
            'With no ignored fields and no field filter expression, every field on every event is tested and converted.',
            'Add ignored fields or a field filter expression, or narrow the function filter to the events that need it.',
          ),
        );
      }
      break;
    case 'flatten':
      if (!(Array.isArray(c.fields) && c.fields.length)) {
        out.push(
          finding(
            'low',
            'Flatten walks every field',
            'With no field list, every field on every event is visited.',
            'Restrict the function to the fields that need it.',
          ),
        );
      }
      break;
    case 'unroll':
    case 'json_unroll':
    case 'xml_unroll':
    case 'clone':
      out.push(
        finding(
          'low',
          'Multiplies events',
          'Each input event becomes several, so every function after this one does proportionally more work.',
          'Do filtering and field removal before this function, and keep downstream processing light.',
        ),
      );
      break;
    case 'aggregation':
    case 'suppress':
    case 'dynamic_sampling':
      out.push(
        finding(
          'low',
          'Stateful function',
          'Keeps state per group-by key in each worker process; high-cardinality keys increase memory use.',
          'Check that the key expression has bounded cardinality.',
        ),
      );
      break;
  }

  for (const source of collectRegexes(c)) out.push(...regexFindings(source));
  if (fn.filter) out.push(...expressionRegexFindings(fn.filter, 'Filter'));

  // Only worth saying when nothing more specific was found for this function.
  if (everyEvent && EXPENSIVE.has(fn.id) && out.length === 0) {
    out.push(
      finding(
        'low',
        'Runs on every event',
        `The filter is "true", so this ${fn.id} function processes every event in the pipeline.`,
        'If only some events need it, add a filter expression so the rest skip the function.',
      ),
    );
  }
  return out;
}

export function isActive(fn: FnConf, pipeline: Pipeline): boolean {
  if (fn.id === 'comment' || fn.disabled) return false;
  return !(fn.groupId && pipeline.conf.groups?.[fn.groupId]?.disabled);
}

/** Analyzes every non-comment function in a pipeline. */
export function analyzePipeline(pipeline: Pipeline): AnalyzedFunction[] {
  const functions = pipeline.conf.functions ?? [];
  const out: AnalyzedFunction[] = [];
  let unreachableAfter: number | undefined;
  let unreachableWhy = '';
  let expensiveSeen = 0;
  const parsedFields = new Map<string, { index: number; filterKey: string }>();

  functions.forEach((fn, index) => {
    if (fn.id === 'comment') return;

    if (!isActive(fn, pipeline)) {
      out.push({
        index,
        conf: fn,
        state: 'disabled',
        findings: [
          finding(
            'low',
            'Disabled function',
            'This function (or its group) is turned off. It costs nothing at runtime but adds noise to the pipeline.',
            'Remove it if it is no longer needed.',
          ),
        ],
      });
      return;
    }

    if (unreachableAfter !== undefined) {
      out.push({
        index,
        conf: fn,
        state: 'unreachable',
        findings: [
          finding(
            'medium',
            'Unreachable function',
            `Function #${unreachableAfter + 1} ${unreachableWhy}, so no event ever reaches this one.`,
            'Remove the function, or change the earlier function if this one is meant to run.',
          ),
        ],
      });
      return;
    }

    const findings = typeFindings(fn);

    if (fn.id === 'serde' && fn.conf?.mode !== 'reserialize') {
      const src = String(fn.conf?.srcField ?? '_raw');
      const filterKey = isAlwaysTrue(fn.filter) ? 'true' : fn.filter!.trim();
      const earlier = parsedFields.get(src);
      // Parsers with different filters usually handle different events, so only flag when an event
      // certainly reaches both: the earlier parser runs on everything, or the filters are identical.
      if (earlier !== undefined && (earlier.filterKey === 'true' || earlier.filterKey === filterKey)) {
        findings.push(
          finding(
            'medium',
            'Field is parsed more than once',
            `${src} was already parsed by function #${earlier.index + 1} in this pipeline.`,
            'Parse once and reuse the extracted fields.',
          ),
        );
      } else if (earlier === undefined || filterKey === 'true') {
        parsedFields.set(src, { index, filterKey });
      }
    }

    if (REDUCERS.has(fn.id) && expensiveSeen >= 2 && !(fn.id === 'drop' && isAlwaysTrue(fn.filter))) {
      findings.push(
        finding(
          'low',
          'Volume reduction happens late',
          `${expensiveSeen} expensive functions run before this one, including on events it then removes.`,
          'If its filter does not depend on fields created upstream, move it earlier so discarded events skip that work.',
        ),
      );
    }

    if (EXPENSIVE.has(fn.id)) expensiveSeen++;
    if (isAlwaysTrue(fn.filter) && (fn.final || fn.id === 'drop')) {
      unreachableAfter = index;
      unreachableWhy = fn.id === 'drop' ? 'drops every event' : 'is marked Final with a filter of "true"';
    }

    out.push({ index, conf: fn, state: 'enabled', findings });
  });
  return out;
}

export function topSeverity(findings: Finding[]): Severity | undefined {
  let best: Severity | undefined;
  for (const f of findings) if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  return best;
}

/** Below this per-event cost, a function is too cheap to call a hot spot whatever its share. */
const HOT_SPOT_MIN_US = 5;

/** Findings that only exist once a function has been measured. */
export function measuredFindings(usPerEvent: number, share: number, profiledFunctions: number): Finding[] {
  const out: Finding[] = [];
  // A large share of a pipeline that costs almost nothing is not worth anyone's attention.
  if (profiledFunctions >= 3 && share >= 0.4 && usPerEvent >= HOT_SPOT_MIN_US) {
    out.push(
      finding(
        share >= 0.6 ? 'high' : 'medium',
        'Pipeline hot spot',
        `This function accounts for ${Math.round(share * 100)}% of the pipeline's measured processing time.`,
        'Optimizing or narrowing this one function gives the largest improvement for this pipeline.',
      ),
    );
  }
  if (usPerEvent >= 50) {
    out.push(
      finding(
        'high',
        'Slow per-event processing',
        `Measured at ${usPerEvent.toFixed(1)} µs per event. A typical Eval or Drop measures low single digits.`,
        'Review the configuration findings on this function, and narrow its filter.',
      ),
    );
  } else if (usPerEvent >= 15) {
    out.push(
      finding(
        'medium',
        'Above-average per-event cost',
        `Measured at ${usPerEvent.toFixed(1)} µs per event.`,
        'Worth a look if this pipeline carries significant volume.',
      ),
    );
  }
  return out;
}
