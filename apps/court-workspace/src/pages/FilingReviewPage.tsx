import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  acceptFiling,
  getFiling,
  rejectFiling,
  returnFiling,
  validateFiling
} from '../api/client';
import type { Filing } from '../api/types';
import { DecisionDialog } from '../components/DecisionDialog';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function FilingReviewPage() {
  const { filingId = '' } = useParams();
  const [filing, setFiling] = useState<Filing | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<'return' | 'reject' | null>(null);

  const load = useCallback(async () => {
    if (!filingId) return;
    setError('');
    setConflict(false);
    try {
      setFiling(await getFiling(filingId));
    } catch {
      setError('Unable to load the filing.');
    }
  }, [filingId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(operation: () => Promise<Filing>) {
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const updated = await operation();
      setFiling(updated);
      setDecision(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'conflict') {
        setConflict(true);
        setError('The record changed or this action is no longer valid. Reload the filing and try again.');
      } else {
        setError('The filing action could not be completed.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!filing && !error) return <LoadingState message="Loading filing" />;

  return (
    <section aria-labelledby="filing-review-heading">
      {filing ? <h2 id="filing-review-heading">Filing {filing.filingReference}</h2> : <h2 id="filing-review-heading">Filing review</h2>}
      {error ? <StatusMessage kind="error" message={error} /> : null}
      {conflict ? <button type="button" onClick={() => void load()}>Reload filing</button> : null}

      {filing ? (
        <>
          <dl>
            <div><dt>Case type</dt><dd>{filing.caseTypeCode}</dd></div>
            <div><dt>Status</dt><dd>{filing.status}</dd></div>
            <div><dt>Filer party</dt><dd>{filing.filerPartyId}</dd></div>
          </dl>

          {filing.status === 'SUBMITTED' ? (
            <div aria-label="Registry actions">
              <button type="button" disabled={busy} onClick={() => void mutate(() => validateFiling(filing.filingId))}>Validate filing</button>
              <button type="button" disabled={busy} onClick={() => setDecision('return')}>Return filing</button>
              <button type="button" disabled={busy} onClick={() => setDecision('reject')}>Reject filing</button>
            </div>
          ) : null}

          {filing.status === 'VALIDATED' ? (
            <div aria-label="Registry manager actions">
              <button type="button" disabled={busy} onClick={() => setDecision('reject')}>Reject filing</button>
              <button type="button" disabled={busy} onClick={() => void mutate(() => acceptFiling(filing.filingId))}>Accept filing</button>
            </div>
          ) : null}

          {decision ? (
            <DecisionDialog
              kind={decision}
              busy={busy}
              onCancel={() => setDecision(null)}
              onConfirm={(reason) => mutate(() => decision === 'return'
                ? returnFiling(filing.filingId, reason)
                : rejectFiling(filing.filingId, reason))}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
