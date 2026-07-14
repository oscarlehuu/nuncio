import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { FsController } from '../../../src/fs/fs.controller';
import type {
  DirListingDto,
  FileListingDto,
  FileReadDto,
  FileWriteDto,
  MakeDirDto,
  RenameDto,
} from '../../../src/fs/fs.types';

describe('FsController', () => {
  const dirListing: DirListingDto = { current: '/home', parent: null, entries: [] };
  const fileListing: FileListingDto = { root: '/root', path: '', parent: null, entries: [] };
  const fileRead: FileReadDto = {
    path: 'README.md',
    content: 'hi',
    encoding: 'utf8',
    truncated: false,
    size: 2,
  };
  const fileWrite: FileWriteDto = { path: 'a.txt', size: 1 };
  const makeDirResult: MakeDirDto = { path: 'new' };
  const renameResult: RenameDto = { from: 'a', to: 'b' };
  const deleteResult = { path: 'a' };

  function controllerFor() {
    const calls: Record<string, unknown[][]> = {};
    const record = (name: string, result: unknown) => (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return result;
    };
    const fs = { listDirectories: record('listDirectories', dirListing) };
    const explorer = {
      listEntries: record('listEntries', fileListing),
      readFile: record('readFile', fileRead),
      writeFile: record('writeFile', fileWrite),
      makeDir: record('makeDir', makeDirResult),
      rename: record('rename', renameResult),
      deleteEntry: record('deleteEntry', deleteResult),
    };
    return { controller: new FsController(fs as never, explorer as never), calls, fs, explorer };
  }

  it('lists directories and wraps unexpected errors as BadRequestException', () => {
    const { controller, calls } = controllerFor();
    expect(controller.listDirs('/tmp')).toEqual(dirListing);
    expect(calls.listDirectories).toEqual([['/tmp']]);

    const broken = new FsController(
      { listDirectories: () => { throw new Error('disk full'); } } as never,
      { listEntries: () => fileListing } as never,
    );
    expect(() => broken.listDirs()).toThrow(BadRequestException);
    expect(() => broken.listDirs()).toThrow(/Failed to list directories/);
  });

  it('re-throws BadRequestException from listDirectories unchanged', () => {
    const controller = new FsController(
      { listDirectories: () => { throw new BadRequestException('bad path'); } } as never,
      { listEntries: () => fileListing } as never,
    );
    expect(() => controller.listDirs('..')).toThrow(BadRequestException);
    expect(() => controller.listDirs('..')).toThrow('bad path');
  });

  it('delegates explorer routes and wraps non-BadRequest errors', () => {
    const { controller, calls } = controllerFor();
    expect(controller.listEntries('/root', 'src')).toEqual(fileListing);
    expect(calls.listEntries).toEqual([['/root', 'src']]);

    expect(controller.readFile('/root', 'README.md')).toEqual(fileRead);
    expect(calls.readFile).toEqual([['/root', 'README.md']]);

    expect(controller.writeFile({ root: '/root', path: 'a.txt', content: 'x' })).toEqual(fileWrite);
    expect(calls.writeFile).toEqual([['/root', 'a.txt', 'x']]);

    expect(controller.makeDir({ root: '/root', path: 'new' })).toEqual(makeDirResult);
    expect(calls.makeDir).toEqual([['/root', 'new']]);

    expect(controller.rename({ root: '/root', from: 'a', to: 'b' })).toEqual(renameResult);
    expect(calls.rename).toEqual([['/root', 'a', 'b']]);

    expect(controller.deleteEntry({ root: '/root', path: 'a' })).toEqual(deleteResult);
    expect(calls.deleteEntry).toEqual([['/root', 'a']]);

    const broken = new FsController(
      { listDirectories: () => dirListing } as never,
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
      { listDirectories: () => dirListing } as never,
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
