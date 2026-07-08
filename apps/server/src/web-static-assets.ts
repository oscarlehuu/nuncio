import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

const API_PREFIX = '/api';

export function resolveWebDistPath(): string {
  // Packaged desktop builds ship the web bundle as an app resource, not next to
  // the compiled server binary, so let the shell point us at it explicitly.
  const override = process.env.NUNCIO_WEB_DIST;
  if (override) {
    return resolve(override);
  }
  return resolve(__dirname, '../../web/dist');
}

function isApiRequest(req: Request): boolean {
  return req.path === API_PREFIX || req.path.startsWith(`${API_PREFIX}/`);
}

export function configureWebAppServing(
  app: NestExpressApplication,
  distPath = resolveWebDistPath(),
): boolean {
  const rootPath = resolve(distPath);
  const indexPath = join(rootPath, 'index.html');

  if (!existsSync(rootPath) || !existsSync(indexPath)) {
    return false;
  }

  const staticAssets = express.static(rootPath, { fallthrough: true, index: false });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiRequest(req)) {
      return next();
    }
    return staticAssets(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiRequest(req) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return next();
    }
    // Pass root so the dotfile check applies to 'index.html' only — an absolute
    // path would be rejected whenever the dist dir sits under a dot segment
    // (git worktrees in .claude/, ~/.local/share on Linux).
    return res.sendFile('index.html', { root: rootPath });
  });

  return true;
}
