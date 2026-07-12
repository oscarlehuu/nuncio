import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogClose, DialogContent, DialogTitle } from './dialog';

function PersistentDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent preventOutsideDismiss>
        <DialogTitle>Create profile</DialogTitle>
        <input aria-label="Profile name" />
        <DialogClose>Cancel</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

describe('DialogContent', () => {
  it('keeps form dialogs open on outside interaction but allows explicit close', async () => {
    const onOpenChange = vi.fn();
    render(<PersistentDialog onOpenChange={onOpenChange} />);

    expect(screen.getByRole('dialog')).toHaveAttribute('data-outside-dismiss', 'blocked');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps Escape as an explicit keyboard exit', () => {
    const onOpenChange = vi.fn();
    render(<PersistentDialog onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
