type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function MoneyInput({ value, onChange, disabled = false }: Props) {
  return (
    <div>
      <label htmlFor="fee-amount">Fee amount (PGK)</label>
      <input
        id="fee-amount"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder="0.00"
      />
    </div>
  );
}

export function pgkToMinorUnits(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
