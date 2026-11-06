import {test} from 'node:test';import assert from 'node:assert/strict';import {runMock} from '../src/core/reservation-engine';import {validateInput} from '../src/core/reservation-rules';import {transition} from '../src/core/task-state-machine';import {isTarget} from '../src/content/page-detector';import type {ReservationTask} from '../src/shared/types';
const task=():ReservationTask=>({id:'test',roomId:'MOCK-ROOM',seatId:'DEMO-01',reservationDate:'2026-11-02',startTime:'09:00',endTime:'10:00',scheduledAt:100,status:'WAITING',createdAt:'',updatedAt:'',paused:false,mode:'MOCK',logs:[]});
test('仅精确目标源',()=>{assert.ok(isTarget('https://seats.dlmu.edu.cn/#/ic/home'));assert.ok(!isTarget('https://seats.dlmu.edu.cn.evil.test/'));assert.ok(!isTarget('http://seats.dlmu.edu.cn/'))});
test('拒绝真实模式与未知座位',()=>{assert.throws(()=>validateInput({...task(),mode:'REAL'}));assert.throws(()=>validateInput({...task(),seatId:'001'}))});
test('时间未到不执行，暂停不执行',()=>{assert.equal(runMock(task(),99).status,'WAITING');assert.equal(runMock({...task(),paused:true},200).status,'WAITING')});
test('模拟成功及重复唤醒幂等',()=>{const t=runMock(task(),200);assert.equal(t.status,'SUCCESS');const n=t.logs.length;runMock(t,300);assert.equal(t.logs.length,n);assert.equal(JSON.parse(JSON.stringify(t)).status,'SUCCESS')});
test('拒绝非法终态转换',()=>assert.throws(()=>transition({...task(),status:'SUCCESS'},'EXECUTING','bad')));
