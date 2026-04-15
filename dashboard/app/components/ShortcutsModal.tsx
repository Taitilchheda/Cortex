import React, { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export default function ShortcutsModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd + / or Ctrl + /
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const shortcuts = [
    { label: 'Command Palette', keys: ['⌘', 'K'] },
    { label: 'Keyboard Shortcuts', keys: ['⌘', '/'] },
    { label: 'Toggle Sidebar', keys: ['⌘', 'B'] },
    { label: 'Toggle Right Panel', keys: ['⌘', '.'] },
    { label: 'New Session', keys: ['⌘', 'Shift', 'N'] },
    { label: 'Clear Active Chat', keys: ['⌘', 'Shift', 'K'] },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" style={{ background: 'rgba(0,0,0,0.5)', position: 'fixed', inset: 0, zIndex: 9998, backdropFilter: 'blur(4px)' }} />
        <Dialog.Content className="dialog-content" style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '90%', maxWidth: '440px', background: 'var(--bg-glass-elevated)',
          backdropFilter: 'blur(40px)', border: '1px solid var(--border-glass)',
          borderRadius: 'var(--radius-xl)', padding: '24px', zIndex: 9999,
          boxShadow: '0 24px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'
        }}>
          <Dialog.Title style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: 600, color: 'var(--text-1)' }}>
            Keyboard Shortcuts
          </Dialog.Title>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {shortcuts.map((s, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '14px', color: 'var(--text-2)' }}>{s.label}</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {s.keys.map(k => (
                    <kbd key={k} style={{
                      fontFamily: 'var(--font-body)', fontSize: '11px', fontWeight: 600,
                      background: 'var(--bg-surface)', border: '1px solid var(--border)',
                      padding: '4px 8px', borderRadius: '6px', color: 'var(--text-1)',
                      boxShadow: '0 2px 0 var(--border)'
                    }}>
                      {k}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Dialog.Close asChild>
            <button className="btn btn--secondary" style={{ width: '100%', marginTop: '24px' }}>Got it</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
