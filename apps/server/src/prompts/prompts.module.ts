import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PromptProfileService } from './prompt-profile.service';

@Module({
  imports: [SettingsModule],
  providers: [PromptProfileService],
  exports: [PromptProfileService],
})
export class PromptsModule {}
