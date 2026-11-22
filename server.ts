import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApiApp } from './src/server/app.ts';
import { ensurePlatformReady } from './src/server/services/bootstrap.ts';

const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = createApiApp();

  // Warm migrations and env admin seed on startup
  await ensurePlatformReady();

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] HooshNegar AI Admin Platform running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
