const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const slackifyMarkdown = require('slackify-markdown');
const { findTestSummaries, testMatrixBlocks } = require('./test-summary');

const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 3000;
const MAX_HEADER_TEXT = 150;
const MAX_CONTEXT_TEXT = 255;
const MAX_BODY_SECTIONS = 10;

const API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPOSITORY = process.env.GITHUB_REPOSITORY;

function slackify(markdown) {
    return slackifyMarkdown(markdown).trim();
}

function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max - 2).trimEnd() + ' …';
}

// Split mrkdwn into chunks that each fit in a section block, preferring
// newline boundaries so formatting is not broken mid-line.
function chunk(text, size) {
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (current && current.length + line.length + 1 > size) {
            chunks.push(current);
            current = '';
        }
        if (line.length > size) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            chunks.push(truncate(line, size));
            continue;
        }
        current = current ? `${current}\n${line}` : line;
    }
    if (current) chunks.push(current);
    return chunks;
}

async function githubRequest(token, endpoint) {
    const response = await fetch(`${API_URL}${endpoint}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) {
        throw new Error(`GET ${endpoint} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

// Resolve the release to summarize and the one preceding it, excluding drafts.
async function resolveReleases(token, tag, previousTag) {
    const releases = (await githubRequest(token, `/repos/${REPOSITORY}/releases?per_page=100`)).filter(
        (r) => !r.draft
    );

    let current = null;
    let index = -1;
    if (tag) {
        index = releases.findIndex((r) => r.tag_name === tag);
        if (index >= 0) {
            current = releases[index];
        } else {
            core.warning(`No release found for tag ${tag}; release notes will be empty`);
        }
    } else if (releases.length > 0) {
        current = releases[0];
        index = 0;
        tag = current.tag_name;
    } else {
        core.warning('No releases found; release notes will be empty');
    }

    if (!previousTag && index >= 0 && index + 1 < releases.length) {
        previousTag = releases[index + 1].tag_name;
    }

    return { current, tag, previousTag };
}

function binaryContextBlocks(dir, previousDir) {
    const blocks = [];
    if (!dir || !fs.existsSync(dir)) {
        return blocks;
    }
    const binaries = fs
        .readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .sort();
    for (const binary of binaries) {
        const size = fs.statSync(path.join(dir, binary)).size / 1024 / 1024;
        const elements = [
            {
                type: 'mrkdwn',
                text: truncate(`${binary} *${size.toFixed(2)} MiB*`, MAX_CONTEXT_TEXT),
            },
        ];
        const previousPath = previousDir ? path.join(previousDir, binary) : null;
        if (previousPath && fs.existsSync(previousPath)) {
            const previousSize = fs.statSync(previousPath).size / 1024 / 1024;
            elements.push({
                type: 'mrkdwn',
                text: `_Previously ${previousSize.toFixed(2)} MiB_`,
            });
        } else {
            elements.push({ type: 'mrkdwn', text: '_Previously unavailable_' });
        }
        blocks.push({ type: 'context', elements });
    }
    return blocks;
}

async function run() {
    const title = core.getInput('title') || REPOSITORY.split('/')[1];
    const inputTag = core.getInput('tag');
    const inputPreviousTag = core.getInput('previous-tag');
    const description = core.getInput('description');
    const releaseNotesUrl = core.getInput('release-notes-url');
    const binariesDir = core.getInput('binaries-dir');
    const previousBinariesDir = core.getInput('previous-binaries-dir');
    const versions = core.getInput('versions').split(/\s+/).filter(Boolean);
    const versionsLabel = core.getInput('versions-label');
    const webhookUrl = core.getInput('slack-webhook-url', { required: true });
    const token = core.getInput('github-token', { required: true });
    const stepSummary = core.getBooleanInput('step-summary');
    const testSummary = core.getBooleanInput('test-summary');
    const dryRun = core.getBooleanInput('dry-run');

    const { current, tag, previousTag } = await resolveReleases(token, inputTag, inputPreviousTag);

    let testSummaries = [];
    if (testSummary) {
        try {
            testSummaries = await findTestSummaries();
            core.info(`Found ${testSummaries.length} test summary artifact(s) in this run`);
        } catch (error) {
            core.warning(`Could not look up test summaries of this run: ${error.message}`);
        }
    }
    const body = current?.body || '';
    const notesUrl =
        releaseNotesUrl ||
        current?.html_url ||
        (tag ? `${SERVER_URL}/${REPOSITORY}/releases/tag/${tag}` : `${SERVER_URL}/${REPOSITORY}/releases`);

    const blocks = [];

    blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: truncate(title, MAX_HEADER_TEXT), emoji: true },
    });
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: truncate(description ? slackify(description) : `*${tag || '...'}*`, MAX_SECTION_TEXT),
        },
        accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Release notes', emoji: true },
            url: notesUrl,
            action_id: 'button-action',
        },
    });
    blocks.push({ type: 'divider' });

    if (body) {
        const chunks = chunk(slackify(body), MAX_SECTION_TEXT);
        for (const text of chunks.slice(0, MAX_BODY_SECTIONS)) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
        }
        if (chunks.length > MAX_BODY_SECTIONS) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `_Truncated — full notes on <${notesUrl}|GitHub>_` }],
            });
        }
        blocks.push({ type: 'divider' });
    }

    const matrixBlocks = testMatrixBlocks(testSummaries);
    if (matrixBlocks.length > 0) {
        blocks.push(...matrixBlocks);
        blocks.push({ type: 'divider' });
    }

    if (previousTag) {
        blocks.push({
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `Version *${tag}*` },
                { type: 'mrkdwn', text: `_Previously ${previousTag}_` },
            ],
        });
    }

    if (binariesDir) {
        if (versions.length > 0) {
            for (const version of versions) {
                const label = versionsLabel ? `${versionsLabel} ${version}` : version;
                blocks.push({
                    type: 'section',
                    text: { type: 'mrkdwn', text: `*${label}*` },
                });
                const versionBlocks = binaryContextBlocks(
                    path.join(binariesDir, version),
                    previousBinariesDir ? path.join(previousBinariesDir, version) : null
                );
                if (versionBlocks.length === 0) {
                    blocks.push({
                        type: 'context',
                        elements: [{ type: 'mrkdwn', text: '_Binaries unavailable_' }],
                    });
                } else {
                    blocks.push(...versionBlocks);
                }
            }
        } else {
            blocks.push(...binaryContextBlocks(binariesDir, previousBinariesDir));
        }
    }

    const payload = { blocks: blocks.slice(0, MAX_BLOCKS) };
    if (blocks.length > MAX_BLOCKS) {
        core.warning(`Payload had ${blocks.length} blocks; truncated to ${MAX_BLOCKS}`);
    }

    core.setOutput('payload', JSON.stringify(payload));
    core.setOutput('tag', tag || '');
    core.setOutput('previous-tag', previousTag || '');

    if (stepSummary && body) {
        await core.summary.addRaw(body, true).write();
    }

    if (dryRun) {
        core.info('Dry run; payload not posted to Slack:');
        core.info(JSON.stringify(payload, null, 2));
        return;
    }

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}: ${responseText}`);
    }
    core.info(`Posted release summary for ${tag || '(unknown tag)'} to Slack`);
}

run().catch((error) => core.setFailed(error.message));
