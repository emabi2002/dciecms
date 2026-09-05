export function LoadingState({ message = 'Loading' }: { message?: string }) {
  return <p role="status" aria-live="polite">{message}</p>;
}
