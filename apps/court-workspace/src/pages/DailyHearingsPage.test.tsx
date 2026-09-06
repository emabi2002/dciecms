import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listDailyHearings } from '../api/client';
import { DailyHearingsPage } from './DailyHearingsPage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, listDailyHearings: vi.fn() };
});

const mockedListDailyHearings = vi.mocked(listDailyHearings);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Daily Hearings Judicial Workbench', () => {
  it('loads the selected PNG-local date and renders the judicial daily list', async () => {
    mockedListDailyHearings.mockResolvedValue([
      {
        hearingId: 'hearing-1',
        caseId: 'case-1',
        courtId: 'court-a',
        hearingType: 'MENTION',
        status: 'SCHEDULED',
        scheduledStart: '2026-09-06T23:00:00.000Z',
        scheduledEnd: '2026-09-06T23:30:00.000Z',
        courtroom: 'Courtroom 2'
      }
    ]);

    render(
      <MemoryRouter>
        <DailyHearingsPage initialDate="2026-09-07" />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Daily Hearings' })).toBeInTheDocument();
    expect(mockedListDailyHearings).toHaveBeenCalledWith('2026-09-07', undefined, expect.any(AbortSignal));
    expect(await screen.findByText('MENTION')).toBeInTheDocument();
    expect(screen.getByText('Courtroom 2')).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open hearing' })).toHaveAttribute('href', '/hearings/hearing-1');
  });

  it('reloads the list when the judicial officer changes the date', async () => {
    mockedListDailyHearings.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <DailyHearingsPage initialDate="2026-09-07" />
      </MemoryRouter>
    );

    await screen.findByText('No hearings are scheduled for this date.');
    fireEvent.change(screen.getByLabelText('Hearing date'), { target: { value: '2026-09-08' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load hearings' }));

    expect(mockedListDailyHearings).toHaveBeenLastCalledWith('2026-09-08', undefined, expect.any(AbortSignal));
  });
});
