import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getJudgment,
  issueJudgment,
  reviewJudgment,
  signJudgment,
  updateJudgmentDraft
} from '../api/client';
import { JudgmentWorkspacePage } from './JudgmentWorkspacePage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getJudgment: vi.fn(),
    updateJudgmentDraft: vi.fn(),
    reviewJudgment: vi.fn(),
    signJudgment: vi.fn(),
    issueJudgment: vi.fn()
  };
});

const mockedGetJudgment = vi.mocked(getJudgment);
const mockedUpdateJudgmentDraft = vi.mocked(updateJudgmentDraft);
const mockedReviewJudgment = vi.mocked(reviewJudgment);
const mockedSignJudgment = vi.mocked(signJudgment);
const mockedIssueJudgment = vi.mocked(issueJudgment);

const draftJudgment = {
  judgmentId: 'judgment-1',
  caseId: 'case-1',
  hearingId: 'hearing-1',
  courtId: 'court-a',
  decisionType: 'JUDGMENT',
  title: 'Reserved judgment',
  content: 'Initial reasons.',
  status: 'DRAFT',
  version: 1,
  createdBy: 'mag-a',
  createdAt: '2026-09-06T00:00:00.000Z'
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetJudgment.mockResolvedValue(draftJudgment);
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/judgments/judgment-1']}>
      <Routes>
        <Route path="/judgments/:judgmentId" element={<JudgmentWorkspacePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Judgment / Order Workspace', () => {
  it('loads a draft decision and allows title/content editing', async () => {
    mockedUpdateJudgmentDraft.mockResolvedValue({
      ...draftJudgment,
      title: 'Updated judgment',
      content: 'Updated reasons.',
      version: 2
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Judgment / Order Workspace' })).toBeInTheDocument();
    expect(await screen.findByText('DRAFT')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Decision title'), { target: { value: 'Updated judgment' } });
    fireEvent.change(screen.getByLabelText('Decision content'), { target: { value: 'Updated reasons.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(mockedUpdateJudgmentDraft).toHaveBeenCalledWith('judgment-1', {
      title: 'Updated judgment',
      content: 'Updated reasons.'
    });
    expect(await screen.findByDisplayValue('Updated judgment')).toBeInTheDocument();
  });

  it('reviews/finalizes a draft decision', async () => {
    mockedReviewJudgment.mockResolvedValue({ ...draftJudgment, status: 'FINAL', reviewedBy: 'mag-a' });
    renderPage();

    await screen.findByText('DRAFT');
    fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }));

    expect(mockedReviewJudgment).toHaveBeenCalledWith('judgment-1');
    expect(await screen.findByText('FINAL')).toBeInTheDocument();
  });

  it('signs a final decision and issues a signed decision', async () => {
    mockedGetJudgment.mockResolvedValue({ ...draftJudgment, status: 'FINAL' });
    mockedSignJudgment.mockResolvedValue({ ...draftJudgment, status: 'SIGNED', signedBy: 'mag-a' });
    mockedIssueJudgment.mockResolvedValue({ ...draftJudgment, status: 'ISSUED', issuedBy: 'mag-a' });

    renderPage();
    await screen.findByText('FINAL');
    fireEvent.click(screen.getByRole('button', { name: 'Sign decision' }));

    expect(mockedSignJudgment).toHaveBeenCalledWith('judgment-1');
    expect(await screen.findByText('SIGNED')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Issue decision' }));
    expect(mockedIssueJudgment).toHaveBeenCalledWith('judgment-1');
    expect(await screen.findByText('ISSUED')).toBeInTheDocument();
  });
});
