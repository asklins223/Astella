import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as yaml from 'js-yaml';

test('desktop publishing requires verification of both actual platform signatures', () => {
  const packaging = yaml.load(readFileSync('.github/workflows/desktop-package.yml', 'utf8'));
  const release = yaml.load(readFileSync('.github/workflows/desktop-release.yml', 'utf8'));
  assert.match(release.jobs.release.if, /github\.event_name == 'push'.*from_tag == 'true'/);
  const resolution = release.jobs.resolve.steps.find(step => step.id === 'resolve');
  assert.match(resolution.run, /REQUESTED_DESKTOP_VERSION/);
  assert.doesNotMatch(resolution.run, /\$\{\{\s*(inputs|github\.ref)/);
  for (const platform of ['windows', 'macos']) {
    const job = packaging.jobs[platform];
    assert.doesNotMatch(job.steps.find(step => step.id === 'version').run, /\$\{\{\s*inputs/);
    assert.match(job.outputs.signed, /steps\.verify_signature\.outputs\.signed/);
    const step = job.steps.find((item) => item.id === 'verify_signature');
    assert.ok(step, `${platform} must verify its built artifacts`);
    assert.match(step.run, /signed=true/);
    assert.match(step.run, /signed=false/);
  }
  const steps = release.jobs.release.steps;
  const gate = steps.findIndex((step) => step.name === 'Require verified publisher signatures');
  const publish = steps.findIndex((step) => step.uses?.startsWith('softprops/action-gh-release@'));
  assert.ok(gate >= 0 && publish > gate, 'publisher gate must precede release upload');
  assert.match(steps[gate].env.WINDOWS_SIGNED, /needs\.build\.outputs\.windows_signed/);
  assert.match(steps[gate].env.MACOS_SIGNED, /needs\.build\.outputs\.macos_signed/);
  assert.match(packaging.jobs.macos.outputs.notarized, /steps\.verify_signature\.outputs\.notarized/);
  assert.match(packaging.on.workflow_call.outputs.macos_notarized.value, /jobs\.macos\.outputs\.notarized/);
  const macVerification = packaging.jobs.macos.steps.find((item) => item.id === 'verify_signature');
  assert.match(macVerification.run, /xcrun stapler validate "\$app"/);
  assert.match(steps[gate].env.MACOS_NOTARIZED, /needs\.build\.outputs\.macos_notarized/);
  assert.match(steps[gate].run, /\$WINDOWS_SIGNED.*= true/);
  assert.match(steps[gate].run, /\$MACOS_SIGNED.*= true/);
  assert.match(steps[gate].run, /\$MACOS_NOTARIZED.*= true/);
});

test('public release checks signing credential presence before starting platform jobs', () => {
  const release = yaml.load(readFileSync('.github/workflows/desktop-release.yml', 'utf8'));
  const preflight = release.jobs.resolve.steps.find(step => step.name === 'Check release signing credentials');
  assert.match(preflight.if, /github\.event_name == 'push'.*from_tag == 'true'/);
  assert.equal(release.jobs.build.needs, 'resolve');
  const secrets = ['WIN_CSC_LINK', 'MAC_CSC_LINK', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD'];
  const configured = Object.fromEntries(secrets.map(name => {
    assert.equal(preflight.env[name], '${{ secrets.' + name + ' }}');
    return [name, 'sample-value'];
  }));
  const run = env => spawnSync('bash', ['-e', '-c', preflight.run], { encoding: 'utf8', env: { ...process.env, ...env } });
  const denied = run({ ...configured, WIN_CSC_LINK: '', APPLE_APP_SPECIFIC_PASSWORD: '' });
  assert.equal(denied.status, 1, denied.stderr);
  assert.match(denied.stderr, /WIN_CSC_LINK APPLE_APP_SPECIFIC_PASSWORD/);
  assert.doesNotMatch(denied.stderr + denied.stdout, /sample-value/);
  const accepted = run(configured);
  assert.equal(accepted.status, 0, accepted.stderr);
});
