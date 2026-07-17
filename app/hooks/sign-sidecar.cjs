'use strict';

// electron-builder 26 refuses hook module paths that resolve outside the
// workspace root (app/), so ../scripts/sign-sidecar.cjs cannot be referenced
// directly from electron.builder.yml. This shim lives inside the workspace
// and re-exports the real afterPack hook from repo-root scripts/.
module.exports = require('../../scripts/sign-sidecar.cjs');
