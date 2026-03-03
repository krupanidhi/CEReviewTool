/**
 * Production entry point for Azure App Service.
 * Root package.json has NO "type": "module", so this file is CommonJS.
 * server/package.json has "type": "module", so server/server.js is ESM.
 * Dynamic import() bridges CJS → ESM.
 */
import('./server/server.js').catch(function(err) {
  console.error('FATAL: Failed to load server module:', err);
  process.exit(1);
});
