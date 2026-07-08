import { Module, forwardRef } from '@nestjs/common';
import { BrowserModule } from '../../browser/browser.module';
import { OrchestrationToolsModule } from '../../orchestration/tools/orchestration-tools.module';
import { AgentToolRegistry } from './agent-tool-registry';

@Module({
  imports: [BrowserModule, forwardRef(() => OrchestrationToolsModule)],
  providers: [AgentToolRegistry],
  exports: [AgentToolRegistry],
})
export class AgentToolsModule {}
