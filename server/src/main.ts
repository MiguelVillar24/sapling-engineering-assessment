import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { appConfig } from './config.js';
import { createCore } from './core/create-core.js';
import { AppModule } from './http/app.module.js';

async function bootstrap(): Promise<void> {
  const core = createCore({ dbPath: appConfig.dbPath, dataDir: appConfig.dataDir, scenarioNow: appConfig.scenarioNow });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(core), { logger: ['error', 'warn'] });
  app.enableShutdownHooks();

  // Serve the built React app (npm run build) from the same port, with an SPA fallback.
  const index = join(appConfig.webDist, 'index.html');
  if (existsSync(index)) {
    app.useStaticAssets(appConfig.webDist, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) return res.sendFile(index);
      next();
    });
  }

  const shutdown = () => core.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen(appConfig.port);
  const url = `http://localhost:${appConfig.port}`;
  console.log(`\nSapling patient messaging demo running at ${url}`);
  console.log(`  database:  ${appConfig.dbPath}`);
  console.log(`  data:      ${appConfig.dataDir}`);
  console.log(`  agent:     ${core.agent.mode} (local demo mode; no API keys or network needed)`);
  console.log(`  clock:     ${core.clock.now().toFormat("cccc, LLL d, yyyy h:mm a ZZZZ")} (${core.clock.state().mode})`);
  if (!existsSync(index)) console.log(`  web UI:    not built yet. Run "npm run build" (or "npm run dev" for hot reload).`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
