import { BadRequestException, Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { FileExplorerService } from './file-explorer.service';
import { FsService } from './fs.service';

/**
 * Filesystem browsing endpoints. Used by the frontend folder picker to
 * navigate the host machine and select an absolute project path — browsers
 * cannot do this directly, so the server lists directories on behalf of the
 * client (works on the iPhone PWA).
 */
@Controller('fs')
export class FsController {
  constructor(
    private readonly fs: FsService,
    private readonly explorer: FileExplorerService,
  ) {}

  /** List subdirectories of `path` (defaults to the user's home dir). */
  @Get('dirs')
  listDirs(@Query('path') path?: string) {
    try {
      return this.fs.listDirectories(path ?? '');
    } catch (error) {
      // Re-throw BadRequestException as-is; wrap unexpected errors as 400.
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to list directories: ${message}`);
    }
  }

  @Get('entries')
  listEntries(@Query('root') root?: string, @Query('path') path?: string) {
    try {
      return this.explorer.listEntries(root ?? '', path ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to list entries: ${message}`);
    }
  }

  @Get('file')
  readFile(@Query('root') root?: string, @Query('path') path?: string) {
    try {
      return this.explorer.readFile(root ?? '', path ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to read file: ${message}`);
    }
  }

  @Put('file')
  writeFile(@Body() body: { root?: string; path?: string; content?: string }) {
    try {
      return this.explorer.writeFile(body?.root ?? '', body?.path ?? '', body?.content ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to write file: ${message}`);
    }
  }

  @Post('dir')
  makeDir(@Body() body: { root?: string; path?: string }) {
    try {
      return this.explorer.makeDir(body?.root ?? '', body?.path ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to create directory: ${message}`);
    }
  }

  @Post('rename')
  rename(@Body() body: { root?: string; from?: string; to?: string }) {
    try {
      return this.explorer.rename(body?.root ?? '', body?.from ?? '', body?.to ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to rename entry: ${message}`);
    }
  }

  @Delete('entry')
  deleteEntry(@Body() body: { root?: string; path?: string }) {
    try {
      return this.explorer.deleteEntry(body?.root ?? '', body?.path ?? '');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to delete entry: ${message}`);
    }
  }
}
