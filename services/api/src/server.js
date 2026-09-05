'use strict';
const http = require('node:http');
const { createRuntimeService } = require('./runtime-service');
const { createHttpApp } = require('./http-app');
const { resolveActorFromClaims } = require('../../../packages/auth');

function developmentActorResolver(req) {
  const sub = req.headers['x-dev-sub'];
  if (!sub) return null;
  return resolveActorFromClaims({
    sub,
    roles: String(req.headers['x-dev-roles'] || '').split(',').map(v => v.trim()).filter(Boolean),
    court_ids: String(req.headers['x-dev-courts'] || '').split(',').map(v => v.trim()).filter(Boolean),
    explicit_grants: String(req.headers['x-dev-grants'] || '').split(',').map(v => v.trim()).filter(Boolean)
  });
}

const service = createRuntimeService();
const server = http.createServer(createHttpApp(service, developmentActorResolver));
const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`DCIECMS development API listening on http://127.0.0.1:${port}`);
  console.log(`Persistence: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory development mode'}`);
  console.log('WARNING: x-dev-* identity headers are development-only and MUST NOT be used in production.');
});
