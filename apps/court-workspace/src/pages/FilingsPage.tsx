import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listRegistryFilings } from '../api/client';
import type { Filing } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

function formatSubmitted(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function FilingsPage() {
  const [filings, setFilings] = useState<Filing[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listRegistryFilings(undefined, controller.signal)
      .then((rows) => {
        setFilings(rows);
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="filings-heading">
      <h2 id="filings-heading">Filings</h2>
      {error ? <StatusMessage kind="error" message="Unable to load the Registry filing queue." /> : null}
      {!error && filings === null ? <LoadingState message="Loading Registry filing queue" /> : null}
      {!error && filings?.length === 0
        ? <EmptyState message="No filings are waiting in your Registry queue." />
        : null}
      {!error && filings && filings.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Filing reference</th>
                <th scope="col">Case type</th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {filings.map((filing) => (
                <tr key={filing.filingId}>
                  <td>{filing.filingReference}</td>
                  <td>{filing.caseTypeCode}</td>
                  <td>{filing.status}</td>
                  <td>{formatSubmitted(filing.submittedAt)}</td>
                  <td><Link to={`/filings/${encodeURIComponent(filing.filingId)}`}>Open {filing.filingReference}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
