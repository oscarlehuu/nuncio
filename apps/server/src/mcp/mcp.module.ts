import { Module } from '@nestjs/common';
import { AgentToolsModule } from '../agents/tools/agent-tools.module';
import { DatabaseModule } from '../db/database.module';
import { DatabaseService } from '../db/database.service';
import { GitModule } from '../git/git.module';
import { ProjectsModule } from '../projects/projects.module';
import { loadSettingsKey } from '../settings/settings.crypto';
import { McpOAuthController } from './api/mcp-oauth.controller';
import { McpServersController } from './api/mcp-servers.controller';
import { McpBridgeToolSource } from './bridge/mcp-bridge.tool-source';
import { SdkMcpClientFactory } from './bridge/mcp-client.factory';
import { MCP_CLIENT_FACTORY } from './bridge/mcp-client.types';
import { McpImportService } from './import/mcp-import.service';
import { McpOAuthService } from './oauth/mcp-oauth.service';
import { McpOAuthRepository } from './persistence/mcp-oauth.repository';
import { MCP_SETTINGS_KEY, McpServersRepository } from './persistence/mcp-servers.repository';
import { McpService } from './mcp.service';

/**
 * MCP Store (inbound): registry of external MCP servers + import from the
 * Cursor/Claude/Codex stores + the lazy bridge that exposes them to every
 * engine through the runtime-tools lane. Secrets share the settings AES key.
 * (The outbound Nuncio-as-MCP-server product lives in `src/mcp-stdio/`.)
 */
@Module({
  imports: [DatabaseModule, GitModule, AgentToolsModule, ProjectsModule],
  providers: [
    McpServersRepository,
    McpOAuthRepository,
    McpOAuthService,
    McpService,
    McpImportService,
    McpBridgeToolSource,
    {
      provide: MCP_SETTINGS_KEY,
      inject: [DatabaseService],
      useFactory: (db: DatabaseService) => loadSettingsKey(db.dataDir),
    },
    { provide: MCP_CLIENT_FACTORY, useClass: SdkMcpClientFactory },
  ],
  controllers: [McpServersController, McpOAuthController],
  exports: [McpService, McpOAuthService],
})
export class McpModule {}
