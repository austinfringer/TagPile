import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmationModal from './ConfirmationModal.svelte';

/** The digits the modal is currently challenging the user with. */
function challengeDigits(): string {
  const prompt = screen.getByText(
    (_, el) => el?.tagName === 'P' && /Type \d{5} to confirm/.test(el.textContent ?? ''),
  );
  return prompt.textContent?.match(/\d{5}/)?.[0] ?? '';
}

describe('ConfirmationModal', () => {
  afterEach(cleanup);

  it('keeps Confirm disabled until the digits are typed correctly', async () => {
    const onConfirm = vi.fn();
    render(ConfirmationModal, {
      title: 'Delete thing',
      message: 'Really?',
      onConfirm,
      onCancel: vi.fn(),
    });

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    await fireEvent.input(screen.getByLabelText('Confirmation digits'), {
      target: { value: challengeDigits() },
    });
    expect(confirm).not.toBeDisabled();

    await fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it('does not confirm when the digits are wrong', async () => {
    const onConfirm = vi.fn();
    render(ConfirmationModal, {
      title: 'Delete thing',
      message: 'Really?',
      onConfirm,
      onCancel: vi.fn(),
    });

    await fireEvent.input(screen.getByLabelText('Confirmation digits'), {
      target: { value: '00000' },
    });
    // Wrong digits, or coincidentally right: repeat until the challenge differs.
    if (challengeDigits() === '00000') {
      await fireEvent.input(screen.getByLabelText('Confirmation digits'), {
        target: { value: '11111' },
      });
    }
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows the error and stays open when the action fails', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    render(ConfirmationModal, {
      title: 'Delete thing',
      message: 'Really?',
      confirmLabel: 'Delete',
      onConfirm,
      onCancel: vi.fn(),
    });

    await fireEvent.input(screen.getByLabelText('Confirmation digits'), {
      target: { value: challengeDigits() },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Escape and Cancel dismiss without confirming', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(ConfirmationModal, { title: 'Delete thing', message: 'Really?', onConfirm, onCancel });

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
