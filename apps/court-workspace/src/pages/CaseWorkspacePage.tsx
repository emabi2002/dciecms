import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getJudicialCase } from '../api/client';
import type { CaseRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function CaseWorkspacePage() {
  const { caseId } = useParams();
  const [courtCase, setCourtCase] = useState<CaseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseId) {
      setError('A case identifier is required.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getJudicialCase(caseId, undefined, controller.signal)
      .then(setCourtCase)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load the judicial case.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [caseId]);

  return (
    <section aria-labelledby="case-workspace-heading">
      {loading && <LoadingState message="Loading judicial case" />}
      {error && <StatusMessage kind="error" message={error} />}

      {!loading && !error && courtCase && (
        <>
          <header>
            <p>Judicial Case Workspace</p>
            <h2 id="case-workspace-heading">{courtCase.caseNumber}</h2>
          </header>

          <dl>
            <div>
              <dt>Status</dt>
              <dd>{courtCase.status}</dd>
            </div>
            <div>
              <dt>Court</dt>
              <dd>{courtCase.courtId}</dd>
            </div>
            <div>
              <dt>Case type</dt>
              <dd>{courtCase.caseTypeCode ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Assigned Magistrate</dt>
              <dd>{courtCase.assignedToSubject ?? 'Not assigned'}</dd>
            </div>
            <div>
              <dt>Assigned by</dt>
              <dd>{courtCase.assignedBySubject ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Assignment date</dt>
              <dd>{courtCase.assignedAt ? new Date(courtCase.assignedAt).toLocaleString('en-PG', { timeZone: 'Pacific/Port_Moresby' }) : 'Not recorded'}</dd>
            </div>
          </dl>

          <section aria-labelledby="hearing-work-heading">
            <h3 id="hearing-work-heading">Hearing work</h3>
            <p>Use the judicial hearing list to review scheduled matters and continue hearing-related work.</p>
            <Link to="/judicial/daily-hearings">View Daily Hearings</Link>
          </section>

          <p>
            <Link to="/judicial/my-cases">Back to My Cases</Link>
          </p>
        </>
      )}
    </section>
  );
}
