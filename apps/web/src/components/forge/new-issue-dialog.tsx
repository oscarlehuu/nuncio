import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createForgeIssue } from '../../lib/forge-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface NewIssueDialogProps {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (number: number) => void;
}

export function NewIssueDialog({ path, open, onOpenChange, onCreated }: NewIssueDialogProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!title.trim() || creating) return;
    try {
      setCreating(true);
      const issue = await createForgeIssue(path, { title: title.trim(), body: body.trim() });
      toast.success(`Issue #${issue.number} created`);
      setTitle('');
      setBody('');
      onOpenChange(false);
      onCreated(issue.number);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create issue');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>Created on the project's forge.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={creating}
            className="text-sm"
          />
          <Textarea
            placeholder="Description (markdown)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            disabled={creating}
            className="resize-none text-sm"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={creating || !title.trim()}>
            {creating && <Loader2 className="size-4 animate-spin" />}
            Create issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
