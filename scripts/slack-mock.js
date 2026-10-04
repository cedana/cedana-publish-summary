// Renders a Slack Block Kit payload as a PNG that approximates how Slack
// shows the message, for documentation. Supports the blocks this action
// emits: header, section (with a button accessory), divider, context, image.
const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');
const opentype = require('opentype.js');

const WIDTH = 720;
const SCALE = 2;
const PAD = 16;
const AVATAR = 36;
const GUTTER = 8;
const LEFT = PAD + AVATAR + GUTTER;
const RIGHT = WIDTH - PAD;
const BUTTON_WIDTH = 120;

const FONT = 'Inter';
const TEXT = { size: 15, line: 22, color: '#1d1c1d' };
const HEADER = { size: 16, line: 24, color: '#1d1c1d' };
const CONTEXT = { size: 12, line: 18, color: '#616061' };
const LINK = '#1264a3';
const CODE = '#e01e5a';
const MUTED = '#616061';
const BORDER = '#dddddd';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fontFiles = { regular: 'Inter-Regular.ttf', bold: 'Inter-Bold.ttf' };
const fontBuffers = Object.fromEntries(
    Object.entries(fontFiles).map(([k, f]) => [k, fs.readFileSync(path.join(__dirname, '..', 'assets', f))])
);
const metrics = Object.fromEntries(
    Object.entries(fontBuffers).map(([k, b]) => [k, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))])
);

// Advance width of a string, summed per glyph from the font that renders it
// (no shaping: opentype.js cannot process Inter's substitution tables).
function measure(text, size, bold) {
    const font = metrics[bold ? 'bold' : 'regular'];
    let units = 0;
    for (const ch of text) units += font.charToGlyph(ch).advanceWidth || 0;
    return (units * size) / font.unitsPerEm;
}

// Slack mrkdwn -> runs of { text, bold, italic, code, link }.
function parseMrkdwn(text) {
    const runs = [];
    const re = /(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`\n]+`)|<([^|>]+)\|([^>]+)>|<([^|>]+)>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last) runs.push({ text: text.slice(last, m.index) });
        if (m[1]) runs.push({ text: m[1].slice(1, -1), bold: true });
        else if (m[2]) runs.push({ text: m[2].slice(1, -1), italic: true });
        else if (m[3]) runs.push({ text: m[3].slice(1, -1), code: true });
        else if (m[5]) runs.push({ text: m[5], link: true });
        else runs.push({ text: m[6], link: true });
        last = m.index + m[0].length;
    }
    if (last < text.length) runs.push({ text: text.slice(last) });
    return runs.map((r) => ({ ...r, text: r.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') }));
}

// Lay out mrkdwn into lines of positioned words within `width`.
function layoutText(text, style, width) {
    const lines = [];
    for (const paragraph of text.split('\n')) {
        let line = [];
        let x = 0;
        for (const run of parseMrkdwn(paragraph)) {
            const words = run.text.split(/(\s+)/).filter((w) => w.length);
            for (const word of words) {
                const w = measure(word, style.size, run.bold);
                if (/^\s+$/.test(word)) {
                    if (line.length) x += w;
                    continue;
                }
                if (x + w > width && line.length) {
                    lines.push(line);
                    line = [];
                    x = 0;
                }
                line.push({ ...run, text: word, x });
                x += w;
            }
        }
        lines.push(line);
    }
    return lines;
}

function renderLines(lines, x0, y0, style) {
    const out = [];
    lines.forEach((line, i) => {
        const y = y0 + i * style.line + style.size;
        for (const word of line) {
            const fill = word.link ? LINK : word.code ? CODE : style.color;
            const weight = word.bold ? ' font-weight="700"' : '';
            const family = word.code ? 'monospace' : FONT;
            const size = word.code ? style.size - 2 : style.size;
            out.push(
                `<text x="${(x0 + word.x).toFixed(1)}" y="${y}" font-family="${family}" font-size="${size}"${weight} fill="${fill}">${esc(word.text)}</text>`
            );
        }
    });
    return out.join('');
}

function renderBlocks(blocks) {
    const parts = [];
    let y = PAD;

    // App header line.
    parts.push(`<rect x="${PAD}" y="${y}" width="${AVATAR}" height="${AVATAR}" rx="6" fill="#1264a3"/>`);
    parts.push(`<text x="${PAD + AVATAR / 2}" y="${y + 24}" font-family="${FONT}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">C</text>`);
    parts.push(`<text x="${LEFT}" y="${y + 14}" font-family="${FONT}" font-size="15" font-weight="700" fill="${TEXT.color}">Cedana</text>`);
    const appX = LEFT + measure('Cedana', 15, true) + 6;
    parts.push(`<rect x="${appX.toFixed(1)}" y="${y + 3}" width="30" height="14" rx="3" fill="#e8e8e8"/>`);
    parts.push(`<text x="${(appX + 15).toFixed(1)}" y="${y + 13.5}" font-family="${FONT}" font-size="9" font-weight="700" fill="${MUTED}" text-anchor="middle">APP</text>`);
    parts.push(`<text x="${(appX + 38).toFixed(1)}" y="${y + 14}" font-family="${FONT}" font-size="12" fill="${MUTED}">9:41 AM</text>`);
    y += 22;

    const width = RIGHT - LEFT;
    for (const block of blocks) {
        if (block.type === 'header') {
            const lines = layoutText(block.text.text, HEADER, width);
            parts.push(renderLines(lines.map((l) => l.map((w) => ({ ...w, bold: true }))), LEFT, y, HEADER));
            y += lines.length * HEADER.line + 6;
        } else if (block.type === 'section') {
            const textWidth = block.accessory ? width - BUTTON_WIDTH - 16 : width;
            const lines = layoutText(block.text.text, TEXT, textWidth);
            parts.push(renderLines(lines, LEFT, y, TEXT));
            let h = lines.length * TEXT.line;
            if (block.accessory?.type === 'button') {
                const bx = RIGHT - BUTTON_WIDTH;
                parts.push(`<rect x="${bx}" y="${y}" width="${BUTTON_WIDTH}" height="30" rx="4" fill="#ffffff" stroke="#bbbbbb"/>`);
                parts.push(
                    `<text x="${bx + BUTTON_WIDTH / 2}" y="${y + 19}" font-family="${FONT}" font-size="13" font-weight="700" fill="${TEXT.color}" text-anchor="middle">${esc(block.accessory.text.text)}</text>`
                );
                h = Math.max(h, 30);
            }
            y += h + 8;
        } else if (block.type === 'divider') {
            y += 4;
            parts.push(`<line x1="${LEFT}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="${BORDER}"/>`);
            y += 12;
        } else if (block.type === 'context') {
            const text = block.elements.map((e) => e.text).join('   ');
            const lines = layoutText(text, CONTEXT, width);
            parts.push(renderLines(lines, LEFT, y, CONTEXT));
            y += lines.length * CONTEXT.line + 4;
        } else if (block.type === 'image') {
            parts.push(`<rect x="${LEFT}" y="${y}" width="${width}" height="80" rx="6" fill="#f4f4f4" stroke="${BORDER}"/>`);
            parts.push(`<text x="${LEFT + 12}" y="${y + 45}" font-family="${FONT}" font-size="13" fill="${MUTED}">${esc(block.alt_text || 'image')}</text>`);
            y += 88;
        }
    }

    const height = y + PAD - 4;
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">` +
        `<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>` +
        parts.join('') +
        '</svg>'
    );
}

let ready = null;
async function renderSlackMock(payload) {
    if (!ready) {
        ready = initWasm(fs.readFileSync(path.join(__dirname, '..', 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm')));
    }
    await ready;
    const resvg = new Resvg(renderBlocks(payload.blocks), {
        fitTo: { mode: 'zoom', value: SCALE },
        font: { fontBuffers: Object.values(fontBuffers), defaultFontFamily: FONT },
    });
    return Buffer.from(resvg.render().asPng());
}

module.exports = { renderSlackMock, renderBlocks };
