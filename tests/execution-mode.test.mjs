import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateExecutionSettings, executionInstructions, PRIVATE_PROTOCOL } from '../turn-instructions.js';
import { composeGamePrompt } from '../game-profiles.js';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';

for(const tier of ['low','mid','high','ultra','custom']) {
    for(const enabled of [true,false]) {
        test(`legacy effective execution mode preserved: ${tier} / ${enabled}`,()=>{
            const settings={simulationFidelity:tier,privateReview:enabled,customPrompt:'Keep my text'};
            assert.equal(migrateExecutionSettings(settings),true);
            assert.equal(settings.privateReview,enabled&&['high','ultra','custom'].includes(tier));
            const preserved=settings.privateReview;
            settings.simulationFidelity='ultra';migrateExecutionSettings(settings);
            assert.equal(settings.privateReview,preserved,'tier changes no longer switch execution mode');
            settings.privateReview=!preserved;migrateExecutionSettings(settings);
            assert.equal(settings.privateReview,!preserved,'explicit checkbox choice survives reload');
            assert.equal(settings.customPrompt,'Keep my text');
        });
    }
}

test('known compact quality sources are mode-neutral while execution has a separate contract',()=>{
    const presets={mid:{prompt:SYSTEM_BUNDLES.mid.legacy},ultra:{prompt:SYSTEM_BUNDLES.ultra.legacy}};
    for(const original of [SYSTEM_BUNDLES.compact.legacy,...SYSTEM_BUNDLES.compact.priorBases]) {
        const result=composeGamePrompt({simulationFidelity:'ultra',customPrompt:original},presets);
        assert.equal(result.variant,'compact');
        assert.doesNotMatch(result.base,/VERSION PACKET|base_revision|private turn|private review JSON/i);
        assert.match(result.base,/### 2\. THE CONTACT-DISTANCE MODEL/);
        assert.match(result.base,/### 18\. ITEM CARDS/);
    }
    assert.match(executionInstructions({privateReview:false}),/EXECUTION MODE — STANDARD/);
    assert.doesNotMatch(executionInstructions({privateReview:false}),/VERSION PACKET/);
    assert.match(executionInstructions({privateReview:true}),/VERSION PACKET/);
    assert.match(PRIVATE_PROTOCOL,/wait for its receipt/);
});
