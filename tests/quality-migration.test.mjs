import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { GAME_PROFILE_PROMPTS } from '../prompts/game-profile-bundles.js';
import { QUALITY_SEPARATION_VERSION, migrateQualitySeparation, resolveQualityPrompt } from '../quality-source.js';
import { composeGamePrompt } from '../game-profiles.js';
import { createCampaignSettings } from '../campaign-settings.js';

const presets = {
    low:{prompt:SYSTEM_BUNDLES.low.base},mid:{prompt:SYSTEM_BUNDLES.mid.base},
    high:{prompt:SYSTEM_BUNDLES.high.base},ultra:{prompt:SYSTEM_BUNDLES.compact.base},custom:{prompt:null},
};

test('legacy preferences move former built-in directions into visible settings once, without changing custom sources', () => {
    for (const [variant,bundle] of Object.entries(SYSTEM_BUNDLES)) {
        for (const source of [bundle.legacy,...bundle.priorBases].filter(text => text !== bundle.base)) {
            const wasSeparated = bundle.separatedPriorIndices.some(index => bundle.priorBases[index] === source);
            const settings = {simulationFidelity:['compact','ultra'].includes(variant)?'ultra':variant,
                customPrompt:source,campaignTone:'inherit',narrativeStyle:'inherit'};
            assert.equal(migrateQualitySeparation(settings),true);
            assert.equal(settings.customPrompt,source);
            assert.equal(settings.campaignTone,wasSeparated?'inherit':bundle.qualityDefaults.campaignTone,variant);
            assert.equal(settings.narrativeStyle,wasSeparated?'inherit':bundle.qualityDefaults.narrativeStyle,variant);
            assert.equal(settings.qualitySeparationVersion,QUALITY_SEPARATION_VERSION);
            assert.equal(resolveQualityPrompt(settings,presets).base,bundle.base);
            settings.campaignTone='hopeful';settings.narrativeStyle='concise';settings.simulationFidelity='low';
            assert.equal(migrateQualitySeparation(settings),false);
            assert.equal(settings.campaignTone,'hopeful');assert.equal(settings.narrativeStyle,'concise');
        }
    }
});

test('previous preset followers preserve their effective tone/prose; explicitly selected layers win', () => {
    for (const tier of ['low','mid','high','ultra']) {
        const settings={simulationFidelity:tier,customPrompt:''};
        migrateQualitySeparation(settings);
        const previous=SYSTEM_BUNDLES[tier==='ultra'?'compact':tier].qualityDefaults;
        assert.equal(settings.campaignTone,previous.campaignTone);
        assert.equal(settings.narrativeStyle,previous.narrativeStyle);
        const explicit={simulationFidelity:tier,campaignTone:'hopeful',narrativeStyle:'concise',campaignStyle:'adventure'};
        migrateQualitySeparation(explicit);
        assert.equal(explicit.campaignTone,'hopeful');assert.equal(explicit.narrativeStyle,'concise');
        assert.equal(explicit.campaignStyle,'adventure');
    }
});

test('fresh marked settings and already separated quality sources acquire no inferred direction', () => {
    const fresh={simulationFidelity:'ultra',qualitySeparationVersion:1,campaignTone:'inherit',narrativeStyle:'inherit'};
    assert.equal(migrateQualitySeparation(fresh),false);
    assert.equal(fresh.campaignTone,'inherit');assert.equal(fresh.narrativeStyle,'inherit');
    const explicitSource={simulationFidelity:'ultra',customPrompt:SYSTEM_BUNDLES.compact.base};
    migrateQualitySeparation(explicitSource);
    assert.equal(explicitSource.campaignTone,undefined);assert.equal(explicitSource.narrativeStyle,undefined);
    assert.equal(composeGamePrompt(fresh,presets).campaignLayers.instructions,'');
});

test('arbitrary custom sources preserve their own directions verbatim and receive no guessed legacy layers', () => {
    const source=SYSTEM_BUNDLES.compact.priorBases.at(-1)+'\nMy own alteration to this campaign.';
    const settings={simulationFidelity:'ultra',customPrompt:source,campaignTone:'inherit',narrativeStyle:'inherit'};
    migrateQualitySeparation(settings);
    assert.equal(settings.campaignTone,'inherit');assert.equal(settings.narrativeStyle,'inherit');
    assert.equal(settings.customPrompt,source);
    for (const tone of ['inherit','balanced','grimdark','hopeful']) {
        const result=composeGamePrompt({...settings,campaignTone:tone,simulationFocus:'relationships_social'},presets);
        assert.equal(result.base,source);assert.equal(result.rawBase,source);
        assert.ok(result.text.startsWith(source.trim()+'\n\n---\n\n'));
        assert.equal(result.campaignLayers.metadata.customQualityPreserved,true);
    }
});

test('all built-in quality texts and game profiles remain identical across every optional-layer combination', () => {
    for (const [variant,bundle] of Object.entries(SYSTEM_BUNDLES)) {
        for (const gameSystem of ['universal','dnd5e']) {
            for (const simulationFocus of ['general','relationships_social']) {
                for (const campaignTone of ['inherit','balanced','grimdark','hopeful']) {
                    for (const campaignStyle of ['inherit','deductive','adventure','social_intrigue','exploration','survival','slice_of_life']) {
                        for (const narrativeStyle of ['inherit','concise','evocative']) {
                            const settings={customPrompt:bundle.base,simulationFidelity:variant==='compact'?'ultra':variant,
                                gameSystem,simulationFocus,campaignTone,campaignStyle,narrativeStyle};
                            const composed=composeGamePrompt(settings,presets);
                            assert.equal(composed.base,bundle.base,variant);
                            assert.equal(composed.rawBase,bundle.base,variant);
                            const expected = [GAME_PROFILE_PROMPTS.common, bundle[gameSystem],
                                gameSystem==='dnd5e'?'':GAME_PROFILE_PROMPTS.advancement].filter(Boolean).map(t=>t.trim()).join('\n\n')+'\n';
                            assert.equal(composed.profile,expected,variant);
                            assert.equal(composed.campaignLayers.snapshot.qualitySource.text,bundle.base);
                            assert.equal(composed.campaignLayers.snapshot.gameProfile.text,expected);
                        }
                    }
                }
            }
        }
    }
});

test('migration is isolated to the selected preference owner and does not retcon board or history', () => {
    const globals={simulationFidelity:'ultra',customPrompt:''};
    const local={simulationFidelity:'mid',customPrompt:'',campaignTone:'hopeful'};
    const ctx={chatId:'Saved campaign',chat:[{is_user:false,mes:'Existing scene.'}],extensionSettings:{blackboard:globals},
        chatMetadata:{variables:{world_blackboard:'[SCENE #room]\nA room.'},blackboard_settings:{version:1,enabled:true,values:local}}};
    const history=JSON.stringify(ctx.chat),board=ctx.chatMetadata.variables.world_blackboard;
    const store=createCampaignSettings({getContext:()=>ctx,defaults:{simulationFidelity:'mid',qualitySeparationVersion:1,campaignTone:'inherit',narrativeStyle:'inherit'},
        migrate:migrateQualitySeparation});
    assert.equal(store.get().campaignTone,'hopeful');assert.equal(store.get().narrativeStyle,'evocative');
    assert.equal(globals.qualitySeparationVersion,undefined,'Reading a local owner must not migrate unrelated defaults.');
    assert.equal(store.global().campaignTone,'grimdark');
    assert.equal(local.campaignTone,'hopeful');
    assert.equal(JSON.stringify(ctx.chat),history);assert.equal(ctx.chatMetadata.variables.world_blackboard,board);
});

test('newer settings formats are preserved and rejected rather than silently downgraded', () => {
    const settings={qualitySeparationVersion:99,customPrompt:'Preserve me.'},before=JSON.stringify(settings);
    assert.throws(()=>migrateQualitySeparation(settings),/newer quality instruction format/);
    assert.equal(JSON.stringify(settings),before);
});
