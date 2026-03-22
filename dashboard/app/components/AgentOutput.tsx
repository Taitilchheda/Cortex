'use client';
import { BuildEvent } from '../lib/types';
import { formatBytes } from '../lib/utils';
import { useState } from 'react';

interface AgentOutputProps {
  events: BuildEvent[];
  architectText: string;
  isRunning: boolean;
  totalFiles: number;
  doneFiles: number;
  startTime: number | null;
  buildComplete: boolean;
  onContinue: () => void;
  onRevert: () => void;
  projectPath: string;
}

export default function AgentOutput({
  events, architectText, isRunning, totalFiles, doneFiles, startTime,
  buildComplete, onContinue, onRevert, projectPath
}: AgentOutputProps) {
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set(['architect', 'coder']));

  const fileEvents = events.filter(e => e.type === 'file_created');
  const logEvents = events.filter(e => e.type === 'log');
  const errorEvents = events.filter(e => e.type === 'error');
  const aiderEvents = events.filter(e => e.type === 'aider_output');
  const healEvents = logEvents.filter(e => e.phase?.startsWith('self_heal'));
  const isDone = logEvents.some(e => e.phase === 'complete');
  const isCoding = logEvents.some(e => e.phase === 'coding');

  // Progress percentage
  const progress = totalFiles > 0 ? Math.round((doneFiles / totalFiles) * 100) : 0;

  // Speed metrics
  const elapsed = startTime ? (Date.now() / 1000) - startTime : 0;
  const filesPerMin = elapsed > 10 ? (doneFiles / elapsed) * 60 : 0;
  const eta = filesPerMin > 0 && totalFiles > doneFiles
    ? Math.round((totalFiles - doneFiles) / filesPerMin * 60)
    : 0;

  const togglePhase = (phase: string) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      next.has(phase) ? next.delete(phase) : next.add(phase);
      return next;
    });
  };

  const openInVSCode = () => {
    // VS Code URI protocol
    window.open(`vscode://file/${projectPath.replace(/\\/g, '/')}`, '_blank');
  };

  const copyFilePaths = () => {
    const paths = fileEvents.map(e => e.rel_path || e.path).join('\n');
    navigator.clipboard.writeText(paths);
  };

  return (
    <div className="ao-scroll" id="agent-output">
      {/* ── Phase Progress Stepper ── */}
      {(architectText || doneFiles > 0 || isDone) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14,
          padding: '8px 12px', background: 'var(--bg-surface)',
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}>
          {[
            { label: 'Architect', icon: '🏗' },
            { label: 'Coder', icon: '⚡' },
            { label: 'Review', icon: '🔍' },
            { label: 'Complete', icon: '✅' },
          ].map((phase, i) => {
            const isActive =
              (i === 0 && architectText && !isCoding) ||
              (i === 1 && isCoding && !isDone) ||
              (i === 2 && healEvents.length > 0 && !isDone) ||
              (i === 3 && isDone);
            const isPast =
              (i === 0 && (isCoding || isDone)) ||
              (i === 1 && isDone) ||
              (i === 2 && isDone);

            return (
              <div key={phase.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 800,
                  background: isPast ? 'var(--green)' : isActive ? 'var(--violet)' : 'var(--bg-hover)',
                  color: isPast || isActive ? '#fff' : 'var(--text-4)',
                  transition: 'all 0.3s var(--ease-out)',
                  boxShadow: isActive ? '0 0 12px var(--violet-glow)' : 'none',
                }}>
                  {isPast ? '✓' : phase.icon}
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: isActive ? 'var(--violet)' : isPast ? 'var(--green)' : 'var(--text-4)',
                }}>
                  {phase.label}
                </span>
                {i < 3 && <div style={{ width: 24, height: 1, background: isPast ? 'var(--green)' : 'var(--border)' }} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Architect Phase ── */}
      {architectText && (
        <div className="ao-phase">
          <div className="ao-phase-head" onClick={() => togglePhase('architect')} style={{ cursor: 'pointer' }}>
            <span style={{ fontSize: 10, transition: 'transform 0.2s' }}>
              {expandedPhases.has('architect') ? '▼' : '▶'}
            </span>
            <span className="ao-phase-label">Phase 1 — Architect Plan</span>
            {isRunning && !isCoding && (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
                <div className="dots"><span /><span /><span /></div>
                <span style={{ fontSize: 10, color: 'var(--text-4)' }}>planning</span>
              </div>
            )}
            {isCoding && (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--green)', fontWeight: 700 }}>✓ Done</span>
            )}
          </div>
          {expandedPhases.has('architect') && (
            <div className="ao-phase-body">{architectText}</div>
          )}
        </div>
      )}

      {/* ── Coder Phase ── */}
      {(doneFiles > 0 || isCoding) && (
        <div className="ao-phase">
          <div className="ao-phase-head" onClick={() => togglePhase('coder')} style={{ cursor: 'pointer' }}>
            <span style={{ fontSize: 10 }}>{expandedPhases.has('coder') ? '▼' : '▶'}</span>
            <span className="ao-phase-label">Phase 2 — File Generation</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--green)', fontWeight: 700 }}>
              {doneFiles}/{totalFiles || '?'} files
            </span>
          </div>

          {expandedPhases.has('coder') && (
            <>
              {/* Progress bar */}
              {totalFiles > 0 && (
                <div style={{ padding: '8px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderTop: 'none' }}>
                  <div className="progress-outer">
                    <div className="progress-inner" style={{ width: `${progress}%` }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-4)' }}>
                    <span style={{ fontWeight: 700 }}>{progress}%</span>
                    {filesPerMin > 0 && <span>{filesPerMin.toFixed(1)} files/min</span>}
                    {eta > 0 && isRunning && <span>~{eta}s remaining</span>}
                    {isDone && <span style={{ color: 'var(--green)' }}>✓ Complete in {Math.round(elapsed)}s</span>}
                  </div>
                </div>
              )}

              {/* Generated files list */}
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)' }}>
                {logEvents.filter(e => e.phase === 'coding').map((e, i) => (
                  <div key={`log-${i}`} style={{
                    padding: '4px 14px', fontSize: 11, fontFamily: 'var(--font-mono)',
                    color: 'var(--text-4)', borderBottom: '1px solid var(--border)',
                  }}>{e.message}</div>
                ))}

                {fileEvents.map((e, i) => (
                  <div key={`file-${i}`} className="file-row">
                    <span className="file-row__icon">✅</span>
                    <span className="file-row__path">{e.rel_path || e.path}</span>
                    <span className="file-row__size">{formatBytes(e.size || 0)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Aider Output ── */}
      {aiderEvents.length > 0 && (
        <div className="ao-phase">
          <div className="ao-phase-head">
            <span style={{ fontSize: 13 }}>🔧</span>
            <span className="ao-phase-label">Aider Refactor</span>
          </div>
          <div className="ao-phase-body">
            {aiderEvents.map((e, i) => <div key={i}>{e.line}</div>)}
          </div>
        </div>
      )}

      {/* ── Self-Heal ── */}
      {healEvents.map((e, i) => (
        <div key={`heal-${i}`} style={{
          padding: '6px 12px', margin: '3px 0', borderRadius: 6,
          fontSize: 11, fontFamily: 'var(--font-mono)',
          background: e.phase === 'self_heal_pass' ? 'var(--green-dim)' : 'var(--amber-dim)',
          color: e.phase === 'self_heal_pass' ? 'var(--green)' : 'var(--amber)',
        }}>{e.message}</div>
      ))}

      {/* ── Errors ── */}
      {errorEvents.map((e, i) => (
        <div key={`err-${i}`} className="ao-error">⚠ {e.message}</div>
      ))}

      {/* ── Completion Summary & Actions ── */}
      {isDone && (
        <div style={{ marginTop: 10 }}>
          <div className="ao-done">
            ✅ Build complete — {doneFiles} files generated in {Math.round(elapsed)}s
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn btn--primary" onClick={openInVSCode} id="open-vscode-btn">
              💻 Open in VS Code
            </button>
            <button className="btn" onClick={onContinue} id="continue-build-btn">
              ➕ Continue Building
            </button>
            <button className="btn" onClick={copyFilePaths} id="copy-paths-btn">
              📋 Copy File Paths
            </button>
            <button className="btn btn--danger" onClick={onRevert} id="revert-build-btn">
              ↩ Revert
            </button>
          </div>
        </div>
      )}

      {/* ── Streaming indicator ── */}
      {isRunning && !isDone && (
        <div style={{ textAlign: 'center', padding: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <div className="dots"><span /><span /><span /></div>
            <span style={{ fontSize: 11, color: 'var(--text-4)' }}>
              {architectText && !isCoding ? 'Planning structure...' : isCoding ? `Writing file ${doneFiles + 1}/${totalFiles || '?'}...` : 'Connecting to agent...'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
