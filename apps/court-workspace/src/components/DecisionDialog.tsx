import { useState } from 'react';

type Props = {
  kind: 'return' | 'reject';
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
};

export function DecisionDialog({ kind, busy = false, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const isReturn = kind === 'return';
  const title = isReturn ? 'Return filing' : 'Reject filing';
  const confirmLabel = isReturn ? 'Confirm return' : 'Confirm rejection';

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(isReturn ? 'A return reason is required.' : 'A rejection reason is required.');
      return;
    }
    setError('');
    await onConfirm(trimmed);
  }

  return (
    <section role="dialog" aria-modal="true" aria-labelledby="decision-title">
      <h3 id="decision-title">{title}</h3>
      <label htmlFor="decision-reason">Reason</label>
      <textarea
        id="decision-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        disabled={busy}
      />
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={submit} disabled={busy}>{confirmLabel}</button>
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
    </section>
  );
}
