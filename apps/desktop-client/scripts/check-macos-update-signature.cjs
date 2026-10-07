// Real codesign regression: two different builds must satisfy the old app's
// designated requirement; changing a sealed resource must fail verification.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { finish, verify } = require('./macos-signature.cjs');
if (process.platform !== 'darwin') throw new Error('Run this regression on macOS');
const root = mkdtempSync(join(tmpdir(), 'astella-update-signature-'));
try {
  const apps = ['old', 'new'].map((name, index) => {
    const app = join(root, `${name}.app`);
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(app, 'Contents/Resources'));
    const source = join(root, `${name}.c`);
    writeFileSync(source, `int main(void) { return ${index}; }\n`);
    execFileSync('/usr/bin/clang', [source, '-o', join(app, 'Contents/MacOS/Astella')]);
    writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.asklins.astella</string><key>CFBundleExecutable</key><string>Astella</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${index + 1}</string></dict></plist>`);
    writeFileSync(join(app, 'Contents/Resources/version.txt'), name);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    finish(app);
    return app;
  });
  const display = execFileSync('/usr/bin/codesign', ['--display', '--requirements', '-', apps[0]], { encoding: 'utf8' });
  const requirement = display.split(/\r?\n/).find(line => line.startsWith('designated => ')).replace('designated => ', '=');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, apps[1]]);
  writeFileSync(join(apps[1], 'Contents/Resources/version.txt'), 'modified after signing');
  assert.throws(() => verify(apps[1]));
  console.log('Two-build signature compatibility and damaged-resource rejection passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
