import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../../../src/db/database.module';
import { ProjectsController } from '../../../src/projects/projects.controller';
import { ProjectsModule } from '../../../src/projects/projects.module';
import { ProjectsRepository } from '../../../src/projects/projects.repository';

describe('ProjectsController', () => {
  let module: TestingModule;
  let controller: ProjectsController;
  let repo: ProjectsRepository;
  let dataDir: string;
  let projectPath: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-projects-controller-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, ProjectsModule],
    }).compile();
    controller = module.get(ProjectsController);
    repo = module.get(ProjectsRepository);
    projectPath = '/tmp/nuncio-projects-controller/repo';
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('lists all project configs when path is omitted', () => {
    repo.upsert({ path: projectPath, name: 'demo' });
    const result = controller.get();
    expect(result.items.some((item) => item.path === projectPath)).toBe(true);
  });

  it('returns a single project when path is provided', () => {
    repo.upsert({ path: projectPath, name: 'demo' });
    expect(controller.get(projectPath)).toMatchObject({ path: projectPath, name: 'demo' });
  });

  it('rejects blank path queries', () => {
    expect(() => controller.get('   ')).toThrow(BadRequestException);
  });

  it('returns 404 when the project config does not exist', () => {
    expect(() => controller.get('/missing/project')).toThrow(NotFoundException);
  });

  it('upserts project config and rejects missing path', () => {
    expect(() => controller.upsert({ path: '  ' })).toThrow(BadRequestException);
    const saved = controller.upsert({ path: projectPath, name: 'renamed' });
    expect(saved).toMatchObject({ path: projectPath, name: 'renamed' });
  });

  it('deletes a project config by path', () => {
    repo.upsert({ path: projectPath });
    expect(controller.remove(projectPath)).toEqual({ ok: true });
    expect(() => controller.get(projectPath)).toThrow(NotFoundException);
  });

  it('rejects delete without a path', () => {
    expect(() => controller.remove('  ')).toThrow(BadRequestException);
  });
});
