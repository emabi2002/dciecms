import { OpenCasePanel } from '../components/OpenCasePanel';

export function CasesPage() {
  return (
    <section aria-labelledby="cases-heading">
      <h2 id="cases-heading">Cases</h2>
      <OpenCasePanel />
    </section>
  );
}
