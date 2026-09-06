import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeHearing,
  getJudicialHearing,
  recordAppearance,
  recordProceeding,
  startHearing
} from '../api/client';
import { HearingModePage } from './HearingModePage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getJudicialHearing: vi.fn(),
    startHearing: vi.fn(),
    recordAppearance: vi.fn(),
    recordProceeding: vi.fn(),
    completeHearing: vi.fn()
  };
});

const mockedGetJudicialHearing = vi.mocked(getJudicialHearing);
const mockedStartHearing = vi.mocked(startHearing);
const mockedRecordAppearance = vi.mocked(recordAppearance);
const mockedRecordProceeding = vi.mocked(recordProceeding);
const mockedCompleteHearing = vi.mocked(completeHearing);

const scheduledHearing = {
  hearingId: 'hearing-1',
  caseId: 'case-1',
  courtId: 'court-a',
  hearingType: 'MENTION',
  status: 'SCHEDULED',
  scheduledStart: '2026-09-06T00:00:00.000Z',
  scheduledEnd: '2026-09-06T01:00:00.000Z',
  courtroom: 'Courtroom 2'
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetJudicialHearing.mockResolvedValue(scheduledHearing);
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/hearings/hearing-1']}>
      <Routes>
        <Route path="/hearings/:hearingId" element={<HearingModePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Hearing Mode', () => {
  it('loads the hearing and allows the magistrate to start it', async () => {
    mockedStartHearing.mockResolvedValue({ ...scheduledHearing, status: 'IN_PROGRESS' });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Hearing Mode' })).toBeInTheDocument();
    expect(await screen.findByText('MENTION')).toBeInTheDocument();
    expect(screen.getByText('Courtroom 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start hearing' }));

    expect(mockedStartHearing).toHaveBeenCalledWith('hearing-1');
    expect(await screen.findByText('IN_PROGRESS')).toBeInTheDocument();
  });

  it('records an appearance and proceeding note while the hearing is in progress', async () => {
    mockedGetJudicialHearing.mockResolvedValue({ ...scheduledHearing, status: 'IN_PROGRESS' });
    mockedRecordAppearance.mockResolvedValue({
      appearanceId: 'appearance-1', hearingId: 'hearing-1', caseId: 'case-1', courtId: 'court-a',
      participantName: 'Jane Doe', participantRole: 'Counsel', appearanceMode: 'IN_PERSON',
      recordedBy: 'mag-a', recordedAt: '2026-09-06T00:10:00.000Z'
    });
    mockedRecordProceeding.mockResolvedValue({
      proceedingId: 'proceeding-1', hearingId: 'hearing-1', caseId: 'case-1', courtId: 'court-a',
      note: 'Matter called and parties heard.', recordedBy: 'mag-a', recordedAt: '2026-09-06T00:15:00.000Z'
    });
    renderPage();

    await screen.findByText('IN_PROGRESS');
    fireEvent.change(screen.getByLabelText('Participant name'), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText('Participant role'), { target: { value: 'Counsel' } });
    fireEvent.change(screen.getByLabelText('Appearance mode'), { target: { value: 'IN_PERSON' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record appearance' }));

    expect(mockedRecordAppearance).toHaveBeenCalledWith('hearing-1', {
      participantName: 'Jane Doe', participantRole: 'Counsel', appearanceMode: 'IN_PERSON'
    });

    fireEvent.change(screen.getByLabelText('Proceeding note'), { target: { value: 'Matter called and parties heard.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record proceeding' }));

    expect(mockedRecordProceeding).toHaveBeenCalledWith('hearing-1', { note: 'Matter called and parties heard.' });
  });

  it('completes an in-progress hearing with an outcome code', async () => {
    mockedGetJudicialHearing.mockResolvedValue({ ...scheduledHearing, status: 'IN_PROGRESS' });
    mockedCompleteHearing.mockResolvedValue({ ...scheduledHearing, status: 'COMPLETED', outcomeCode: 'DECISION_RESERVED' });
    renderPage();

    await screen.findByText('IN_PROGRESS');
    fireEvent.change(screen.getByLabelText('Outcome code'), { target: { value: 'DECISION_RESERVED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete hearing' }));

    expect(mockedCompleteHearing).toHaveBeenCalledWith('hearing-1', 'DECISION_RESERVED');
    expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
  });
});
