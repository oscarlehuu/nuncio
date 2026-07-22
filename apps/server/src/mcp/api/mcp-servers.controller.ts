import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { McpImportService } from '../import/mcp-import.service';
import { redirectOriginFromRequest } from '../oauth/mcp-oauth-redirect-origin';
import { McpOAuthService } from '../oauth/mcp-oauth.service';
import { maskTransportSecrets, McpService } from '../mcp.service';
import type { CreateMcpServerInput, UpdateMcpServerInput } from '../domain/mcp.types';
import type { McpImportPreview, McpImportSourceId } from '../import/mcp-import.types';

const IMPORT_SOURCES: readonly McpImportSourceId[] = ['cursor', 'claude', 'codex'];

/**
 * REST boundary of the MCP Store. Secret env/header values are masked by the
 * service before they leave any GET/PUT response; sending a masked value back
 * on update means "keep the stored secret".
 */
@Controller('mcp-servers')
export class McpServersController {
  constructor(
    private readonly mcp: McpService,
    private readonly importer: McpImportService,
    private readonly oauth: McpOAuthService,
  ) {}

  @Get()
  list() {
    return this.mcp.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const dto = this.mcp.get(id);
    if (!dto) throw new NotFoundException(`unknown MCP server: ${id}`);
    return dto;
  }

  @Post()
  create(@Body() body: CreateMcpServerInput) {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name (string) is required');
    }
    if (!body.transport || typeof body.transport !== 'object') {
      throw new BadRequestException('transport (object) is required');
    }
    return this.mcp.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: UpdateMcpServerInput) {
    const dto = this.mcp.update(id, body ?? {});
    if (!dto) throw new NotFoundException(`unknown MCP server: ${id}`);
    return dto;
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    if (!this.mcp.delete(id)) throw new NotFoundException(`unknown MCP server: ${id}`);
    return { deleted: true };
  }

  @Post(':id/oauth/start')
  async startOAuth(
    @Param('id') id: string,
    @Req() req: { protocol?: string; headers: Record<string, string | string[] | undefined> },
  ) {
    return this.oauth.start(id, redirectOriginFromRequest(req));
  }

  @Post('import')
  async import(@Body() body: { source: McpImportSourceId; dryRun?: boolean }) {
    if (!body || !IMPORT_SOURCES.includes(body.source)) {
      throw new BadRequestException(`source must be one of: ${IMPORT_SOURCES.join(', ')}`);
    }
    if (!body.dryRun) return this.importer.apply(body.source);
    return maskPreview(await this.importer.preview(body.source));
  }
}

/** Candidate transports come straight from the source configs — never leak their raw secrets. */
function maskPreview(preview: McpImportPreview): McpImportPreview {
  return {
    ...preview,
    entries: preview.entries.map((entry) => ({
      ...entry,
      candidate: {
        ...entry.candidate,
        transport: maskTransportSecrets(
          entry.candidate.transport,
          entry.candidate.secretKeys,
          entry.candidate.secretArgIndexes,
          entry.candidate.secretUrlQueryKeys,
        ),
      },
    })),
  };
}
