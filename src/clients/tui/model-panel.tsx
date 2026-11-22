import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ModelDescriptor } from '../../core/domain.js';
import type { OrchestratorClient } from '../../transport/client.js';
import { useTerminalInput } from './input.js';
import { Composer } from './composer.js';
import { backspace, deleteForward, draftOf, insert, move, type Draft } from './editor.js';
import { clean } from './view.js';

const fields = ['Display name (optional)', 'API base URL', 'Model ID', 'API key (optional)'];
export function ModelPanel({ client, selected, width, height, onInfo, onClose }: {
  client: OrchestratorClient; selected?: string; width: number; height: number;
  onInfo(info: Awaited<ReturnType<OrchestratorClient['info']>>): void; onClose(): void;
}) {
  const [models, setModels] = useState<ModelDescriptor[]>([]), [row, setRow] = useState(0);
  const [adding, setAdding] = useState(false), [field, setField] = useState(0);
  const [values, setValues] = useState<Draft[]>(() => fields.map(()=>draftOf()));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const openAdd = () => { setAdding(true); setField(0); setError(''); };
  useEffect(() => {
    const controller = new AbortController();
    void client.models().then(items => { if (!controller.signal.aborted) { setModels(items); setRow(Math.max(0, items.findIndex(item=>item.id===selected))); } })
      .catch(()=>{if(!controller.signal.aborted)setError('Could not load models. Close and retry.');});
    return () => controller.abort();
  }, [client]);
  const choose = async (id?: string) => {
    setBusy(true); setError('');
    try {
      if (!id) {
        const [name, baseUrl, model, apiKey] = values.map((value,index)=>index===3?value.value:value.value.trim());
        id = (await client.addModel({ ...(name ? {name} : {}), baseUrl:baseUrl!, model:model!, apiKey:apiKey! })).id;
      }
      onInfo(await client.setModel(id)); onClose();
    } catch(reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setValues(old=>old.map((value,index)=>index===3?draftOf():value));setBusy(false); }
  };
  useTerminalInput((text,key)=>{
    if(key.escape){if(adding){setAdding(false);setValues(fields.map(()=>draftOf()));}else onClose();return;}
    if(busy || key.ctrl || key.meta || /^\[<\d+;/.test(text))return;
    if(adding){
      if(key.tab || key.upArrow || key.downArrow){setField((field+(key.upArrow||key.shift?3:1))%4);return;}
      if(key.return){if(field<3)setField(field+1);else if(values[1]!.value.trim()&&values[2]!.value.trim())void choose();else setError('API base URL and Model ID are required.');return;}
      const draft=values[field]!;
      const next=key.leftArrow||key.rightArrow?move(draft,key.leftArrow?-1:1):key.backspace?backspace(draft):key.delete?deleteForward(draft):insert(draft,text.replace(/[\r\n]/g,''));
      setValues(old=>old.map((value,index)=>index===field?next:value));
    }else if(text.toLowerCase()==='a')openAdd();
    else if(key.upArrow||key.downArrow)setRow(Math.max(0,Math.min(models.length,row+(key.upArrow?-1:1))));
    else if(key.return){if(row===models.length)openAdd();else if(models[row])void choose(models[row]!.id);}
  });
  const capacity=Math.max(1,height-6), start=Math.max(0,row-capacity+1);
  const draft=values[field]!;
  const entries = [...models.map(item => ({ id:item.id, label:`${selected===item.id?'✓':' '} ${clean(item.name)} · ${clean(item.model)}` })), {id:'add-model',label:'+ Add model'}];
  return <Box height={height} flexDirection="column" backgroundColor="#202020" paddingX={2} paddingY={1}>
    <Text color="cyan" bold>{adding?'ADD MODEL':'CHOOSE MODEL'}</Text>
    <Text color="gray" wrap="truncate-end">{adding?`${field+1}/4 · ${fields[field]}`:'New turns only · running tasks keep their model'}</Text>
    {adding?<Composer draft={field===3?draftOf('•'.repeat(draft.value.length),draft.cursor):draft} rows={1} width={width-7} busy={busy}/>:entries.slice(start,start+capacity).map((item,index)=><Text key={start+index} color={start+index===row?'cyan':'gray'} inverse={start+index===row} wrap="truncate-end">{item.label}</Text>)}
    <Box flexGrow={1}/><Text color={error?'red':'gray'} wrap="truncate-end">{error || (busy?'Saving…':adding?'Keys stay in host credentials, outside chat history.':'A add model · custom URL and API key')}</Text>
    <Text color="gray" wrap="truncate-end">{adding?'Tab next field · Enter next/save · Esc back':'↑↓ select · Enter open/use · Esc back'}</Text>
  </Box>;
}
