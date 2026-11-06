import type {AuthState} from './auth-state-detector';
export interface TargetRecord{reservationId:string;date:string;seat:string;start:string;end:string}
export interface RecoveryTask{taskId:string;targetRecord:TargetRecord;targetRoom:string;targetSeat:string;lastValidSample:string|null;authState:AuthState;taskState:'PAUSED'|'MONITORING'|'STOPPED';lastRoute:string;interruptionReason:string|null;recoveryCount:number}
export function restoreTask(t:RecoveryTask):RecoveryTask{return {...t,authState:'UNKNOWN',taskState:t.taskState==='STOPPED'?'STOPPED':'PAUSED',interruptionReason:'浏览器重启，需重新验证认证、区域及预约'}}
export function pauseTask(t:RecoveryTask,state:AuthState,reason:string):RecoveryTask{return {...t,authState:state,taskState:'PAUSED',interruptionReason:reason}}
