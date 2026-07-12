import { Module } from '@nestjs/common';
import { chromium } from 'playwright-core';
import { BrowserModule } from '../browser/browser.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { EvidenceCaptureService } from './evidence-capture.service';
import { readEvidenceGitHead } from './evidence-git-head';
import { EVIDENCE_CHROMIUM, EVIDENCE_GIT_HEAD } from './evidence.types';

@Module({
  imports: [BrowserModule, SessionsPersistenceModule],
  providers: [
    EvidenceCaptureService,
    { provide: EVIDENCE_CHROMIUM, useValue: chromium },
    { provide: EVIDENCE_GIT_HEAD, useValue: readEvidenceGitHead },
  ],
  exports: [EvidenceCaptureService],
})
export class EvidenceModule {}
