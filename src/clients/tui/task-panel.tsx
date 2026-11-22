import React,{useState} from 'react';
import {Box,Text} from 'ink';
import {terminal,type State,type Task} from '../../core/domain.js';
import type {OrchestratorClient} from '../../transport/client.js';
import {projectTasks,waitingFor} from '../shared/tasks.js';
import {useTerminalInput} from './input.js';
import {Composer} from './composer.js';
import {draftOf,insert,backspace,deleteForward,move} from './editor.js';
import {agentProgress} from './view.js';

export function TaskPanel({state,cwd,client,width,height,onOpen,onClose,streaming={},reasoning={}}:{streaming?:Record<string,string>;reasoning?:Record<string,string>;state?:State;cwd:string;client:OrchestratorClient;width:number;height:number;onOpen(task:Task):void;onClose():void}) {
  const tasks=projectTasks(state,cwd),[index,setIndex]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [form,setForm]=useState<{taskId:string;action:'message'|'accepted'|'rejected'|'verify'|'integrate';callId?:string}>(),[draft,setDraft]=useState(draftOf());
  const row=Math.max(0,Math.min(index,tasks.length-1)),task=tasks[row],capacity=Math.max(1,height-8),start=Math.max(0,row-capacity+1);
  const act=async(operation:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await operation();setForm(undefined);setDraft(draftOf());}catch(reason){setError(String(reason));}finally{setBusy(false);}};
  useTerminalInput((text,key)=>{
    if(key.escape){if(form){setForm(undefined);setDraft(draftOf());}else onClose();return;}
    if(busy||key.ctrl||key.meta||key.tab||/^\[<\d+;/.test(text))return;
    if(form){
      if(key.return){if(!draft.value.trim())return;void act(()=>form.action==='integrate'?client.integrate(form.taskId,draft.value):form.action==='message'?(state?.sessions[state.tasks[form.taskId]!.sessionId]?.parentSessionId?client.agentMessage(state.tasks[form.taskId]!.sessionId,draft.value):client.message(form.taskId,draft.value)):form.action==='verify'?client.verify(form.taskId,form.callId!,draft.value):client.review(form.taskId,form.action,draft.value));return;}
      setDraft(key.leftArrow||key.rightArrow?move(draft,key.leftArrow?-1:1):key.backspace?backspace(draft):key.delete?deleteForward(draft):insert(draft,text));return;
    }
    if(key.upArrow||key.downArrow){setIndex(Math.max(0,Math.min(tasks.length-1,row+(key.upArrow?-1:1))));return;}
    if(!task||!state)return;
    if(key.return){onOpen(task);return;}
    if(text==='i'&&task.status==='completed'&&state.sessions[task.sessionId]?.workspace==='worktree'){setForm({taskId:task.id,action:'integrate'});return;}
    if(text==='f'&&task.integration?.status==='ready'){void act(()=>client.applyIntegration(task.id));return;}
    if(text==='p'){void act(()=>client.pause(task.rootId,!state.tasks[task.rootId]?.paused));return;}
    if(text==='c'&&!terminal(task.status)){void act(()=>client.cancel(task.id));return;}
    if(text==='m'&&(!terminal(task.status)||state.sessions[task.sessionId]?.parentSessionId)&&!state.sessions[task.sessionId]?.closedAt&&task.status!=='waiting_review')setForm({taskId:task.id,action:'message'});
    if((text==='y'||text==='n')&&task.status==='waiting_review')setForm({taskId:task.id,action:text==='y'?'accepted':'rejected'});
    if(text==='v'&&task.status==='needs_review'){
      const entry=Object.entries(state.runs[task.runIds.at(-1)!]?.operations??{}).find(([,op])=>op.status==='running'&&!op.readOnly);
      if(entry)setForm({taskId:task.id,action:'verify',callId:entry[0]});
    }
  });
  return <Box height={height} flexDirection="column" backgroundColor="#202020" paddingX={2} paddingY={1}>
    <Text bold color="cyan">PROJECT TASKS · {tasks.filter(task=>!terminal(task.status)).length} active · {tasks.length} total</Text>
    {form?<><Text color="gray">{form.action==='integrate'?'Verification command in isolated integration worktree':form.action==='verify'?'Verify effects first, then enter the observed tool result':form.action==='message'?'Queue message · idle agents receive it on their next task':'Review evidence and decision note'}</Text><Composer draft={draft} width={width-7} rows={Math.min(3,capacity)} busy={busy}/></>:<>
      {tasks.slice(start,start+capacity).map((item,i)=><Text key={item.id} inverse={start+i===row} color={item.status==='failed'?'red':'gray'} wrap="truncate-end">{state?agentProgress(item,state,streaming,reasoning,width-4).text:item.objective}</Text>)}
      {!tasks.length&&<Text color="gray">No tasks in this project.</Text>}
      <Text color="gray" wrap="truncate-end">{task&&state?'Waiting for: '+waitingFor(task,state):' '}</Text>
      <Text color="gray" wrap="truncate-end">{task&&state?`Steps ${state.budgets[task.rootId]?.stepsUsed??0}/${state.budgets[task.rootId]?.maxSteps??0} · Tokens ${state.budgets[task.rootId]?.tokensUsed??0} · ${task.acceptanceCriteria?.join('; ')??''}`:' '}</Text>
    </>}
    <Box flexGrow={1}/><Text color="red" wrap="truncate-end">{error||' '}</Text>
    <Text color="gray" wrap="truncate-end">{form?'Enter send · Esc back':'↑↓ select · Enter chat · P pause/resume · M message · C cancel'}</Text>
    {!form&&<Text color="gray" wrap="truncate-end">Y/N review · V verify · I integrate · F apply · Esc back</Text>}
  </Box>;
}
