import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ProvisionController } from './provision.controller';
import { ProvisionService } from './provision.service';

@Module({
  imports: [SettingsModule],
  controllers: [ProvisionController],
  providers: [ProvisionService],
  exports: [ProvisionService],
})
export class ProvisionModule {}
