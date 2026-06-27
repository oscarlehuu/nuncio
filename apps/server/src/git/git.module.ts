import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { GitController } from './git.controller';
import { GitService } from './git.service';

@Module({
  imports: [SettingsModule],
  controllers: [GitController],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}
