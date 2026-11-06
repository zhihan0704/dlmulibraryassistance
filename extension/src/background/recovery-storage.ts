import {restoreTask,type RecoveryTask} from '../core/session-manager';
const KEY='lsa.recovery.v1';
export async function getRecovery():Promise<RecoveryTask|null>{const data=await chrome.storage.local.get(KEY);return data[KEY]??null}
export async function saveRecovery(task:RecoveryTask){await chrome.storage.local.set({[KEY]:task})}
export async function resetAfterStartup(){const task=await getRecovery();if(task)await saveRecovery(restoreTask(task))}
