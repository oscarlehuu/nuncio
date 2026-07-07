import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/forge-api', () => ({
  mergeForgePull: vi.fn(),
  updateForgeBranch: vi.fn(),
}));

import { PrMergeBar } from './pr-merge-bar';
import { mergeForgePull } from '../../lib/forge-api';
import type { ForgeCapabilitiesDto, ForgePullRequestDetail } from '../../lib/forge-api';

const CAPS: ForgeCapabilitiesDto = {
  provider: 'github',
  connected: true,
  authMethod: 'cli',
  requestChanges: true,
  rebaseMerge: true,
  mergeWhenChecksPass: false,
  resolveThreads: true,
  updateBranch: true,
  rerunFailedOnly: true,
  listRepositories: true,
};

function makeDetail(overrides: Partial<ForgePullRequestDetail> = {}): ForgePullRequestDetail {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    title: 'A change',
    body: '',
    author: 'oscar',
    draft: false,
    sourceBranch: 'nuncio/abc-x',
    targetBranch: 'main',
    mergeable: 'mergeable',
    reviewDecision: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ...overrides,
  };
}

describe('PrMergeBar', () => {
  beforeEach(() => {
    vi.mocked(mergeForgePull)
      .mockReset()
      .mockResolvedValue({ merged: true, sha: 'x', message: '' });
  });

  it('offers merge behind a confirm dialog when checks are green', async () => {
    render(
      <PrMergeBar path="/repo" number={7} detail={makeDetail()} capabilities={CAPS} onMerged={() => {}} />,
    );

    expect(mergeForgePull).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /merge…/i }));
    expect(await screen.findByText(/merge pull request #7/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm merge/i }));
    expect(mergeForgePull).toHaveBeenCalledWith(
      '/repo',
      7,
      expect.objectContaining({ method: 'squash', deleteSourceBranch: true }),
    );
  });

  it('requires the override checkbox when checks are failing', async () => {
    const detail = makeDetail({
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    });
    render(<PrMergeBar path="/repo" number={7} detail={detail} capabilities={CAPS} onMerged={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /merge…/i }));
    const mergeButton = await screen.findByRole('button', { name: /confirm merge/i });
    expect(mergeButton).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /despite failing/i }));
    expect(mergeButton).toBeEnabled();
  });

  it('shows the conflict notice instead of a merge button', () => {
    render(
      <PrMergeBar
        path="/repo"
        number={7}
        detail={makeDetail({ mergeable: 'conflicts' })}
        capabilities={CAPS}
        onMerged={() => {}}
      />,
    );
    expect(screen.getByText(/conflicts with main/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge…/i })).toBeNull();
  });

  it('shows a blocked notice with the review reason', () => {
    render(
      <PrMergeBar
        path="/repo"
        number={7}
        detail={makeDetail({ mergeable: 'blocked', reviewDecision: 'review_required' })}
        capabilities={CAPS}
        onMerged={() => {}}
      />,
    );
    expect(screen.getByText(/blocked by the repository/i)).toBeInTheDocument();
  });

  it('hides the rebase method when the forge lacks it', async () => {
    render(
      <PrMergeBar
        path="/repo"
        number={7}
        detail={makeDetail()}
        capabilities={{ ...CAPS, rebaseMerge: false }}
        onMerged={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /merge…/i }));
    expect(await screen.findByRole('button', { name: 'squash' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'rebase' })).toBeNull();
  });

  it('renders nothing for drafts', () => {
    const { container } = render(
      <PrMergeBar
        path="/repo"
        number={7}
        detail={makeDetail({ draft: true })}
        capabilities={CAPS}
        onMerged={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
