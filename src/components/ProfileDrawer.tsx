import { Alert, Button, Drawer, Text } from '@capra/core';
import { Play } from '@capra/icons';
import { useAppData, type PipelineRow } from '../state/AppData';
import { EventSourceFields, useEventSource } from './EventSource';
import { EMPTY, fmtDateTime, fmtInt, fmtMicros } from '../lib/format';

/** Event source picker and run control for profiling one pipeline. */
export function ProfileDrawer({ pipeline, onClose }: { pipeline: PipelineRow | undefined; onClose: () => void }) {
  return (
    <Drawer
      isOpen={!!pipeline}
      onClose={onClose}
      title={pipeline ? `Profile ${pipeline.name}` : ''}
      width={520}
      aria-label="Profile pipeline"
    >
      {pipeline && <ProfileForm key={pipeline.id} pipeline={pipeline} onClose={onClose} />}
    </Drawer>
  );
}

function ProfileForm({ pipeline, onClose }: { pipeline: PipelineRow; onClose: () => void }) {
  const { profiling, runProfiles } = useAppData();
  const source = useEventSource(pipeline);
  const { choice } = source;

  const busy = !!profiling;
  const canRun = !busy && pipeline.functionCount > 0 && !!choice;
  const run = () => {
    if (choice?.kind === 'capture') void runProfiles([{ pipelineKey: pipeline.id, capture: choice.plan }]);
    else if (choice?.kind === 'sample')
      void runProfiles([{ pipelineKey: pipeline.id, sampleKey: choice.sampleKey, remember: true }]);
  };

  return (
    <div className="drawer-stack">
      <Text>
        Profiling runs events through this pipeline in the Leader's preview sandbox and records the time spent in
        each function. Nothing is sent to Destinations and no configuration changes.
      </Text>

      <EventSourceFields source={source} />

      {pipeline.functionCount === 0 && <Alert appearance="info">This pipeline has no functions to profile.</Alert>}

      <dl className="detail-list">
        <dt>
          <Text color="subtle">Functions</Text>
        </dt>
        <dd>
          <Text>{fmtInt(pipeline.functionCount)}</Text>
        </dd>
        <dt>
          <Text color="subtle">Events in, selected range</Text>
        </dt>
        <dd>
          <Text>{fmtInt(pipeline.inEvents)}</Text>
        </dd>
        <dt>
          <Text color="subtle">Time per event</Text>
        </dt>
        <dd>
          <Text>{pipeline.usPerEvent === undefined ? EMPTY : `${fmtMicros(pipeline.usPerEvent)} µs`}</Text>
        </dd>
        <dt>
          <Text color="subtle">Last profiled</Text>
        </dt>
        <dd>
          <Text>
            {pipeline.profiledAt === undefined
              ? EMPTY
              : `${fmtDateTime(pipeline.profiledAt)}, ${pipeline.profileSource ?? 'sample'}`}
          </Text>
        </dd>
      </dl>

      <div className="drawer-footer">
        <Button variant="tertiary" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          leadingIcon={Play}
          disabled={!canRun}
          pending={busy && profiling.current === pipeline.id}
          onClick={run}
        >
          {source.kind === 'capture' ? 'Capture and profile' : 'Run profile'}
        </Button>
      </div>
    </div>
  );
}
