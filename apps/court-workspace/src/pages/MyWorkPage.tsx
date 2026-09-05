import { useEffect, useState } from 'react';
import { listRegistryFilings, listWorkflowTasks } from '../api/client';
import type { Filing, WorkflowTask } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

type DashboardState = {
  filings: Filing[];
  tasks: WorkflowTask[];
};

export function MyWorkPage() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      listRegistryFilings(undefined, controller.signal),
      listWorkflowTasks(false, undefined, controller.signal)
    ])
      .then(([filings, tasks]) => {
        setState({ filings, tasks });
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="my-work-heading">
      <h2 id="my-work-heading">My Work</h2>
      {error ? <StatusMessage kind="error" message="Unable to load the work queue." /> : null}
      {!error && !state ? <LoadingState message="Loading work queue" /> : null}
      {!error && state && state.filings.length === 0 && state.tasks.length === 0
        ? <EmptyState message="No work requires your attention." />
        : null}
      {!error && state && (state.filings.length > 0 || state.tasks.length > 0) ? (
        <div aria-label="Work summary">
          <article>
            <strong>{state.tasks.length}</strong>
            <p>Pending Registry tasks</p>
          </article>
          <article>
            <strong>{state.filings.length}</strong>
            <p>Submitted filings</p>
          </article>
        </div>
      ) : null}
    </section>
  );
}
