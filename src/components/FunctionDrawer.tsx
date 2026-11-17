import { Alert, Drawer, Link, Text } from '@capra/core';
import { CodeBlock, LinkButton, SeverityTag } from './shared';
import type { FunctionRow } from '../state/AppData';
import { EMPTY, fmtInt, fmtMicros, fmtPercent, fmtSeconds } from '../lib/format';
import { pipelineHref, pipelineTestHref } from '../lib/useParamList';
import type { FnState } from '../lib/types';

export const STATE_LABEL: Record<FnState, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  unreachable: 'Unreachable',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>
        <Text color="subtle">{label}</Text>
      </dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Everything known about one function. `onShowFinding` drills from a finding to every function
 * with the same finding; `showPipelineLink` is off when the drawer is already on that pipeline's page.
 */
export function FunctionDrawer({
  row,
  onClose,
  onShowFinding,
  showPipelineLink = true,
}: {
  row: FunctionRow | undefined;
  onClose: () => void;
  onShowFinding?: (title: string) => void;
  showPipelineLink?: boolean;
}) {
  return (
    <Drawer isOpen={!!row} onClose={onClose} title={row ? `${row.type} #${row.position}` : ''} width={560}>
      {row && (
        <div className="drawer-stack">
          <dl className="detail-list">
            <Row label="Pipeline">
              {showPipelineLink ? <Link href={pipelineHref(row.pipelineKey)}>{row.pipeline}</Link> : <Text>{row.pipeline}</Text>}
            </Row>
            <Row label="Description">
              <Text>{row.description || EMPTY}</Text>
            </Row>
            <Row label="Position">
              <Text>{`#${row.position}`}</Text>
            </Row>
            <Row label="State">
              <Text>{STATE_LABEL[row.state]}</Text>
            </Row>
            <Row label="Cost per event entering the pipeline">
              <Text>
                {row.usPerPipelineEvent === undefined
                  ? EMPTY
                  : `${fmtMicros(row.usPerPipelineEvent)} µs${row.noise === undefined ? '' : `, runs ${fmtPercent(row.noise)} apart`}`}
              </Text>
            </Row>
            <Row label="Time per event the function handled">
              <Text>{row.usPerEvent === undefined ? EMPTY : `${fmtMicros(row.usPerEvent)} µs`}</Text>
            </Row>
            <Row label="Share of pipeline time">
              <Text>{fmtPercent(row.share)}</Text>
            </Row>
            <Row label="CPU time, selected range">
              <Text>{row.cpuSeconds === undefined ? EMPTY : `${fmtSeconds(row.cpuSeconds)} s`}</Text>
            </Row>
            <Row label="Profiled events in / out">
              <Text>
                {row.sampleEventsIn === undefined
                  ? EMPTY
                  : `${fmtInt(row.sampleEventsIn)} / ${fmtInt(row.sampleEventsOut)}`}
              </Text>
            </Row>
          </dl>

          {row.state === 'enabled' && row.usPerEvent === undefined && (
            <Alert appearance="info">
              {showPipelineLink
                ? 'Not measured yet. Open the pipeline and profile it to see how long this function takes.'
                : 'Not measured yet. Profile this pipeline to see how long this function takes.'}
            </Alert>
          )}

          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              {`Findings (${row.findings.length})`}
            </Text>
            {row.findings.length === 0 ? (
              <Text color="subtle">No findings for this function.</Text>
            ) : (
              row.findings.map((f, i) => (
                <div key={i} className="finding">
                  <div className="finding-head">
                    <SeverityTag severity={f.severity} />
                    <Text variant="body-md-semibold">{f.title}</Text>
                  </div>
                  <Text>{f.detail}</Text>
                  <Text color="subtle">{f.recommendation}</Text>
                  {onShowFinding && (
                    <div>
                      <LinkButton
                        label={`Show all functions with the finding ${f.title}`}
                        onClick={() => onShowFinding(f.title)}
                      >
                        Show all functions with this finding
                      </LinkButton>
                    </div>
                  )}
                </div>
              ))
            )}
          </section>

          <div>
            <Link href={pipelineTestHref(row.pipelineKey, row.index)}>Test a change to this function</Link>
          </div>

          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              Filter
            </Text>
            <CodeBlock>{row.filter}</CodeBlock>
          </section>

          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              Configuration
            </Text>
            <CodeBlock>{JSON.stringify(row.conf.conf ?? {}, null, 2)}</CodeBlock>
          </section>
        </div>
      )}
    </Drawer>
  );
}
