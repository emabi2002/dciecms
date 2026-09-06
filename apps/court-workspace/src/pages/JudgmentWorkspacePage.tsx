import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getJudgment,
  issueJudgment,
  reviewJudgment,
  signJudgment,
  updateJudgmentDraft
} from '../api/client';
import type { JudgmentRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

export function JudgmentWorkspacePage() {
  const { judgmentId } = useParams<{ judgmentId: string }>();
  const [judgment, setJudgment] = useState<JudgmentRecord | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!judgmentId) {
      setError('Judgment identifier is missing.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getJudgment(judgmentId, undefined, controller.signal)
      .then((row) => {
        setJudgment(row);
        setTitle(row.title);
        setContent(row.content);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load the judicial decision.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [judgmentId]);

  async function runAction(action: () => Promise<JudgmentRecord>, message: string) {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const updated = await action();
      setJudgment(updated);
      setTitle(updated.title);
      setContent(updated.content);
      setStatusMessage(message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The judicial decision action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!judgmentId) return;
    void runAction(
      () => updateJudgmentDraft(judgmentId, { title, content }),
      'Draft saved.'
    );
  }

  if (loading) return <LoadingState message="Loading judgment workspace" />;
  if (error && !judgment) return <StatusMessage kind="error" message={error} />;
  if (!judgment) return <StatusMessage kind="error" message="Judicial decision not found." />;

  const isDraft = judgment.status === 'DRAFT';
  const isFinal = judgment.status === 'FINAL';
  const isSigned = judgment.status === 'SIGNED';

  return (
    <section aria-labelledby="judgment-workspace-heading">
      <h2 id="judgment-workspace-heading">Judgment / Order Workspace</h2>
      <p>Server-controlled judicial decision lifecycle.</p>

      <dl>
        <dt>Status</dt><dd>{judgment.status}</dd>
        <dt>Decision type</dt><dd>{judgment.decisionType}</dd>
        <dt>Court</dt><dd>{judgment.courtId}</dd>
        <dt>Version</dt><dd>{judgment.version}</dd>
      </dl>

      {error && <StatusMessage kind="error" message={error} />}
      {statusMessage && <StatusMessage message={statusMessage} />}

      <form onSubmit={saveDraft}>
        <label htmlFor="decision-title">Decision title</label>
        <input
          id="decision-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={!isDraft || busy}
          required
        />

        <label htmlFor="decision-content">Decision content</label>
        <textarea
          id="decision-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={!isDraft || busy}
          required
        />

        {isDraft && <button type="submit" disabled={busy}>Save draft</button>}
      </form>

      <div aria-label="Decision lifecycle actions">
        {isDraft && (
          <button
            type="button"
            disabled={busy}
            onClick={() => judgmentId && void runAction(() => reviewJudgment(judgmentId), 'Decision finalized.')}
          >
            Review and finalize
          </button>
        )}
        {isFinal && (
          <button
            type="button"
            disabled={busy}
            onClick={() => judgmentId && void runAction(() => signJudgment(judgmentId), 'Decision signed.')}
          >
            Sign decision
          </button>
        )}
        {isSigned && (
          <button
            type="button"
            disabled={busy}
            onClick={() => judgmentId && void runAction(() => issueJudgment(judgmentId), 'Decision issued.')}
          >
            Issue decision
          </button>
        )}
      </div>

      <p>
        <Link to={`/cases/${encodeURIComponent(judgment.caseId)}`}>Open related case</Link>
        {' · '}
        <Link to="/judicial/pending-decisions">Back to Pending Decisions</Link>
      </p>
    </section>
  );
}
