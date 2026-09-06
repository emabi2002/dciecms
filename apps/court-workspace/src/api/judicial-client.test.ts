import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeHearing,
  createJudgment,
  getJudicialCase,
  getJudicialHearing,
  getJudgment,
  listDailyHearings,
  listMyCases,
  listPendingDecisions,
  recordAppearance,
  recordProceeding,
  reviewJudgment,
  signJudgment,
  startHearing,
  updateJudgmentDraft
} from './client';

afterEach(() => vi.unstubAllGlobals());

function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Judicial Workbench API client', () => {
  it('loads the authenticated magistrate case queue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([]));
    vi.stubGlobal('fetch', fetchMock);
    await listMyCases({ baseUrl: '/api' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/judicial/my-cases');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('loads a PNG-local daily hearing list by date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([]));
    vi.stubGlobal('fetch', fetchMock);
    await listDailyHearings('2026-09-07', { baseUrl: '/api' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/judicial/daily-list?date=2026-09-07');
  });

  it('loads judicial case, hearing, judgment and pending-decision read models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal('fetch', fetchMock);
    await getJudicialCase('c-1', { baseUrl: '/api' });
    await getJudicialHearing('h-1', { baseUrl: '/api' });
    await getJudgment('j-1', { baseUrl: '/api' });
    await listPendingDecisions({ baseUrl: '/api' });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/judicial/cases/c-1',
      '/api/judicial/hearings/h-1',
      '/api/judicial/judgments/j-1',
      '/api/judicial/pending-decisions'
    ]);
    expect(fetchMock.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });

  it('uses dedicated hearing-mode action endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: 'IN_PROGRESS' }));
    vi.stubGlobal('fetch', fetchMock);
    await startHearing('h-1', { baseUrl: '/api' });
    await recordAppearance('h-1', { participantName: 'Jane Doe', participantRole: 'DEFENDANT', appearanceMode: 'IN_PERSON' }, { baseUrl: '/api' });
    await recordProceeding('h-1', { recordReference: 'AUDIO-2026-0001' }, { baseUrl: '/api' });
    await completeHearing('h-1', 'DECISION_RESERVED', { baseUrl: '/api' });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/hearings/h-1/start',
      '/api/hearings/h-1/appearances',
      '/api/hearings/h-1/proceedings',
      '/api/hearings/h-1/complete'
    ]);
  });

  it('supports draft judgment creation and PUT editing before lifecycle transitions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ judgmentId: 'j-1', status: 'DRAFT' }));
    vi.stubGlobal('fetch', fetchMock);
    await createJudgment('c-1', { hearingId: 'h-1', decisionType: 'JUDGMENT', title: 'Decision', content: 'Reasons.' }, { baseUrl: '/api' });
    await updateJudgmentDraft('j-1', { title: 'Revised', content: 'Revised reasons.' }, { baseUrl: '/api' });
    await reviewJudgment('j-1', { baseUrl: '/api' });
    await signJudgment('j-1', { baseUrl: '/api' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/cases/c-1/judgments');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/judgments/j-1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/judgments/j-1/review');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/judgments/j-1/sign');
  });
});
