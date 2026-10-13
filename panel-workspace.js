/** Prefer desktop behavior when device identity is ambiguous (including masked UAs). */
export function isClearlyMobile(environment = globalThis) {
    const nav = environment.navigator || {};
    const platform = nav.userAgentData?.platform || nav.platform || '';
    const ua = nav.userAgent || '';
    if (/Windows|Win32|Win64|CrOS|Chrome OS/i.test(platform + ' ' + ua)) return false;
    return /Android|iPhone|iPad|iPod|iOS/i.test(platform + ' ' + ua);
}

export function supportsPairedPanels(environment = globalThis) {
    return !isClearlyMobile(environment) && environment.innerWidth >= 1120;
}

/** One shared workspace; each panel owns its own draft and close behavior. */
export function createPanelWorkspace({ dashboard, inspector, environment = globalThis }) {
    if (!dashboard || !inspector) return;
    const document = environment.document;
    const dock = document.createElement('div');
    dock.className = 'bb-panel-workspace';
    dock.append(inspector.panel, dashboard.panel);
    document.body.append(dock);
    let active = inspector;

    function layout() {
        const paired = supportsPairedPanels(environment);
        if (!paired && !inspector.panel.hidden && !dashboard.panel.hidden) {
            (active === inspector ? dashboard : inspector).close({ restoreFocus: false });
        }
        dock.dataset.paired = String(!inspector.panel.hidden && !dashboard.panel.hidden);
        dock.hidden = inspector.panel.hidden && dashboard.panel.hidden;
    }
    dock.addEventListener('bb-panel-open', event => {
        active = event.target === inspector.panel ? inspector : dashboard;
        layout();
    });
    dock.addEventListener('bb-panel-close', layout);
    dock.addEventListener('focusin', event => {
        active = inspector.panel.contains(event.target) ? inspector : dashboard;
    });
    environment.addEventListener('resize', layout);
    layout();
    return {
        openBoard({ fromWand = false, opener } = {}) {
            if (fromWand && supportsPairedPanels(environment)) dashboard.open({ focus: false, opener });
            inspector.open({ opener });
        },
        openSettings({ opener } = {}) { dashboard.open({ opener }); },
    };
}
