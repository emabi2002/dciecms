export function StatusMessage({ message, kind = 'status' }: { message: string; kind?: 'status' | 'error' }) {
  return kind === 'error'
    ? <p role="alert">{message}</p>
    : <p role="status" aria-live="polite">{message}</p>;
}
