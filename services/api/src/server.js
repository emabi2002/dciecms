'use strict';
const http = require('node:http');
const { createRuntimeService } = require('./runtime-service');
const { createHttpApp } = require('./http-app');
const { createAuthenticationResolver } = require('./auth-runtime');

async function startServer() {
  const service = createRuntimeService();
  const actorResolver = await createAuthenticationResolver(process.env);
  const server = http.createServer(createHttpApp(service, actorResolver));
  const port = Number(process.env.PORT || 3000);

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  console.log(`DCIECMS API listening on http://127.0.0.1:${port}`);
  console.log(`Persistence: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory development mode'}`);
  console.log(`Authentication mode: ${process.env.DCIECMS_AUTH_MODE}`);
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('DCIECMS API failed to start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
