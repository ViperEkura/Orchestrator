/** Local workers share a host; resource permits are held by model/tool calls only. */
export class WorkerPool {
  readonly controllers = new Map<string, AbortController>();
  readonly jobs = new Map<string, Promise<void>>();
  launch(taskId:string,execute:(controller:AbortController)=>Promise<void>,settled:()=>void) {
    if(this.jobs.has(taskId))return;
    const controller=new AbortController();this.controllers.set(taskId,controller);
    const job=Promise.resolve().then(()=>execute(controller)).finally(()=>{this.jobs.delete(taskId);this.controllers.delete(taskId);settled();});
    this.jobs.set(taskId,job);
  }
}
