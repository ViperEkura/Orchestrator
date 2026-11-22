import React, {useState} from 'react';
import {terminal,type State,type Task} from '../../core/domain.js';
import type {OrchestratorClient} from '../../transport/client.js';
import {projectTasks,waitingFor} from '../shared/tasks.js';
import {Modal} from './components.js';

export function TaskBoard({state,cwd,client,onClose,onOpen,refresh}:{state:State;cwd:string;client:OrchestratorClient;onClose():void;onOpen(task:Task):void;refresh():Promise<void>}) {
  const tasks=projectTasks(state,cwd),[selected,setSelected]=useState<string>(),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [testCommand,setTestCommand]=useState('');
  const task=tasks.find(item=>item.id===selected)??tasks[0],run=task?state.runs[task.runIds.at(-1)!]:undefined;
  const uncertain=Object.entries(run?.operations??{}).filter(([,operation])=>operation.status==='running'&&!operation.readOnly);
  const act=async(operation:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await operation();await refresh();setText('');}catch(reason){setError(String(reason));}finally{setBusy(false);}};
  return <Modal className="task-board" title="Project tasks" onClose={onClose}>
    <p className="muted">{tasks.filter(item=>!terminal(item.status)).length} active · {tasks.filter(item=>item.status==='queued').length} queued · {tasks.length} total</p>
    {error&&<p role="alert" className="failure">{error}</p>}
    <div className="task-table"><table><thead><tr><th>Task</th><th>Agent</th><th>State</th><th>Waiting for</th></tr></thead><tbody>{tasks.map(item=><tr key={item.id} className={item.id===task?.id?'chosen':''}><td><button onClick={()=>{setSelected(item.id);setText('');}}>{item.objective}</button></td><td>{item.agentId}</td><td>{item.status.replaceAll('_',' ')}</td><td>{waitingFor(item,state)}</td></tr>)}</tbody></table></div>
    {!task?<p className="muted">No tasks in this project.</p>:<section className="task-detail">
      <h3>{task.objective}</h3><p className="muted">{task.id} · {run?.model?.name??'Default model'} · Priority {task.priority??0}</p>
      <p className="muted">Model steps {state.budgets[task.rootId]?.stepsUsed}/{state.budgets[task.rootId]?.maxSteps} · Tokens {state.budgets[task.rootId]?.tokensUsed??0}{state.budgets[task.rootId]?.maxTokens?' / '+state.budgets[task.rootId]!.maxTokens:''}</p>
      {task.acceptanceCriteria?.length?<ul>{task.acceptanceCriteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul>:null}
      <details><summary>Result, workspace and messages</summary><p className="workspace-path">{state.sessions[task.sessionId]?.cwd}</p><pre>{task.result??task.error??'No final result yet.'}</pre>{run?.inbox?.map(message=><p key={message.id}>{message.deliveredAt?'Delivered':'Queued'}: {message.content}</p>)}</details>
      <div className="dialog-actions"><button onClick={()=>onOpen(task)}>Open conversation</button><button disabled={busy||terminal(state.tasks[task.rootId]!.status)} onClick={()=>void act(()=>client.pause(task.rootId,!state.tasks[task.rootId]?.paused))}>{state.tasks[task.rootId]?.paused?'Resume dispatch':'Pause dispatch'}</button><button disabled={busy||terminal(task.status)} onClick={()=>void act(()=>client.cancel(task.id))}>Cancel subtree</button></div>
      {task.status==='completed'&&state.sessions[task.sessionId]?.workspace==='worktree'&&<>
        <p className="muted">Integration: {task.integration?.status??'Not prepared'} {task.integration?.error??''}</p>
        {task.integration&&<p className="workspace-path">{task.integration.path}</p>}
        <label>Verification command<input aria-label="Verification command" className="field" value={testCommand} onChange={event=>setTestCommand(event.target.value)} placeholder="npm test"/></label>
        <div className="dialog-actions"><button disabled={busy||!testCommand.trim()} onClick={()=>void act(()=>client.integrate(task.id,testCommand))}>Prepare and test integration</button><button disabled={busy||task.integration?.status!=='ready'} onClick={()=>void act(()=>client.applyIntegration(task.id))}>Apply verified integration</button></div>
      </>}
      {(!terminal(task.status)||state.sessions[task.sessionId]?.parentSessionId)&&!state.sessions[task.sessionId]?.closedAt&&<><label>{task.status==='needs_review'?'Verified tool result':task.status==='waiting_review'?'Review evidence and decision note':terminal(task.status)?'Queue instructions for the next task':'Message to this agent'}<textarea aria-label="Task note" className="field" value={text} onChange={event=>setText(event.target.value)} maxLength={4000}/></label>
        <div className="dialog-actions">{task.status==='waiting_review'?<><button disabled={busy||!text.trim()} onClick={()=>void act(()=>client.review(task.id,'rejected',text))}>Reject result</button><button disabled={busy||!text.trim()} onClick={()=>void act(()=>client.review(task.id,'accepted',text))}>Accept result</button></>:task.status==='needs_review'?uncertain.map(([id,operation])=><button key={id} disabled={busy||!text.trim()} onClick={()=>void act(()=>client.verify(task.id,id,text))}>Record verified result: {operation.name}</button>):<button disabled={busy||!text.trim()} onClick={()=>void act(()=>state.sessions[task.sessionId]?.parentSessionId?client.agentMessage(task.sessionId,text):client.message(task.id,text))}>Send to agent</button>}</div></>}
    </section>}
  </Modal>;
}
