import { Module } from '@nestjs/common';
import { FileExplorerService } from './file-explorer.service';
import { FsController } from './fs.controller';
import { FsService } from './fs.service';

@Module({
  controllers: [FsController],
  providers: [FsService, FileExplorerService],
  exports: [FsService, FileExplorerService],
})
export class FsModule {}
