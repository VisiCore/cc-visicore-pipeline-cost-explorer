import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A multi-value filter stored in the URL query string (comma-separated), so a drill-down link can
 * preselect it and reload or back/forward restores it.
 */
export function useParamList(name: string): [string[], (next: string[]) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name) ?? '';
  const values = useMemo(() => (raw ? raw.split(',').map(decodeURIComponent) : []), [raw]);
  const setValues = useCallback(
    (next: string[]) => {
      setParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (next.length) updated.set(name, next.map(encodeURIComponent).join(','));
          else updated.delete(name);
          return updated;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );
  return [values, setValues];
}

/** Query string for a drill-down link into a filtered list. */
export function listQuery(filters: Record<string, string[]>): string {
  const params = new URLSearchParams();
  for (const [name, values] of Object.entries(filters)) {
    if (values.length) params.set(name, values.map(encodeURIComponent).join(','));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const pipelineHref = (pipelineKey: string) => `/pipelines/${encodeURIComponent(pipelineKey)}`;

/** The page for trying an edit to a pipeline, optionally opening one function (by index) for editing. */
export const pipelineTestHref = (pipelineKey: string, fnIndex?: number) =>
  `${pipelineHref(pipelineKey)}/test${fnIndex === undefined ? '' : `?fn=${fnIndex}`}`;

/**
 * The pipeline's page in the Cribl UI. Absolute, because the app runs in an iframe (and in live
 * preview on another origin entirely), so the Cribl host is taken from the API base URL.
 */
export function criblPipelineUrl(group: { id: string; type: string }, pipeline: { id: string; pack?: string }): string {
  const product = group.type === 'edge' ? 'edge' : 'stream';
  const pack = pipeline.pack ? `/p/${encodeURIComponent(pipeline.pack)}` : '';
  const path = `/${product}/m/${encodeURIComponent(group.id)}${pack}/pipelines/${encodeURIComponent(pipeline.id)}`;
  return new URL(path, window.CRIBL_API_URL).toString();
}
