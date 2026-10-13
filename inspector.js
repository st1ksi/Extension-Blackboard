import { createBoardDrafts } from './board-drafts.js';
import { getBoardContentRanges } from './board-source.js';

export function installBoardInspector({ html, read, write, parse, tidy, summarize, countTokens, openSettings,
    document = globalThis.document, environment = globalThis }) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const panel = template.content.firstElementChild;
    document.body.append(panel);
    const find = key => panel.querySelector(`[data-board-${key}]`);
    const editor = find('editor'), status = find('status'), chips = find('chips'), cards = find('cards');
    const drafts = createBoardDrafts();
    let opener, scope, statsVersion = 0, statsTimer, blocks = [], lastCountText, lastCount, renderedText;
    let activeBlock = -1;
    let blockEdit, renderedRanges;
    const format = n => Number(n).toLocaleString('en-US');

    function setView(view) {
        editor.hidden = view !== 'source';
        cards.hidden = view !== 'blocks';
        for (const button of panel.querySelectorAll('[data-board-view]')) {
            button.setAttribute('aria-pressed', String(button.dataset.boardView === view));
        }
    }
    function markActiveBlock() {
        for (const chip of chips.querySelectorAll('[data-block-index]')) {
            if (Number(chip.dataset.blockIndex) === activeBlock) chip.setAttribute('aria-current', 'true');
            else chip.removeAttribute('aria-current');
        }
        for (const card of cards.querySelectorAll('[data-block-index]')) {
            card.classList.toggle('bb-board-card-active', Number(card.dataset.blockIndex) === activeBlock);
        }
    }
    function goToBlock(index) {
        setView('blocks');
        const card = cards.querySelector(`[data-block-index="${index}"]`);
        if (!card) return;
        activeBlock = index;
        markActiveBlock();
        card.focus({ preventScroll: true });
        const top = cards.scrollTop + card.getBoundingClientRect().top - cards.getBoundingClientRect().top - 4;
        const reducedMotion = environment.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        cards.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? 'instant' : 'smooth' });
    }
    function renderNavigation() {
        const filter = find('filter').value.trim().toLowerCase();
        const fragment = document.createDocumentFragment();
        blocks.forEach((block, index) => {
            if (!`${block.category} #${block.tagId}`.toLowerCase().includes(filter)) return;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'bb-board-chip';
            chip.dataset.category = block.category;
            chip.dataset.blockIndex = index;
            chip.title = `Jump to [${block.category} #${block.tagId}]`;
            chip.setAttribute('aria-label', chip.title);
            const category = document.createElement('span');
            category.className = 'bb-board-chip-category';
            category.textContent = block.category;
            const tag = document.createElement('span');
            tag.className = 'bb-board-chip-tag';
            tag.textContent = `#${block.tagId}`;
            chip.append(category, tag);
            chip.addEventListener('click', () => goToBlock(index));
            fragment.append(chip);
        });
        if (!fragment.childNodes.length) {
            const empty = document.createElement('span');
            empty.className = 'bb-board-empty-links';
            empty.textContent = blocks.length ? 'No matching blocks' : 'Block links appear here as the board grows.';
            fragment.append(empty);
        }
        chips.replaceChildren(fragment);
        markActiveBlock();
    }
    function renderCards(parsed, text) {
        // Presentation only: never serialize the parsed view back into the editor.
        // This preserves preambles, whitespace and fenced data in the single draft.
        if (renderedText === text || blockEdit?.source === text) return;
        renderedText = text;
        renderedRanges = getBoardContentRanges(text);
        activeBlock = -1;
        const scroll = cards.scrollTop;
        const fragment = document.createDocumentFragment();
        const addCard = (category, tag, content, index) => {
            const card = document.createElement('article');
            card.className = 'bb-board-card';
            card.dataset.category = category;
            card.tabIndex = -1;
            const heading = document.createElement('h3');
            heading.className = 'bb-board-card-heading';
            if (index !== undefined) {
                card.dataset.blockIndex = index;
                heading.id = `bb-board-heading-${index}`;
                card.setAttribute('aria-labelledby', heading.id);
                const label = document.createElement('span');
                label.className = 'bb-board-card-category';
                label.textContent = category;
                const name = document.createElement('span');
                name.textContent = `#${tag}`;
                heading.append(label, name);
            } else heading.textContent = 'Unsectioned text';
            const body = document.createElement('div');
            body.className = 'bb-board-card-content';
            body.textContent = content || 'This block is empty.';
            const header = document.createElement('div');
            header.className = 'bb-board-card-header';
            const actions = document.createElement('div');
            actions.className = 'bb-board-card-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'bb-board-card-edit';
            editButton.dataset.boardEditBlock = index === undefined ? 'preamble' : index;
            editButton.title = index === undefined ? 'Edit unsectioned text' : `Edit [${category} #${tag}]`;
            editButton.setAttribute('aria-label', editButton.title);
            editButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/></svg>';
            editButton.addEventListener('click', () => beginBlockEdit(index));
            actions.append(editButton);
            header.append(heading, actions);
            card.append(header, body);
            fragment.append(card);
        };
        if (parsed.preamble) addCard('UNSECTIONED', '', parsed.preamble);
        parsed.blocks.forEach((block, index) => addCard(block.category, block.tagId, block.content, index));
        if (!fragment.childNodes.length) {
            const empty = document.createElement('p');
            empty.className = 'bb-board-empty';
            empty.textContent = 'The board is empty. The model will initialize it during play. Use Full text or Editing tools to add your own blocks.';
            fragment.append(empty);
        }
        cards.replaceChildren(fragment);
        cards.scrollTop = scroll;
        markActiveBlock();
    }
    function finishBlockEdit({ cancel = false, focus = false } = {}) {
        if (!blockEdit) return;
        const current = blockEdit;
        blockEdit = undefined;
        if (cancel && scope === current.scope && editor.value === current.source) {
            editor.value = editor.value.slice(0, current.start) + current.initial + editor.value.slice(current.end);
            edit();
        }
        current.field.remove();
        current.done.remove(); current.cancel.remove();
        current.body.hidden = false; current.button.hidden = false;
        current.card.classList.remove('bb-board-card-editing');
        void updateStats();
        if (focus) panel.querySelector(`[data-board-edit-block="${current.index ?? 'preamble'}"]`)?.focus({ preventScroll: true });
    }
    function beginBlockEdit(index) {
        // A second pencil may belong to a card after the active edit. Track its
        // source position before finishing/rebuilding, even if new headers were typed.
        let headerStart = index === undefined ? undefined : renderedRanges.blocks[index]?.headerStart;
        if (headerStart !== undefined && blockEdit && headerStart >= blockEdit.originalEnd) {
            headerStart += blockEdit.end - blockEdit.originalEnd;
        }
        finishBlockEdit();
        const originalScope = scope, originalText = editor.value;
        refresh();
        if (scope !== originalScope || editor.value !== originalText) return;
        const ranges = getBoardContentRanges(editor.value);
        if (headerStart !== undefined) {
            index = ranges.blocks.findIndex(range => range.headerStart === headerStart);
            if (index < 0) return;
        }
        const range = index === undefined ? ranges.preamble : ranges.blocks[index];
        const button = panel.querySelector(`[data-board-edit-block="${index ?? 'preamble'}"]`);
        if (!range || !button) return;
        const card = button.closest('.bb-board-card');
        const body = card.querySelector('.bb-board-card-content');
        const field = document.createElement('textarea');
        field.className = 'bb-board-block-editor'; field.spellcheck = false;
        field.setAttribute('aria-label', index === undefined ? 'Edit unsectioned text' : `Content of [${blocks[index].category} #${blocks[index].tagId}]`);
        field.value = editor.value.slice(range.start, range.end);
        const done = document.createElement('button');
        done.type = 'button'; done.className = 'bb-board-card-done';
        done.textContent = 'Done'; done.title = 'Finish editing this block; Save changes commits the draft';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'bb-board-card-cancel';
        cancel.textContent = 'Cancel'; cancel.title = 'Undo edits made since opening this block';
        const current = blockEdit = { ...range, originalEnd: range.end, scope, index, source: editor.value,
            initial: field.value, card, body, button, field, done, cancel };
        done.addEventListener('click', () => finishBlockEdit({ focus: true }));
        cancel.addEventListener('click', () => finishBlockEdit({ cancel: true, focus: true }));
        field.addEventListener('input', () => {
            if (blockEdit !== current) return;
            if (read().scope !== current.scope || editor.value !== current.source) { refresh(); return; }
            const replacement = field.value ? current.prefix + field.value + current.suffix : '';
            editor.value = editor.value.slice(0, current.start) + replacement + editor.value.slice(current.end);
            current.end = current.start + replacement.length;
            current.source = editor.value;
            edit();
        });
        button.hidden = true; body.hidden = true;
        button.parentElement.append(done, cancel);
        card.append(field); card.classList.add('bb-board-card-editing');
        field.focus({ preventScroll: true });
        field.style.height = `${Math.min(360, Math.max(120, field.scrollHeight + 2))}px`;
    }
    async function updateStats() {
        const version = ++statsVersion;
        const text = editor.value;
        const state = read();
        const parsed = parse(text);
        if (!blockEdit) blocks = parsed.blocks;
        find('blocks').textContent = format(parsed.blocks.length);
        find('chars').textContent = format(text.length);
        find('corridor').textContent = `${format(state.minTokens)}–${format(state.maxTokens)}`;
        renderCards(parsed, text);
        if (!blockEdit) renderNavigation();
        const summary = summarize(text);
        find('progression').textContent = summary.progression;
        find('stale').textContent = summary.stale;
        let tokens = lastCountText === text ? lastCount : Math.ceil(text.length / 4);
        const showTokens = () => {
            find('tokens').textContent = format(tokens);
            find('budget').dataset.range = tokens < state.minTokens ? 'under' : tokens > state.maxTokens ? 'over' : 'within';
            find('budget').title = tokens < state.minTokens ? 'Below the target board budget' : tokens > state.maxTokens ? 'Above the target board budget' : 'Within the target board budget';
        };
        showTokens();
        if (lastCountText !== text) {
            try { tokens = await countTokens(text); } catch { tokens = Math.ceil(text.length / 4); }
            if (version !== statsVersion || editor.value !== text) return;
            lastCountText = text; lastCount = tokens;
            showTokens();
        }
    }
    function renderStatus(message) {
        const record = drafts.current;
        const dirty = record.text !== record.base;
        find('conflict').hidden = !record.conflict;
        find('save').disabled = record.conflict || !dirty;
        status.textContent = message || (record.conflict ? 'Saved board changed · draft retained' : dirty ? 'Unsaved changes · draft kept in this tab' : 'Up to date');
        status.dataset.dirty = String(dirty);
    }
    function refresh() {
        const state = read();
        const switched = scope !== state.scope;
        scope = state.scope;
        const record = drafts.sync(scope, state.text);
        if (switched || editor.value !== record.text) {
            // Inline input already lives in the shared draft. Dispose only its UI
            // when switching chats or loading/replacing the source.
            if (blockEdit) {
                const current = blockEdit;
                blockEdit = undefined;
                current.field.remove(); current.done.remove(); current.cancel.remove();
                current.body.hidden = false; current.button.hidden = false;
                current.card.classList.remove('bb-board-card-editing');
            }
            editor.value = record.text;
        }
        if (switched) { editor.scrollTop = 0; cards.scrollTop = 0; chips.scrollTop = 0; activeBlock = -1; find('filter').value = ''; }
        find('context').textContent = state.label;
        renderStatus();
        if (!panel.hidden) void updateStats();
    }
    function edit() {
        drafts.edit(editor.value);
        renderStatus();
        clearTimeout(statsTimer);
        statsTimer = setTimeout(() => void updateStats(), 180);
    }
    function open({ focus = true, opener: source } = {}) {
        if (source) opener = source;
        refresh();
        panel.hidden = false;
        panel.dispatchEvent(new CustomEvent('bb-panel-open', { bubbles: true }));
        void updateStats();
        if (focus) find('close').focus({ preventScroll: true });
    }
    function close({ restoreFocus = true } = {}) {
        finishBlockEdit();
        panel.hidden = true;
        panel.dispatchEvent(new CustomEvent('bb-panel-close', { bubbles: true }));
        if (restoreFocus && opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    }
    find('close').addEventListener('click', () => close());
    find('settings').addEventListener('click', event => openSettings(event.currentTarget));
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (blockEdit) finishBlockEdit({ cancel: true, focus: true });
            else close();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    });
    editor.addEventListener('input', edit);
    find('filter').addEventListener('input', renderNavigation);
    for (const button of panel.querySelectorAll('[data-board-view]')) button.addEventListener('click', () => {
        finishBlockEdit();
        setView(button.dataset.boardView);
        void updateStats(); // Include edits made just before switching, without waiting for the debounce.
    });
    for (const button of panel.querySelectorAll('[data-board-insert]')) button.addEventListener('click', () => {
        finishBlockEdit();
        setView('source');
        const start = editor.selectionStart, end = editor.selectionEnd;
        const prefix = start > 0 && editor.value[start - 1] !== '\n' ? '\n\n' : '';
        const snippet = `${prefix}[${button.dataset.boardInsert} #tag]\n- \n\n`;
        editor.setRangeText(snippet, start, end, 'end');
        const tag = start + snippet.indexOf('#tag') + 1;
        editor.focus(); editor.setSelectionRange(tag, tag + 3);
        edit();
    });
    find('tidy').addEventListener('click', () => { finishBlockEdit(); editor.value = tidy(editor.value); edit(); void updateStats(); });
    find('clear').addEventListener('click', () => {
        if (environment.confirm('Clear this editor draft? The saved board changes only after Save.')) { finishBlockEdit(); editor.value = ''; edit(); void updateStats(); }
    });
    find('copy').addEventListener('click', async () => {
        const text = editor.value;
        try { await environment.navigator.clipboard.writeText(text); status.textContent = 'Copied to clipboard'; }
        catch {
            // LAN HTTP may not expose Clipboard API. Selection also enables manual copying.
            finishBlockEdit();
            setView('source');
            editor.focus(); editor.select();
            try { if (!document.execCommand('copy')) throw new Error(); status.textContent = 'Copied to clipboard'; }
            catch { status.textContent = 'Text selected. Use your device’s Copy command.'; }
        }
    });
    find('reload').addEventListener('click', () => {
        if (drafts.current.text !== drafts.current.base && !environment.confirm('Discard the unsaved draft and load the latest saved board?')) return;
        const state = read();
        drafts.sync(state.scope, state.text);
        drafts.accept(state.text);
        refresh();
    });
    function save() {
        finishBlockEdit();
        const edited = drafts.current;
        refresh(); // Recheck chat and board immediately before committing.
        if (edited !== drafts.current || drafts.current.conflict) return;
        if (drafts.current.text === drafts.current.base) return;
        try {
            const saved = write(editor.value);
            drafts.accept(saved);
            refresh();
            renderStatus('Saved & synced');
        } catch (error) { status.textContent = 'Not saved: ' + error.message; }
    }
    find('save').addEventListener('click', save);
    return { panel, open, close, refresh };
}
