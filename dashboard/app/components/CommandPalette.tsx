'use client';
import { useState, useEffect } from 'react';
import { Command } from 'cmdk';
import { Session } from '../lib/types';
import * as Dialog from '@radix-ui/react-dialog';

interface CommandPaletteProps {
  sessions: Session[];
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onClearAll: () => void;
  onGlobalSearch: (q: string) => void;
}

export default function CommandPalette({ sessions, onSelectSession, onNewSession, onClearAll, onGlobalSearch }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Toggle the menu when ⌘K is pressed
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = (command: () => void) => {
    setOpen(false);
    command();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="cmdk-overlay" />
        <Dialog.Content className="cmdk-content">
          <Command
            loop
            shouldFilter={false} /* we use custom filtering via fuzzy if needed, but here we just rely on cmdk basic filter for now */
          >
            <Command.Input
              autoFocus
              placeholder="Search sessions, actions, and files... (⌘K)"
              value={search}
              onValueChange={setSearch}
            />
            <Command.List>
              <Command.Empty>No results found.</Command.Empty>

              <Command.Group heading="Suggestions">
                <Command.Item onSelect={() => runCommand(onNewSession)}>
                  ✨ New Session
                </Command.Item>
                <Command.Item onSelect={() => runCommand(onClearAll)}>
                  🗑 Clear All Sessions
                </Command.Item>
                {search.trim().length > 0 && (
                  <Command.Item onSelect={() => runCommand(() => onGlobalSearch(search.trim()))}>
                    🔍 Search for "{search.trim()}"
                  </Command.Item>
                )}
              </Command.Group>

              {sessions.length > 0 && (
                <Command.Group heading="Recent Sessions">
                  {sessions.slice(0, 10).map((s) => (
                    <Command.Item
                      key={s.id}
                      onSelect={() => runCommand(() => onSelectSession(s.id))}
                    >
                      {s.type === 'build' ? '⚡' : s.type === 'refactor' ? '🔧' : '💬'} 
                      {' '}
                      {s.title || s.id}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
