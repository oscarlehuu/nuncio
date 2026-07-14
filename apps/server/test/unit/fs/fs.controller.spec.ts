import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { FsController } from '../../../src/fs/fs.controller';

describe('FsController', () => {
  function controllerFor() {
    const calls: Record<string, unknown[][]> = {};
    const record = (name: string, result: unknown = { ok: true }) => (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return result;
    };
    const fs = { listDirectories: record('listDirectories', { current: '/home', entries: [] }) };
    const explorer = {
      listEntries: record('listEntries', { entries: [] }),
      readFile: record('readFile', { content: 'hi' }),
      writeFile: record('writeFile', { ok: true }),
      makeDir: record('makeDir', { ok: true }),
      rename: record('rename', { ok: true }),
      deleteEntry: record('deleteEntry', { ok: true }),
    };
    return { controller: new FsController(fs as never, explorer as never), calls, fs, explorer };
  }

  it('lists directories and wraps unexpected errors as BadRequestException', () => {
    const { controller, calls } = controllerFor();
    expect(controller.listDirs('/tmp')).toEqual({ current: '/home', entries: [] });
    expect(calls.listDirectories).toEqual([['/tmp']]);

    const broken = new FsController(
      { listDirectories: () => { throw new Error('disk full'); } } as never,
      { listEntries: () => ({}) } as never,
    );
    expect(() => broken.listDirs()).toThrow(BadRequestException);
    expect(() => broken.listDirs()).toThrow(/Failed to list directories/);
  });

  it('re-throws BadRequestException from listDirectories unchanged', () => {
    const controller = new FsController(
      { listDirectories: () => { throw new BadRequestException('bad path'); } } as never,
      { listEntries: () => ({}) } as never,
    );
    expect(() => controller.listDirs('..')).toThrow(BadRequestException);
    expect(() => controller.listDirs('..')).toThrow('bad path');
  });

  it('delegates explorer routes and wraps non-BadRequest errors', () => {
    const { controller, calls } = controllerFor();
    expect(controller.listEntries('/root', 'src')).toEqual({ entries: [] });
    expect(calls.listEntries).toEqual([['/root', 'src']]);

    expect(controller.readFile('/root', 'README.md')).toEqual({ content: 'hi' });
    expect(calls.readFile).toEqual([['/root', 'README.md']]);

    expect(controller.writeFile({ root: '/root', path: 'a.txt', content: 'x' })).toEqual({ ok: true });
    expect(calls.writeFile).toEqual([['/root', 'a.txt', 'x']]);

    expect(controller.makeDir({ root: '/root', path: 'new' })).toEqual({ ok: true });
    expect(calls.makeDir).toEqual([['/root', 'new']]);

    expect(controller.rename({ root: '/root', from: 'a', to: 'b' })).toEqual({ ok: true });
    expect(calls.rename).toEqual([['/root', 'a', 'b']]);

    expect(controller.deleteEntry({ root: '/root', path: 'a' })).toEqual({ ok: true });
    expect(calls.deleteEntry).toEqual([['/root', 'a']]);

    const broken = new FsController(
      { listDirectories: () => ({}) } as never,
      { readFile: () => { throw new Error('ENOENT'); } } as never,
    );
    expect(() => broken.readFile('/root', 'missing')).toThrow(/Failed to read file/);
    expect(() =>
      broken.writeFile({ root: '/root', path: 'a', content: 'x' }),
    ).toThrow(/Failed to write file/);
    expect(() => broken.makeDir({ root: '/root', path: 'n' })).toThrow(/Failed to create directory/);
    expect(() => broken.rename({ root: '/root', from: 'a', to: 'b' })).toThrow(/Failed to rename entry/);
    expect(() => broken.deleteEntry({ root: '/root', path: 'a' })).toThrow(/Failed to delete entry/);
  });

  it('re-throws BadRequestException from explorer methods unchanged', () => {
    const controller = new FsController(
      { listDirectories: () => ({}) } as never,
      {
        listEntries: () => { throw new BadRequestException('traversal'); },
        readFile: () => { throw new BadRequestException('traversal'); },
        writeFile: () => { throw new BadRequestException('traversal'); },
        makeDir: () => { throw new BadRequestException('traversal'); },
        rename: () => { throw new BadRequestException('traversal'); },
        deleteEntry: () => { throw new BadRequestException('traversal'); },
      } as never,
    );
    expect(() => controller.listEntries('/root', '../escape')).toThrow('traversal');
    expect(() => controller.readFile('/root', '../escape')).toThrow('traversal');
  });
});
