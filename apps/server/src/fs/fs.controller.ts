import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { FsService } from './fs.service';

/**
 * Filesystem browsing endpoints. Used by the frontend folder picker to
 * navigate the host machine and select an absolute project path — browsers
 * cannot do this directly, so the server lists directories on behalf of the
 * client (works on the iPhone PWA).
 */
@Controller('fs')
export class FsController {
  constructor(private readonly fs: FsService) {}

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
}
