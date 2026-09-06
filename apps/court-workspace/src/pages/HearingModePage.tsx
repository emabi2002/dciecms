import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  completeHearing,
  getJudicialHearing,
  recordAppearance,
  recordProceeding,
  startHearing
} from '../api/client';
import type { HearingRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function HearingModePage() {
  const { hearingId } = useParams<{ hearingId: string }>();
  const [hearing, setHearing] = useState<HearingRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [participantName, setParticipantName] = useState('');
  const [participantRole, setParticipantRole] = useState('');
  const [appearanceMode, setAppearanceMode] = useState('IN_PERSON');
  const [proceedingNote, setProceedingNote] = useState('');
  const [outcomeCode, setOutcomeCode] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!hearingId) {
      setError('A hearing identifier is required.');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getJudicialHearing(hearingId, undefined, controller.signal)
      .then(setHearing)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load hearing details.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [hearingId]);

  async function handleStart() {
    if (!hearingId) return;
    setError(null);
    setStatusMessage(null);
    try {
      const updated = await startHearing(hearingId);
      setHearing(updated);
      setStatusMessage('Hearing started.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start hearing.');
    }
  }

  async function submitAppearance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hearingId) return;
    setError(null);
    setStatusMessage(null);
    try {
      await recordAppearance(hearingId, { participantName, participantRole, appearanceMode });
      setParticipantName('');
      setParticipantRole('');
      setStatusMessage('Appearance recorded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to record appearance.');
    }
  }

  async function submitProceeding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hearingId) return;
    setError(null);
    setStatusMessage(null);
    try {
      await recordProceeding(hearingId, { note: proceedingNote });
      setProceedingNote('');
      setStatusMessage('Proceeding note recorded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to record proceeding.');
    }
  }

  async function submitCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hearingId) return;
    setError(null);
    setStatusMessage(null);
    try {
      const updated = await completeHearing(hearingId, outcomeCode);
      setHearing(updated);
      setStatusMessage('Hearing completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete hearing.');
    }
  }

  return (
    <section aria-labelledby="hearing-mode-heading">
      <h2 id="hearing-mode-heading">Hearing Mode</h2>
      {loading && <LoadingState message="Loading hearing" />}
      {error && <StatusMessage kind="error" message={error} />}
      {statusMessage && <StatusMessage message={statusMessage} />}

      {!loading && hearing && (
        <>
          <dl>
            <dt>Hearing type</dt><dd>{hearing.hearingType}</dd>
            <dt>Courtroom</dt><dd>{hearing.courtroom || 'Not allocated'}</dd>
            <dt>Status</dt><dd>{hearing.status}</dd>
            <dt>Court</dt><dd>{hearing.courtId}</dd>
          </dl>

          <p><Link to={`/cases/${encodeURIComponent(hearing.caseId)}`}>Open case workspace</Link></p>

          {hearing.status === 'SCHEDULED' && (
            <button type="button" onClick={handleStart}>Start hearing</button>
          )}

          {hearing.status === 'IN_PROGRESS' && (
            <>
              <form onSubmit={submitAppearance}>
                <h3>Record appearance</h3>
                <label htmlFor="participant-name">Participant name</label>
                <input id="participant-name" value={participantName} onChange={(event) => setParticipantName(event.target.value)} required />
                <label htmlFor="participant-role">Participant role</label>
                <input id="participant-role" value={participantRole} onChange={(event) => setParticipantRole(event.target.value)} required />
                <label htmlFor="appearance-mode">Appearance mode</label>
                <select id="appearance-mode" value={appearanceMode} onChange={(event) => setAppearanceMode(event.target.value)}>
                  <option value="IN_PERSON">In person</option>
                  <option value="VIDEO">Video</option>
                  <option value="TELEPHONE">Telephone</option>
                </select>
                <button type="submit">Record appearance</button>
              </form>

              <form onSubmit={submitProceeding}>
                <h3>Record proceeding</h3>
                <label htmlFor="proceeding-note">Proceeding note</label>
                <textarea id="proceeding-note" value={proceedingNote} onChange={(event) => setProceedingNote(event.target.value)} required />
                <button type="submit">Record proceeding</button>
              </form>

              <form onSubmit={submitCompletion}>
                <h3>Complete hearing</h3>
                <label htmlFor="outcome-code">Outcome code</label>
                <input id="outcome-code" value={outcomeCode} onChange={(event) => setOutcomeCode(event.target.value)} required />
                <button type="submit">Complete hearing</button>
              </form>
            </>
          )}
        </>
      )}
    </section>
  );
}
