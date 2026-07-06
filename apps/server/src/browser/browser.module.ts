import { Module } from '@nestjs/common';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';
import { BrowserToolService, EXTERNAL_BROWSER_BACKEND } from './browser-tool.service';
import { ExternalBrowserBackend } from './external-browser.backend';
import { InAppBrowserBackend } from './in-app-browser.backend';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [BrowserController],
  providers: [
    BrowserService,
    ExternalBrowserBackend,
    InAppBrowserBackend,
    BrowserToolService,
    { provide: EXTERNAL_BROWSER_BACKEND, useExisting: ExternalBrowserBackend },
  ],
  exports: [BrowserService, BrowserToolService, InAppBrowserBackend],
})
export class BrowserModule {}
