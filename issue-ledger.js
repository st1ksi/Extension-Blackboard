// Private observations survive invalid report formatting and model omissions.
// Status describes the review workflow, not machine-proven semantic truth.
import { normalizeLightAffected } from './private-modes.js';
const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim();
export const pendingIssues = (ledger, stage) => ledger.filter(i => (!stage || i.stage === stage) && !['resolved', 'rejected'].includes(i.status));

export function captureIssues(ledger, report, audit, logIndex) {
    if (!report || report.stage !== audit.stage || report.revision !== audit.revision || report.candidate_id !== audit.candidate_id || !Array.isArray(report.issues)) return [];
    const observed = [];
    for (const item of report.issues) {
        const target = audit.targets.find(t => t.id === item?.target);
        if (!target || !norm(item.problem) || !norm(item.repair)) continue;
        let affected;
        if (audit.stage === 'light' && item.affected !== undefined) {
            try { affected = normalizeLightAffected(item.affected, audit.known_blocks); }
            catch { /* Preserve the observation; invalid references cannot become authoritative. */ }
        }
        // A provided ID cannot relabel an earlier allegation or target.
        let issue = item.id ? ledger.find(i => i.id === item.id && i.stage === audit.stage && i.target === item.target && norm(i.problem) === norm(item.problem))
            : ledger.find(i => i.stage === audit.stage && i.target === item.target && norm(i.problem) === norm(item.problem));
        if (item.id && !issue) continue;
        if (!issue) {
            issue = { id: `issue-${ledger.length + 1}`, stage: audit.stage, target: item.target, block_id: target.block_id ?? null,
                problem: item.problem, repair: item.repair, observed_revision: audit.revision, observed_candidate: audit.candidate_id,
                status: 'unconfirmed', history: [] };
            ledger.push(issue);
        }
        if (affected && !issue.affected?.length) issue.affected = affected;
        if (['resolved', 'rejected'].includes(issue.status)) issue.status = 'unconfirmed';
        issue.history.push({ event: 'observed', log_index: logIndex, revision: audit.revision, candidate_id: audit.candidate_id,
            evidence: structuredClone((Array.isArray(report.checks) ? report.checks.find(c => c?.target === item.target)?.evidence : null) ?? []) });
        observed.push(issue.id);
    }
    return observed;
}

export function acceptIssueReport(ledger, report, audit, logIndex, observedIds) {
    // Called only after the complete report and all required resolutions validate.
    for (const id of observedIds) {
        const issue = ledger.find(i => i.id === id);
        issue.status = 'open';
        issue.history.push({ event: 'confirmed', log_index: logIndex, revision: audit.revision, candidate_id: audit.candidate_id });
    }
    for (const resolution of report.issue_resolutions ?? []) {
        const issue = ledger.find(i => i.id === resolution.id);
        issue.status = resolution.status;
        issue.verified_revision = audit.revision;
        issue.verified_candidate = audit.candidate_id;
        issue.history.push({ event: resolution.status, log_index: logIndex, revision: audit.revision, candidate_id: audit.candidate_id,
            reason: resolution.reason, evidence: structuredClone(resolution.evidence) });
    }
}

export function reopenIssueVerdicts(ledger, revision, candidateId, stages = null) {
    for (const issue of ledger) {
        if (stages && !stages.includes(issue.stage)) continue;
        if (!['resolved', 'rejected'].includes(issue.status)) continue;
        issue.status = 'unconfirmed';
        issue.history.push({ event: 'recheck_after_revision', revision, candidate_id: candidateId });
    }
}

// Stage queues are derived from one authoritative ledger, never independently
// editable copies. Keep IDs and status visible in checkpoints and private exports.
export function stageFindings(ledger, stages) {
    return Object.fromEntries(stages.map(stage => [stage, ledger.filter(i => i.stage === stage)
        .map(i => ({ id: i.id, status: i.status, target: i.target, ...(i.affected ? { affected: i.affected } : {}), problem: i.problem, repair: i.repair }))]));
}
