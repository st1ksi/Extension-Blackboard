// Connection names and IDs are display data, never HTML or executable commands.
export function simulationConnectionOptions(context, selected = '') {
    const manager = context?.extensionSettings?.connectionManager;
    const available = !context?.extensionSettings?.disabledExtensions?.includes('connection-manager');
    const profiles = available && Array.isArray(manager?.profiles) ? manager.profiles : [];
    const options = [{ value: '', text: 'Current connection', disabled: false }];
    const seen = new Set(['']);
    for (const profile of profiles) {
        if (typeof profile?.id !== 'string' || !profile.id || seen.has(profile.id)) continue;
        seen.add(profile.id);
        const supported = profile.mode !== 'tc';
        options.push({ value: profile.id,
            text: `${typeof profile.name === 'string' && profile.name ? profile.name : 'Unnamed profile'}${supported ? '' : ' — Text Completion unavailable'}`,
            disabled: !supported });
    }
    if (selected && !seen.has(selected)) options.push({ value: selected, text: 'Saved profile unavailable — choose another connection', disabled: true });
    return options;
}

// Rebuild only when labels/availability change. Preserve the selected ID even
// when a profile is missing; opening settings must never silently change routing.
export function replaceConnectionOptions(select, options, selected = '') {
    if (!select) return;
    const previous = [...select.options].map(option => ({ value: option.value, text: option.textContent,
        disabled: option.disabled, hidden: option.hidden }));
    const desired = options.map(option => ({ ...option, hidden: !!option.hidden, disabled: !!option.disabled }));
    if (JSON.stringify(previous) !== JSON.stringify(desired)) {
        select.replaceChildren(...desired.map(item => {
            const option = select.ownerDocument.createElement('option');
            option.value = item.value; option.textContent = item.text;
            option.disabled = item.disabled; option.hidden = item.hidden;
            return option;
        }));
    }
    select.value = selected;
}
