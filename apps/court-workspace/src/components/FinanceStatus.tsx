type Props = {
  label: string;
  status: string;
  reference?: string | null;
};

export function FinanceStatus({ label, status, reference }: Props) {
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      <p><strong>Status:</strong> <span>{status}</span></p>
      {reference ? <p><strong>Reference:</strong> {reference}</p> : null}
    </section>
  );
}
