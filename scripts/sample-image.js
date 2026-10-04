#!/usr/bin/env node
// Builds docs/slack.png: runs the action in dry-run mode against a real
// release of cedana/cedana (with fake binaries for the size comparison) and
// renders the resulting Slack payload with scripts/slack-mock.js.
//   GITHUB_TOKEN=$(gh auth token) node scripts/sample-image.js [tag]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderSlackMock } = require('./slack-mock');

const token = process.env.GITHUB_TOKEN;
if (!token) {
    console.error('GITHUB_TOKEN is required to read release notes');
    process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-summary-'));
const binaries = { cedana: 61_874_000, 'libcedana-gpu.so': 12_401_000, 'libcedana-streamer.so': 4_210_000 };
for (const [dir, delta] of [
    ['current', 0],
    ['previous', -318_000],
]) {
    fs.mkdirSync(path.join(tmp, dir));
    for (const [name, size] of Object.entries(binaries)) {
        fs.writeFileSync(path.join(tmp, dir, name), Buffer.alloc(0));
        fs.truncateSync(path.join(tmp, dir, name), size + delta);
    }
}

const outputFile = path.join(tmp, 'output');
fs.writeFileSync(outputFile, '');
execFileSync('node', [path.join(__dirname, '..', 'dist', 'index.js')], {
    stdio: 'inherit',
    env: {
        ...process.env,
        GITHUB_REPOSITORY: 'cedana/cedana',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: path.join(tmp, 'summary'),
        INPUT_TITLE: 'cedana',
        INPUT_TAG: process.argv[2] || '',
        'INPUT_SLACK-WEBHOOK-URL': 'unused',
        'INPUT_GITHUB-TOKEN': token,
        'INPUT_BINARIES-DIR': path.join(tmp, 'current'),
        'INPUT_PREVIOUS-BINARIES-DIR': path.join(tmp, 'previous'),
        'INPUT_STEP-SUMMARY': 'false',
        'INPUT_DRY-RUN': 'true',
    },
});

// GITHUB_OUTPUT multi-line format: name<<delimiter ... delimiter
const output = fs.readFileSync(outputFile, 'utf8');
const match = output.match(/^payload<<(\S+)\n([\s\S]*?)\n\1$/m);
if (!match) throw new Error('payload output not found');
const payload = JSON.parse(match[2]);

renderSlackMock(payload).then((png) => {
    const target = path.join(__dirname, '..', 'docs', 'slack.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);
    console.log(`Wrote ${target} (${png.length} bytes)`);
});
