import test from 'node:test';
import assert from 'node:assert/strict';
import { companionFileBlockV1Schema, companionFileExtensionForMimeType } from '../contracts/companion/companion-file-contracts.ts';
import { createCompanionTurnRequestV1Schema } from '../contracts/companion/companion-conversation-contracts.ts';
import { companionAwarenessObservationV1Schema } from '../contracts/companion/companion-initiative-contracts.ts';
const id = '01234567-89ab-4cde-8fab-0123456789ab';
const file = {type:'file',url:`/api/uploads/${id}/companion-files/${id}/test.docx`,name:'试验.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteLength:300,text:'本机抽取的原文。'};
test('native DOCX uses the standard MIME sent by both platform document pickers',()=> {
 assert.equal(companionFileBlockV1Schema.safeParse(file).success,true);
 assert.equal(companionFileExtensionForMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),'docx');
 assert.equal(companionFileBlockV1Schema.safeParse({...file,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.docx'}).success,false);
});
test('an attachment-only mobile turn preserves intent and enforces one file',()=> {
 const turn={version:1,clientMessageId:id,inputKind:'text',sourceSurface:'main',clientSurface:'mobile',blocks:[file]};
 assert.equal(createCompanionTurnRequestV1Schema.safeParse(turn).success,true);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,blocks:[file,file]}).success,false);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,inputKind:'voice_transcript',voiceArtifactId:id}).success,false);
});
test('a native message accepts twelve images with one file and optional leading text, but never a thirteenth image',()=> {
 const image={type:'image',url:`/api/uploads/${id}/companion/${id}.jpg`,assetId:id,label:'照片'};
 const images=Array.from({length:12},()=>({...image}));
 const turn={version:1,clientMessageId:id,inputKind:'text',sourceSurface:'main',clientSurface:'mobile',blocks:images};
 assert.equal(createCompanionTurnRequestV1Schema.safeParse(turn).success,true);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,blocks:[{type:'text',text:'按顺序比较这组图片。'},...images,file]}).success,true);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,blocks:[...images,image]}).success,false);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,blocks:[...images,file,file]}).success,false);
 assert.equal(createCompanionTurnRequestV1Schema.safeParse({...turn,inputKind:'voice_transcript',voiceArtifactId:id,blocks:[{type:'text',text:'转写'},...images]}).success,false);
});
test('native awareness accepts iOS/Android and rejects invented quiet time while backgrounded',()=> {
 const observation={version:1,id,deviceSessionId:id,appLaunchId:id,host:'ios',topic:'presence.quiet',occurredAt:new Date().toISOString(),elapsedMs:15000,context:{foreground:true,unlocked:true,typing:false,learning:false,conversationId:null,page:null,quietForMs:90000}};
 assert.equal(companionAwarenessObservationV1Schema.safeParse(observation).success,true);
 assert.equal(companionAwarenessObservationV1Schema.safeParse({...observation,host:'android'}).success,true);
 assert.equal(companionAwarenessObservationV1Schema.safeParse({...observation,context:{...observation.context,foreground:false}}).success,false);
});
