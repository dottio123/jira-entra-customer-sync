import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import type { WebContext } from '../http/context';

const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MAX_LOGO_BYTES = 1024 * 1024;

/** Health probes, the optional branding logo, and the root redirect. */
export function registerSystemRoutes(
  app: FastifyInstance,
  ctx: WebContext,
  logoAvailable: boolean,
): void {
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      ctx.store.db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });

  const logoFile = ctx.config.logoFile;
  if (logoFile && logoAvailable) {
    app.get('/branding/logo', async (_request, reply) => {
      const type = LOGO_TYPES[path.extname(logoFile).toLowerCase()];
      if (!type) return reply.code(404).send();
      try {
        const stat = fs.statSync(logoFile);
        if (!stat.isFile() || stat.size > MAX_LOGO_BYTES) return reply.code(404).send();
        return reply
          .header('Cache-Control', 'private, max-age=3600')
          .type(type)
          .send(fs.createReadStream(logoFile));
      } catch {
        return reply.code(404).send();
      }
    });
  }

  app.get('/', async (_request, reply) => reply.redirect('/overview'));
}
