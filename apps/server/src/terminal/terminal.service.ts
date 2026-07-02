import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

export interface CreateTerminalOptions {
  id: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

type TerminalSink = (chunk: string) => void;

type BunPtyTerminal = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
};

type BunPtyProcess = {
  terminal: BunPtyTerminal;
  exited: Promise<number>;
  exitCode: number | null;
};

interface TerminalEntry {
  proc: BunPtyProcess;
  terminal: BunPtyTerminal;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly entries = new Map<string, TerminalEntry>();
  private readonly outputSinks = new Map<string, TerminalSink>();
  private readonly exitSinks = new Map<string, (code: number | null) => void>();

  setOutputSink(id: string, sink: TerminalSink): void {
    this.outputSinks.set(id, sink);
  }

  setExitSink(id: string, sink: (code: number | null) => void): void {
    this.exitSinks.set(id, sink);
  }

  create(options: CreateTerminalOptions): void {
    if (!options.id) return;

    this.kill(options.id);

    const id = options.id;
    const shell = process.env.SHELL || 'bash';
    const cwd = normalizeCwd(options.cwd);
    const cols = coerceDimension(options.cols, DEFAULT_COLS);
    const rows = coerceDimension(options.rows, DEFAULT_ROWS);
    const decoder = new TextDecoder();

    const spawnOptions = {
      cwd,
      terminal: {
        cols,
        rows,
        name: 'xterm-256color',
        data: (_terminal: unknown, chunk: string | Uint8Array) => {
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
          this.outputSinks.get(id)?.(text);
        },
        exit: (code: number | null | undefined) => {
          this.exitSinks.get(id)?.(code ?? null);
          this.entries.delete(id);
          this.outputSinks.delete(id);
          this.exitSinks.delete(id);
        },
      },
    };

    const proc = Bun.spawn([shell], spawnOptions as unknown as Parameters<typeof Bun.spawn>[1]) as unknown as BunPtyProcess;

    this.entries.set(id, { proc, terminal: proc.terminal });
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string') return;
    this.entries.get(id)?.terminal.write(data);
  }

  resize(id: string, cols?: number, rows?: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.terminal.resize(coerceDimension(cols, DEFAULT_COLS), coerceDimension(rows, DEFAULT_ROWS));
  }

  kill(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.outputSinks.delete(id);
    this.exitSinks.delete(id);
    try {
      entry.terminal.close();
    } catch {
      // The terminal may already be closed by its exit callback.
    }
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) {
      this.kill(id);
    }
  }

  onModuleDestroy(): void {
    this.killAll();
  }
}

export function normalizeCwd(cwd: string | undefined): string {
  if (cwd) {
    try {
      if (existsSync(cwd) && statSync(cwd).isDirectory()) {
        return cwd;
      }
    } catch {
      // Fall through to the home directory.
    }
  }
  return homedir();
}

export function coerceDimension(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.trunc(numeric);
  return Math.min(1000, Math.max(1, integer));
}
