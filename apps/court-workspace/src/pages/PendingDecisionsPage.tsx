import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listPendingDecisions } from '../api/client';
import type { JudgmentRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function PendingDecisionsPage() {
  const [decisions, setDecisions] = useState<JudgmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    listPendingDecisions(undefined, controller.signal)
      .then(setDecisions)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load pending decisions.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="pending-decisions-heading">
      <h2 id="pending-decisions-heading">Pending Decisions</h2>
      <p>Judgments and orders awaiting your judicial action.</p>

      {loading && <LoadingState message="Loading pending decisions" />}
      {error && <StatusMessage kind="error" message={error} />}

      {!loading && !error && decisions.length === 0 && (
        <p>No judicial decisions are currently awaiting your action.</p>
      )}

      {!loading && !error && decisions.length > 0 && (
        <table>
          <caption>Judicial decisions awaiting action</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Court</th>
              <th scope="col">Version</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.judgmentId}>
                <td>{decision.title}</td>
                <td>{decision.decisionType}</td>
                <td>{decision.status}</td>
                <td>{decision.courtId}</td>
                <td>{decision.version}</td>
                <td>
                  <Link to={`/judgments/${encodeURIComponent(decision.judgmentId)}`}>
                    Open {decision.title}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
