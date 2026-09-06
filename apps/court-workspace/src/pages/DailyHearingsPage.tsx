import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listDailyHearings } from '../api/client';
import type { HearingRecord } from '../api/types';
import { LoadingState } from '../components/LoadingState';
import { StatusMessage } from '../components/StatusMessage';

function pngToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Port_Moresby',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function pngTime(value: string): string {
  return new Intl.DateTimeFormat('en-PG', {
    timeZone: 'Pacific/Port_Moresby',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

export function DailyHearingsPage({ initialDate = pngToday() }: { initialDate?: string }) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [loadedDate, setLoadedDate] = useState(initialDate);
  const [hearings, setHearings] = useState<HearingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((date: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    return listDailyHearings(date, undefined, signal)
      .then((rows) => {
        setHearings(rows);
        setLoadedDate(date);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load the daily hearing list.');
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(initialDate, controller.signal);
    return () => controller.abort();
  }, [initialDate, load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(selectedDate, new AbortController().signal);
  }

  return (
    <section aria-labelledby="daily-hearings-heading">
      <h2 id="daily-hearings-heading">Daily Hearings</h2>
      <p>Judicial daily list shown in Papua New Guinea local time.</p>

      <form onSubmit={submit}>
        <label htmlFor="hearing-date">Hearing date</label>
        <input
          id="hearing-date"
          type="date"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
          required
        />
        <button type="submit">Load hearings</button>
      </form>

      {loading && <LoadingState message="Loading daily hearings" />}
      {error && <StatusMessage kind="error" message={error} />}

      {!loading && !error && hearings.length === 0 && (
        <p>No hearings are scheduled for this date.</p>
      )}

      {!loading && !error && hearings.length > 0 && (
        <table>
          <caption>Hearings for {loadedDate}</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Type</th>
              <th scope="col">Courtroom</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {hearings.map((hearing) => (
              <tr key={hearing.hearingId}>
                <td>{pngTime(hearing.scheduledStart)}–{pngTime(hearing.scheduledEnd)}</td>
                <td>{hearing.hearingType}</td>
                <td>{hearing.courtroom || 'Not allocated'}</td>
                <td>{hearing.status}</td>
                <td>
                  <Link to={`/hearings/${encodeURIComponent(hearing.hearingId)}`}>Open hearing</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
