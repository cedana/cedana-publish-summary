const fs = require('fs');
const os = require('os');
const path = require('path');
const { DefaultArtifactClient } = require('@actions/artifact');

// cedana-test-summary uploads its outputs as a `test-summary-<slug>` artifact
// of the workflow run; find them all, in the order they were produced.
const ARTIFACT_PREFIX = 'test-summary-';
const ARTIFACT_FILE = 'test-summary.json';

// A re-run attempt uploads another artifact under the same name, so keep the
// newest one per name. Not `listArtifacts({ latest: true })`: that keeps the
// highest id, and artifact ids are not ordered by creation time.
function latestByName(artifacts) {
    const latest = new Map();
    for (const artifact of artifacts) {
        const seen = latest.get(artifact.name);
        if (!seen || artifact.createdAt > seen.createdAt) {
            latest.set(artifact.name, artifact);
        }
    }
    return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function findTestSummaries() {
    const client = new DefaultArtifactClient();
    const { artifacts } = await client.listArtifacts();
    const summaries = [];
    for (const artifact of latestByName(artifacts.filter((a) => a.name.startsWith(ARTIFACT_PREFIX)))) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ARTIFACT_PREFIX));
        await client.downloadArtifact(artifact.id, { path: dir });
        summaries.push(JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_FILE), 'utf8')));
    }
    return summaries;
}

// The image of each summary, captioned with the same one-line summary the
// test summary itself shows (markdown bold -> mrkdwn bold).
function testMatrixBlocks(summaries) {
    return summaries
        .filter((summary) => summary.imageUrl)
        .flatMap((summary) => {
            const blocks = [{ type: 'image', image_url: summary.imageUrl, alt_text: `Test matrix: ${summary.title}` }];
            if (summary.summary) {
                blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary.summary.replace(/\*\*/g, '*') } });
            }
            return blocks;
        });
}

module.exports = { findTestSummaries, testMatrixBlocks };
