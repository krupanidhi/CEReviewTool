/**
 * Production entry point for Azure App Service (CJS wrapper).
 * .cjs extension forces CommonJS even with "type": "module" in package.json.
 * iisnode uses require() to load this file.
 */
import('./server/server.js').catch(err => {
  console.error('FATAL: Failed to load server module:', err)
  process.exit(1)
})
