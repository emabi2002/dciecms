'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.resolve(__dirname, '../../services/api/src/server.js');

function runServer(env, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        DATABASE_URL: '',
        PORT: '0',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

test('production cannot start with development authentication mode', async () => {
  const result = await runServer({
    NODE_ENV: 'production',
    DCIECMS_AUTH_MODE: 'development'
  });

  assert.equal(result.timedOut, false, 'server must reject invalid auth configuration before waiting for traffic');
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes('listening'), false);
  assert.equal(result.stderr.includes('failed to start'), true);
});
