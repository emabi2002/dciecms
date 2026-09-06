import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyCases } from '../api/client';
import type { CaseRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function MyCasesPage() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    listMyCases(undefined, controller.signal)
      .then(setCases)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load assigned cases.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="my-cases-heading">
      <h2 id="my-cases-heading">My Cases</h2>
      <p>Cases currently assigned to your judicial work queue.</p>

      {loading && <LoadingState label="Loading assigned cases" />}
      {error && <StatusMessage kind="error" message={error} />}

      {!loading && !error && cases.length === 0 && (
        <p>No cases are currently assigned to you.</p>
      )}

      {!loading && !error && cases.length > 0 && (
        <table>
          <caption className="sr-only">Assigned judicial cases</caption>
          <thead>
            <tr>
              <th scope="col">Case number</th>
              <th scope="col">Court</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((courtCase) => (
              <tr key={courtCase.caseId}>
                <td>{courtCase.caseNumber}</td>
                <td>{courtCase.courtId}</td>
                <td>{courtCase.status}</td>
                <td>
                  <Link to={`/cases/${encodeURIComponent(courtCase.caseId)}`}>
                    Open {courtCase.caseNumber}
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
