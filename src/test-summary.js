const fs = require('fs');
const os = require('os');
const path = require('path');
const { DefaultArtifactClient } = require('@actions/artifact');

// cedana-test-summary uploads its outputs as a `test-summary-<slug>` artifact
// of the workflow run; find them all, in the order they were produced.
const ARTIFACT_PREFIX = 'test-summary-';
const ARTIFACT_FILE = 'test-summary.json';

async function findTestSummaries() {
    const client = new DefaultArtifactClient();
    const { artifacts } = await client.listArtifacts({ latest: true });
    const summaries = [];
    for (const artifact of artifacts.filter((a) => a.name.startsWith(ARTIFACT_PREFIX)).sort((a, b) => a.id - b.id)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ARTIFACT_PREFIX));
        await client.downloadArtifact(artifact.id, { path: dir });
        summaries.push(JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_FILE), 'utf8')));
    }
    return summaries;
}

function testMatrixBlocks(summaries) {
    return summaries
        .filter((summary) => summary.imageUrl)
        .map((summary) => ({
            type: 'image',
            image_url: summary.imageUrl,
            alt_text: `Test matrix: ${summary.title}`,
        }));
}

module.exports = { findTestSummaries, testMatrixBlocks };
