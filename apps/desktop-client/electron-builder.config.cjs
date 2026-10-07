const { execFileSync } = require('node:child_process');

// Keep the existing product/target configuration. Without a Developer ID,
// produce a complete ad-hoc signature rather than retaining Electron's stamp.
const config = { extends: './electron-builder.yml', afterSign: './scripts/macos-signature.cjs' };
if (process.platform === 'darwin') {
  let identities = '';
  if (!process.env.CSC_LINK && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
    try { identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); } catch {}
  }
  if (!process.env.CSC_LINK && !process.env.CSC_NAME && !/Developer ID Application:/.test(identities)) {
    config.mac = { identity: '-', hardenedRuntime: false, gatekeeperAssess: false };
  }
}
module.exports = config;
