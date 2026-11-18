import { useMemo, useState } from 'react';
import { Button, defineColumns, EmptyState, NumberField, Table, Tag, Text, Toast, ToggleButtonGroup } from '@capra/core';
import { Page } from '../components/Page';
import { useAppData, type PipelineRow } from '../state/AppData';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../lib/recommend';
import { EMPTY, fmtInt, fmtMicros } from '../lib/format';

/** Ready-made choices, so nobody has to know what a microsecond figure should be. */
const PRESETS: { key: string; label: string; when: string; value: Thresholds }[] = [
  {
    key: 'strict',
    label: 'Strict',
    when: 'For pipelines that only route, filter, or lightly reshape events. Flags anything doing more than that.',
    value: { reviewUs: 10, heavyUs: 30 },
  },
  {
    key: 'standard',
    label: 'Standard',
    when: 'A sensible starting point for most groups. Leave it here unless the ratings look wrong for your pipelines.',
    value: DEFAULT_THRESHOLDS,
  },
  {
    key: 'lenient',
    label: 'Lenient',
    when: 'For pipelines that parse, enrich, or mask heavily by design, where Standard flags most of them.',
    value: { reviewUs: 30, heavyUs: 100 },
  },
];
const CUSTOM = 'custom';

const presetFor = (t: Thresholds) =>
  PRESETS.find((p) => p.value.reviewUs === t.reviewUs && p.value.heavyUs === t.heavyUs)?.key ?? CUSTOM;

/** A cost per event as the events one core could process each second at that cost. */
const perSecond = (us: number) => (us > 0 ? `${fmtInt(Math.round(1_000_000 / us / 100) * 100)} events per second on one core` : '');

const MAX_ROWS = 12;

/** Thresholds that decide how pipelines are rated. Shared by everyone who uses the app. */
export function Settings() {
  const { thresholds } = useAppData();
  // Keyed on the saved values, so the form starts from them once they have loaded, and again after a save.
  return <SettingsForm key={`${thresholds.reviewUs}:${thresholds.heavyUs}`} />;
}

function SettingsForm() {
  const { thresholds, saveThresholds, pipelineRows, groupId } = useAppData();
  const [choice, setChoice] = useState(presetFor(thresholds));
  const [reviewUs, setReviewUs] = useState(thresholds.reviewUs);
  const [heavyUs, setHeavyUs] = useState(thresholds.heavyUs);
  const [saving, setSaving] = useState(false);

  const valid = reviewUs > 0 && heavyUs > reviewUs;
  const changed = reviewUs !== thresholds.reviewUs || heavyUs !== thresholds.heavyUs;
  const preset = PRESETS.find((p) => p.key === choice);

  // The group's own pipelines on this scale, costliest first, so the choice can be judged against them.
  const measured = useMemo(
    () =>
      pipelineRows
        .filter((p) => p.usPerEvent !== undefined && p.functionCount > 0)
        .sort((a, b) => (b.usPerEvent ?? 0) - (a.usPerEvent ?? 0)),
    [pipelineRows],
  );
  const columns = useMemo(
    () =>
      defineColumns<PipelineRow>([
        {
          id: 'name',
          label: 'Pipeline',
          render: (_v, item) => (
            <div className="name-cell">
              <span>{item.name}</span>
              {item.pack && (
                <Text variant="body-sm-normal" color="subtle">
                  {item.pack}
                </Text>
              )}
            </div>
          ),
        },
        { id: 'usPerEvent', label: 'Cost (µs)', render: (v) => fmtMicros(v as number) },
        {
          id: 'id',
          label: 'One core handles',
          // Too cheap to time is effectively free, not infinitely fast.
          render: (_v, item) =>
            item.usPerEvent! < 0.05 ? (
              EMPTY
            ) : (
              <span className="nowrap">{`${fmtInt(Math.round(1_000_000 / item.usPerEvent! / 100) * 100)} events/s`}</span>
            ),
        },
        {
          id: 'rating',
          label: 'With this setting',
          render: (_v, item) =>
            item.usPerEvent! >= heavyUs ? (
              <Tag size="sm" color="danger">
                Inefficient
              </Tag>
            ) : item.usPerEvent! >= reviewUs ? (
              <Tag size="sm" color="warning">
                Review
              </Tag>
            ) : (
              <Tag size="sm" color="success">
                Fine
              </Tag>
            ),
        },
      ]),
    [reviewUs, heavyUs],
  );

  const save = async () => {
    setSaving(true);
    const saved = await saveThresholds({ reviewUs, heavyUs });
    setSaving(false);
    if (saved) Toast.success('Rating thresholds saved.');
    else Toast.warning('The thresholds apply for now but could not be saved, so they will reset when you reload.');
  };

  return (
    <Page title="Settings">
      <div className="span-6">
        <div className="settings-form">
          <div className="drawer-section">
            <Text as="h2" variant="heading-sm">
              How strictly to rate pipelines
            </Text>
            <Text color="subtle">
              Part of a pipeline's rating is what it costs to process one event. There is no single right number:
              it depends on how much work your pipelines are meant to do. Pick the description that fits, and
              check the result against your own pipelines on the right. This applies to everyone who uses the app.
            </Text>
          </div>

          <div>
            <ToggleButtonGroup
              aria-label="How strictly to rate pipelines"
              disallowEmptySelection
              selectedKeys={new Set([choice])}
              onSelectionChange={(keys) => {
                const next = String([...keys][0] ?? choice);
                setChoice(next);
                const picked = PRESETS.find((p) => p.key === next);
                if (picked) {
                  setReviewUs(picked.value.reviewUs);
                  setHeavyUs(picked.value.heavyUs);
                }
              }}
              items={[...PRESETS.map((p) => ({ key: p.key, text: p.label })), { key: CUSTOM, text: 'Custom' }]}
            />
          </div>

          {preset ? (
            <div className="drawer-section">
              <Text>{preset.when}</Text>
              <dl className="detail-list">
                <dt>
                  <Text color="subtle">Review at</Text>
                </dt>
                <dd>
                  <Text>{`${fmtInt(reviewUs)} µs per event, or slower than ${perSecond(reviewUs)}`}</Text>
                </dd>
                <dt>
                  <Text color="subtle">Inefficient at</Text>
                </dt>
                <dd>
                  <Text>{`${fmtInt(heavyUs)} µs per event, or slower than ${perSecond(heavyUs)}`}</Text>
                </dd>
              </dl>
            </div>
          ) : (
            <>
              <Text>
                Set your own costs. As a guide, a Drop or simple Eval costs 1 to 5 µs per event, and parsing or
                a lookup typically 10 to 40 µs.
              </Text>
              <NumberField
                label="Review at (µs per event)"
                helperText={`Slower than ${perSecond(reviewUs)}.`}
                min={1}
                value={reviewUs}
                onChange={(v) => setReviewUs(Number.isFinite(v) ? v : 0)}
              />
              <NumberField
                label="Inefficient at (µs per event)"
                appearance={valid ? 'default' : 'danger'}
                helperText={valid ? `Slower than ${perSecond(heavyUs)}.` : 'This must be higher than the Review cost.'}
                min={2}
                value={heavyUs}
                onChange={(v) => setHeavyUs(Number.isFinite(v) ? v : 0)}
              />
            </>
          )}

          <Text variant="body-sm-normal" color="subtle">
            Cost is only one reason for a rating. Output that is discarded downstream, a Drop that runs late, or a
            flagged function can rate a pipeline Inefficient or Review whatever you choose here.
          </Text>

          <div className="drawer-footer">
            <Button
              variant="secondary"
              disabled={!changed}
              onClick={() => {
                setChoice(presetFor(thresholds));
                setReviewUs(thresholds.reviewUs);
                setHeavyUs(thresholds.heavyUs);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" disabled={!valid || !changed} pending={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="span-6">
        <div className="drawer-section">
          <Text as="h2" variant="heading-sm">
            {`Your pipelines on this scale${groupId ? `, ${groupId}` : ''}`}
          </Text>
          <Text color="subtle">
            Profiled pipelines, costliest first, and how each would be rated on cost alone. If pipelines you
            consider healthy show as Inefficient, choose a more lenient setting.
          </Text>
          {measured.length === 0 ? (
            <EmptyState
              illustration="Hibernating"
              title="No profiled pipelines in this group"
              description="Profile some pipelines, or select a group that has profiles, to see how each setting rates them."
            />
          ) : (
            <>
              <div className="table-wrap">
                <Table
                  aria-label="Profiled pipelines and how this setting rates them"
                  columns={columns}
                  visibleColumns={['name', 'rating', 'usPerEvent', 'id']}
                  items={measured.slice(0, MAX_ROWS)}
                />
              </div>
              {measured.length > MAX_ROWS && (
                <Text variant="body-sm-normal" color="subtle">
                  {`Showing the ${MAX_ROWS} costliest of ${fmtInt(measured.length)} profiled pipelines.`}
                </Text>
              )}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
