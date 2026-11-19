import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The repository's own tests (`npm run test:repo`, also run by the root `npm test` and by CI): checks that read more
// than one workspace, such as the workflows and their scripts, the release configuration, the app's catalogue against
// the server's, and that the server's tests stay inside its workspace. Each workspace keeps its own tests in its folder.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    // The workflow tests run the workflows' shell steps, git and a local server, a few seconds each on a busy runner.
    testTimeout: 30_000,
  },
});
