import { Module } from '@nestjs/common';
import { BrowserModule } from '../../browser/browser.module';
import { AgentToolRegistry } from './agent-tool-registry';

@Module({
  imports: [BrowserModule],
  providers: [AgentToolRegistry],
  exports: [AgentToolRegistry],
})
export class AgentToolsModule {}
