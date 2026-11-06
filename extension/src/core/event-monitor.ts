import {StateChangeDetector,type Observation} from './state-change-detector';
export class EventMonitor<T>{private detector:StateChangeDetector<T>;private events:Observation<T>[]=[];constructor(maxAgeMs=120000){this.detector=new StateChangeDetector(maxAgeMs)} accept(value:T,source:'DOM'|'NETWORK',at:string){const o=this.detector.observe(value,source,at);if(o.state==='OBSERVED_CHANGE')this.events.push(o);return o} status(now:number,session:boolean){return this.detector.status(now,session)} timeline(){return structuredClone(this.events)}}
export function relevantMutation(records: readonly MutationRecord[], selector: string): boolean {
  return records.some(record => {
    const element = record.target instanceof Element ? record.target : record.target.parentElement;
    if (element?.closest(selector)) return true;
    return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
      node => node instanceof Element && (node.matches(selector) || !!node.querySelector(selector)),
    );
  });
}
