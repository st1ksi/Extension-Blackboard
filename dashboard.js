/** A second view of the native settings. All writes reuse their existing handlers. */
export function installSettingsDashboard({ html, presets, document = globalThis.document, $ = globalThis.$ }) {
    const launcher = document.getElementById('blackboard_open_dashboard');
    if (!launcher || document.getElementById('blackboard-dashboard')) return;
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const panel = template.content.firstElementChild;
    document.body.append(panel);
    const nativeRoot = launcher.closest('.blackboard_settings');
    const source = id => document.getElementById(id);
    const controls = [...panel.querySelectorAll('[data-bb-control]')];
    const tabs = [...panel.querySelectorAll('[data-bb-tab]')];
    const tierGroup = panel.querySelector('[data-bb-tiers]');
    const tiers = [];
    let returnFocus = launcher;
    const format = value => Number(value).toLocaleString('en-US');
    for (const [id, preset] of Object.entries(presets)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.bbTier = id;
        button.setAttribute('role', 'radio');
        button.title = preset.description || preset.name;
        const name = document.createElement('strong');
        const [label, subtitle] = preset.name.split(/\s*\(/);
        name.textContent = id === 'custom' ? preset.name : label;
        const tokens = document.createElement('span');
        tokens.textContent = id === 'custom' ? 'Set your own budget' : `${format(preset.minTokens)}–${format(preset.maxTokens)}`;
        button.append(name);
        if (id !== 'custom' && subtitle) {
            const detail = document.createElement('span');
            detail.textContent = subtitle.replace(/\)$/, '');
            button.append(detail);
        }
        button.append(tokens);
        tierGroup.append(button);
        tiers.push(button);
    }

    function refresh() {
        for (const control of controls) {
            const native = source(control.dataset.bbControl);
            if (!native) continue;
            if (control.type === 'checkbox') control.checked = native.checked;
            else if (control.value !== native.value) control.value = native.value;
            control.disabled = native.disabled;
            control.readOnly = native.readOnly;
        }
        for (const copy of panel.querySelectorAll('[data-bb-text]')) {
            copy.textContent = source(copy.dataset.bbText)?.textContent || '';
        }
        const selected = source('blackboard_fidelity_select').value;
        for (const button of tiers) {
            const active = button.dataset.bbTier === selected;
            button.setAttribute('aria-checked', String(active));
            button.tabIndex = active ? 0 : -1;
        }
        panel.querySelector('[data-bb-custom-budget]').hidden = selected !== 'custom';
        const enabled = source('blackboard_function_tool').checked;
        const privateTurns = source('blackboard_private_review').checked;
        const injection = source('blackboard_auto_inject_prompt').checked;
        const mode = panel.querySelector('[data-bb-mode]');
        mode.textContent = !enabled ? 'Simulation off · preferences retained'
            : !injection ? 'Auto-injection off · instructions are not added'
            : privateTurns ? 'Simulation on · Private Turns selected' : 'Simulation on · standard generation';
        mode.dataset.active = String(enabled && injection);
        const warning = panel.querySelector('[data-bb-private-warning]');
        const unsupported = enabled && privateTurns && source('blackboard_private_format').disabled;
        warning.hidden = !privateTurns || (enabled && injection && !unsupported);
        warning.textContent = !enabled ? 'Inactive while Simulation Blackboard is off.'
            : !injection ? 'Requires auto-injection. Enable it in Advanced settings.'
            : 'Unavailable in this browser. See Private Turn options below.';
    }

    function close({ restoreFocus = true } = {}) {
        panel.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
        panel.dispatchEvent(new CustomEvent('bb-panel-close', { bubbles: true }));
        if (restoreFocus && returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    }
    function open({ focus = true, opener = launcher } = {}) {
        returnFocus = opener;
        refresh();
        panel.hidden = false;
        launcher.setAttribute('aria-expanded', 'true');
        panel.dispatchEvent(new CustomEvent('bb-panel-open', { bubbles: true }));
        if (focus) panel.querySelector('[data-bb-close]').focus({ preventScroll: true });
    }
    function selectTab(tab) {
        for (const button of tabs) {
            const active = button === tab;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
            source(button.getAttribute('aria-controls')).hidden = !active;
        }
        panel.querySelector('.bb-dash-scroll').scrollTop = 0;
    }
    function selectTier(button) {
        const native = source('blackboard_fidelity_select');
        // Clicking the selected card must not reset an existing custom prompt.
        if (native.value !== button.dataset.bbTier) {
            $(native).val(button.dataset.bbTier).trigger('change');
        }
        refresh();
    }
    launcher.addEventListener('click', () => {
        if (!panel.hidden) { close(); return; }
        open();
    });
    panel.querySelector('[data-bb-close]').addEventListener('click', () => close());
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    for (const [index, tab] of tabs.entries()) {
        tab.addEventListener('click', () => selectTab(tab));
        tab.addEventListener('keydown', event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); selectTab(tabs[next]); tabs[next].focus();
        });
    }
    for (const [index, button] of tiers.entries()) {
        button.addEventListener('click', () => selectTier(button));
        button.addEventListener('keydown', event => {
            const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % tiers.length
                : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + tiers.length - 1) % tiers.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tiers.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); selectTier(tiers[next]); tiers[next].focus();
        });
    }
    for (const control of controls) {
        // Numbers commit on change, allowing a budget to be typed before native clamping.
        const eventName = control.tagName === 'TEXTAREA' && !control.readOnly ? 'input' : 'change';
        control.addEventListener(eventName, () => {
            const native = source(control.dataset.bbControl);
            if (!native || native.disabled || native.readOnly) return;
            if (control.type === 'number' && (!control.value || !control.checkValidity())) {
                control.reportValidity();
                control.value = native.value;
                return;
            }
            if (control.type === 'checkbox') $(native).prop('checked', control.checked);
            else $(native).val(control.value);
            $(native).trigger(eventName);
            refresh(); // Reflect clamping or a rejected change immediately.
        });
    }
    for (const button of panel.querySelectorAll('[data-bb-action]')) {
        button.addEventListener('click', () => {
            const action = button.dataset.bbAction;
            $(source(action)).trigger('click');
            refresh();
            if (action.includes('_save_') || action.includes('_reset_')) {
                panel.querySelector('[data-bb-feedback]').textContent = action.includes('_save_') ? 'Instructions saved.' : 'Default instructions restored.';
            }
        });
    }
    // Listen after native handlers, including programmatic changes from the setup gate.
    // Textarea drafts are mirrored too; saving stays an explicit action in both views.
    $(nativeRoot).on('input.blackboardDashboard change.blackboardDashboard click.blackboardDashboard', refresh);
    return { refresh, open, close, panel };
}
