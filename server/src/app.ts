import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { queueRouter } from './modules/queues/queue.routes.js';
import { organizationRouter } from './modules/organizations/organization.routes.js';
import { doctorRouter } from './modules/doctors/doctor.routes.js';
import { serviceRouter } from './modules/services/service.routes.js';
import { patientRouter } from './modules/patients/patient.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { issueRouter } from './modules/issues/issue.routes.js';

const openapi = parseYaml(readFileSync(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), 'utf8'));

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Swagger UI needs inline scripts, so it gets a relaxed CSP of its own.
  app.use('/api/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'QFree API' }));
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openapi);
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', authRouter);
  api.use('/queues', queueRouter);
  api.use('/organizations', organizationRouter);
  // Aliases so clinics and laboratories can be addressed directly (same table, filtered by type).
  api.use('/clinics', (req, _res, next) => ((req.url = withType(req.url, 'CLINIC')), next()), organizationRouter);
  api.use('/laboratories', (req, _res, next) => ((req.url = withType(req.url, 'LABORATORY')), next()), organizationRouter);
  api.use('/doctors', doctorRouter);
  api.use('/services', serviceRouter);
  api.use('/patients', patientRouter);
  api.use('/notifications', notificationRouter);
  api.use('/analytics', analyticsRouter);
  api.use('/issues', issueRouter);
  api.use('/admin', adminRouter);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Add ?type=… to list requests on the /clinics and /laboratories aliases. */
function withType(url: string, type: string) {
  if (!url.startsWith('/?') && url !== '/') return url;
  return url.includes('?') ? `${url}&type=${type}` : `${url}?type=${type}`;
}
