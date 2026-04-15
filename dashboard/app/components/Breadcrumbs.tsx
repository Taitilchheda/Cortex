'use client';
import { ChevronRight, Folder, MessageSquare, Zap, Hammer, FileCode } from 'lucide-react';
import { Session } from '../lib/types';

interface BreadcrumbsProps {
  activeSession: Session | null;
  activeFile: string | null;
}

export default function Breadcrumbs({ activeSession, activeFile }: BreadcrumbsProps) {
  const getIcon = () => {
    if (activeFile) return <FileCode size={14} className="icon-blue" />;
    if (!activeSession) return <Folder size={14} className="icon-violet" />;
    if (activeSession.type === 'build') return <Zap size={14} className="icon-blue" />;
    if (activeSession.type === 'refactor') return <Hammer size={14} className="icon-amber" />;
    return <MessageSquare size={14} className="icon-violet" />;
  };

  return (
    <div className="breadcrumb-bar">
      <div className="bc-item">
        <span className="bc-root">Cortex Pro</span>
      </div>
      
      <ChevronRight size={14} className="bc-sep" />
      
      <div className="bc-item">
        <div className="bc-icon-box">
          {getIcon()}
        </div>
        <span className="bc-text">
          {activeSession ? (activeSession.title || 'Untitled Session') : 'Welcome'}
        </span>
      </div>

      {activeFile && (
        <>
          <ChevronRight size={14} className="bc-sep" />
          <div className="bc-item">
            <span className="bc-text bc-file">{activeFile.split(/[/\\]/).pop()}</span>
          </div>
        </>
      )}
    </div>
  );
}
