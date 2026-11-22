import React, { useRef, useState } from 'react';
import type { ConversationAction, ConversationFolder } from '../../core/domain.js';
import { Icon, Modal } from './components.js';

interface Props {
  title: string;
  pinned: boolean;
  folder: ConversationFolder;
  status: string;
  selected: boolean;
  onOpen: () => void;
  onAction: (action: ConversationAction) => void;
}

export function ConversationRow({ title, pinned, folder, status, selected, onOpen, onAction }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete'>();
  const [name, setName] = useState('');

  function show(x: number, y: number) {
    const element = menu.current!;
    element.showPopover();
    element.style.left = Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8)) + 'px';
    element.querySelector('button')?.focus();
  }
  function close() {
    menu.current?.hidePopover();
    trigger.current?.focus();
  }
  const actions: [string, () => void][] = folder === 'trash' ? [] : [
    ['Rename', () => { setName(title); setDialog('rename'); }],
    [pinned ? 'Unpin' : 'Pin', () => onAction({action:'pin', value:!pinned})]
  ];
  actions.push(folder === 'inbox'
    ? ['Archive', () => onAction({action:'move', folder:'archive'})]
    : ['Restore to project', () => onAction({action:'move', folder:'inbox'})]);
  if (folder !== 'trash') actions.push(['Delete…', () => setDialog('delete')]);

  return <div className={'conversation-row' + (selected ? ' selected' : '')}
    onContextMenu={e => { e.preventDefault(); show(e.clientX, e.clientY); }}>
    <button className="session-row" title={title} onClick={onOpen} aria-current={selected || undefined}>
      {pinned ? <Icon name="pin" size={12}/> : <span className={'status-dot ' + status}/>}<span>{title}</span>
    </button>
    <button className="row-more" ref={trigger} aria-label={'Actions for ' + title} aria-haspopup="menu" aria-expanded={expanded}
      onClick={() => { const r = trigger.current!.getBoundingClientRect(); show(r.left, r.bottom + 3); }}>⋯</button>
    <div className="approval-menu row-menu" popover="auto" role="menu" aria-label="Conversation actions" ref={menu}
      onToggle={e => setExpanded(e.newState === 'open')} onKeyDown={e => {
        if (e.key === 'Escape' || e.key === 'Tab') { close(); if (e.key === 'Escape') e.preventDefault(); return; }
        if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
        e.preventDefault();
        const items = Array.from(e.currentTarget.querySelectorAll('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      {actions.map(([label, action]) => <button key={label} role="menuitem" tabIndex={-1} className={label === 'Delete…' ? 'trash-action' : undefined}
        onClick={() => { close(); action(); }}>{label}</button>)}
    </div>
    {dialog === 'rename' && <Modal title="Rename conversation" onClose={() => setDialog(undefined)}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) { onAction({action:'rename', title:name.trim()}); setDialog(undefined); } }}>
        <input className="field" aria-label="Conversation name" autoFocus maxLength={160} value={name} onFocus={e=>e.target.select()} onChange={e=>setName(e.target.value)}/>
        <div className="dialog-actions"><button type="button" onClick={()=>setDialog(undefined)}>Cancel</button><button className="primary" disabled={!name.trim() || name.trim().length > 160}>Save</button></div>
      </form></Modal>}
    {dialog === 'delete' && <Modal title="Move to Trash?" onClose={() => setDialog(undefined)}>
      <p className="muted">You can restore “{title}” and its agent history from Trash.</p>
      <div className="dialog-actions"><button autoFocus onClick={()=>setDialog(undefined)}>Cancel</button>
        <button className="trash-action" onClick={()=>{ onAction({action:'move', folder:'trash'}); setDialog(undefined); }}>Move to Trash</button></div>
    </Modal>}
  </div>;
}
