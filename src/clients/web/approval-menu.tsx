import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalMode } from '../../core/domain.js';
import { Icon } from './components.js';

import { approvalOptions as modes } from '../shared/options.js';

export function ApprovalMenu({ value, disabled, onChange }: { value: ApprovalMode; disabled: boolean; onChange: (mode: ApprovalMode) => void }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const focus = (index: number) => menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[index]?.focus();
  const close = (restore = false) => { menu.current?.hidePopover(); setOpen(false); if (restore) trigger.current?.focus(); };
  const show = () => {
    if (disabled) return;
    menu.current?.showPopover(); setOpen(true); focus(modes.findIndex(mode => mode.value === value));
  };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect(), element = menu.current!;
      const { width, height } = element.getBoundingClientRect();
      element.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + 'px';
      const top = anchor.top >= height + 20 ? anchor.top - height - 8 : anchor.bottom + 8;
      element.style.top = Math.max(12, Math.min(top, window.innerHeight - height - 12)) + 'px';
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, value]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  return <>
    <button ref={trigger} type="button" className="approval-trigger" aria-label="Approval mode" aria-haspopup="menu"
      aria-expanded={open} aria-controls={id} aria-disabled={disabled} onClick={() => { if (open) close(); else show(); }}
      onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } }}>
      {modes.find(mode => mode.value === value)?.label}<Icon name="down" size={14}/>
    </button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label="Approval mode" className="approval-menu"
      onToggle={event => setOpen(event.newState === 'open')} onKeyDown={event => {
        const index = Array.from(menu.current!.querySelectorAll('[role="menuitemradio"]')).indexOf(document.activeElement!);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          focus(event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + modes.length) % modes.length);
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') close(true);
      }}>
      <div className="approval-menu-title">Approval mode</div>
      {modes.map(mode => <button key={mode.value} type="button" role="menuitemradio" aria-checked={value === mode.value} tabIndex={-1}
        onClick={() => { close(true); if (value !== mode.value) onChange(mode.value); }}>
        <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
        <span className="approval-check">{value === mode.value && <Icon name="check" size={16}/>}</span>
      </button>)}
    </div>
  </>;
}
