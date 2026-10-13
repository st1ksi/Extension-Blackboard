// Transport/state-machine fixture only: these synthetic findings do not test LLM judgement.
import { parseBlocks } from '../state.js';
export const payload = messages => {
    const content = messages.at(-1).content;
    return JSON.parse((typeof content === 'string' ? content : content[0].text).split('\n').slice(1).join('\n'));
};
export function citations(p, refs = []) {
    if (!refs.length) return [{ source: 'candidate', quote: p.candidate }];
    return refs.map(ref => {
        const text = ref.source === 'current' ? p.current_board : p.versions.find(v => v.revision === (ref.source === 'baseline' ? 0 : Number(ref.source.split(':')[1])))?.text;
        const body = parseBlocks(text ?? '').blocks.find(b => b.blockKey === ref.block_id.toLowerCase())?.content;
        if (!body) throw new Error(`Fixture missing ${ref.source} ${ref.block_id}`);
        return { ...ref, quote: body.trim().split('\n').find(l => l.trim() && !l.startsWith('```')) };
    });
}
export function report(p, verdict = 'pass', problem = 'Location differs from the recorded action.') {
    return { stage: p.audit.stage, revision: p.head_revision, candidate_id: p.candidate_id, verdict,
        checks: p.audit.targets.map(t => ({ target: t.id, finding: 'Fixture comparison for ' + t.id,
            evidence: citations(p, t.required_evidence) })),
        issues: verdict === 'pass' ? [] : [{ target: p.audit.targets[0].id, problem, repair: 'Reconcile the location with the established action.' }],
        issue_resolutions: (p.issue_ledger ?? []).map(issue => ({ id: issue.id,
            status: verdict !== 'pass' ? 'open' : issue.observed_revision === p.head_revision && issue.observed_candidate === p.candidate_id ? 'rejected' : 'resolved',
            reason: verdict === 'pass' ? 'Fixture comparison with current state/candidate.' : 'Fixture discrepancy persists.',
            evidence: citations(p, issue.block_id && parseBlocks(p.current_board).blocks.some(b => b.blockKey === issue.block_id) ? [{source:'current',block_id:issue.block_id}] : []),
        })) };
}
export const pass = p => ({ text: JSON.stringify(report(p)) });
export const repair = p => ({ text: JSON.stringify(report(p, 'repair')) });
