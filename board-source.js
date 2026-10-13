/** Source ranges for inspector edits. Offsets always refer to the original text. */
export function getBoardContentRanges(text) {
    const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
        .filter(match => match[0].length)
        .map(match => ({ start: match.index, end: match.index + match[0].length,
            text: match[0].replace(/[\r\n]+$/, '') }));
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    // Match parseBlocks' one enclosing Markdown fence rule, including its nested-fence exclusion.
    const outer = normalized.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*)\n```$/i);
    let first = 0, last = lines.length, contentStart = 0, contentEnd = text.length;
    if (outer && !/^\s*```/m.test(outer[1])) {
        while (first < last && !lines[first].text.trim()) first++;
        while (last > first && !lines[last - 1].text.trim()) last--;
        contentStart = lines[first].end;
        contentEnd = lines[last - 1].start;
        first++; last--;
    }
    const newline = text.match(/\r\n|\r|\n/)?.[0] || '\n';
    const range = (start, end) => {
        const raw = text.slice(start, end);
        if (!raw.trim()) {
            // Inserting into an empty block may need separators before a following header/fence.
            return { start, end: start,
                prefix: start > 0 && !/[\r\n]/.test(text[start - 1]) ? newline : '',
                suffix: start < text.length && !/[\r\n]/.test(text[start]) ? newline + newline : '' };
        }
        return { start: start + raw.length - raw.trimStart().length,
            end: end - (raw.length - raw.trimEnd().length), prefix: '', suffix: '' };
    };
    const blocks = [];
    let fence = null;
    for (const line of lines.slice(first, last)) {
        const marker = line.text.match(/^\s*(`{3,}|~{3,})/)?.[1];
        const header = !fence && line.text.match(/^\s*\[([A-Za-z0-9_-]+)\s+#\s*([^\]]+)\]\s*$/);
        if (header) blocks.push({ headerStart: line.start, bodyStart: line.end });
        if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line.text)) fence = null;
        }
    }
    return { preamble: range(contentStart, blocks[0]?.headerStart ?? contentEnd),
        blocks: blocks.map((block, index) => ({ headerStart: block.headerStart,
            ...range(block.bodyStart, blocks[index + 1]?.headerStart ?? contentEnd) })) };
}
