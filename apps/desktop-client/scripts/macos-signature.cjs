const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const APP_ID = 'com.asklins.astella';
const REQUIREMENT = `designated => identifier "${APP_ID}"`;
function run(args) {
  return execFileSync('/usr/bin/codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function details(args) {
  // codesign writes its display output to stderr even on success.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot inspect macOS signature');
  return `${result.stdout}${result.stderr}`;
}
function verify(app) {
  run(['--verify', '--deep', '--strict', app]);
  const signature = details(['--display', '--verbose=4', app]);
  if (!signature.includes(`Identifier=${APP_ID}\n`)) throw new Error('Unexpected signing identifier');
  if (/Authority=Developer ID Application:/.test(signature)) return 'Developer ID';
  if (!/Signature=adhoc/.test(signature)) throw new Error('Unsupported signing identity');
  const requirement = details(['--display', '--requirements', '-', app]);
  const designated = requirement.split(/\r?\n/).find(line => /^(# )?designated => /.test(line));
  if (designated?.replace(/^# /, '') !== REQUIREMENT) throw new Error('Ad-hoc update requirement depends on this build');
  run(['--verify', '--deep', '--strict', '-R', `=identifier "${APP_ID}"`, app]);
  return 'stable ad-hoc';
}
function finish(app) {
  const signature = details(['--display', '--verbose=4', app]);
  if (/Signature=adhoc/.test(signature)) {
    // Nested frameworks/helpers were signed by electron-builder. Only the main
    // bundle needs a version-independent requirement for ShipIt updates.
    run(['--force', '--sign', '-', '--identifier', APP_ID, '--requirements', `=${REQUIREMENT}`, app]);
  }
  console.log(`macOS signature verified: ${verify(app)}`);
}
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  finish(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};
module.exports.finish = finish;
module.exports.verify = verify;
if (require.main === module) {
  const app = process.argv[2];
  if (!app) throw new Error('Usage: node scripts/macos-signature.cjs <app>');
  console.log(`macOS signature verified: ${verify(app)}`);
}
