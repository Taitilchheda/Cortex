'use client';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { useTheme } from 'next-themes';

interface DiffViewerProps {
  oldCode: string;
  newCode: string;
  fileName: string;
}

export default function DiffViewer({ oldCode, newCode, fileName }: DiffViewerProps) {
  const { theme } = useTheme();

  return (
    <div className="pro-diff-viewer">
      <div className="diff-header">
        <span className="diff-title">{fileName}</span>
      </div>
      <ReactDiffViewer
        oldValue={oldCode}
        newValue={newCode}
        splitView={true}
        useDarkTheme={theme === 'dark'}
        styles={{
          variables: {
            dark: {
              diffViewerBackground: '#09090b',
              diffViewerColor: '#e4e4e7',
              addedBackground: 'rgba(34, 197, 94, 0.15)',
              addedColor: '#4ade80',
              removedBackground: 'rgba(239, 68, 68, 0.15)',
              removedColor: '#f87171',
              wordAddedBackground: 'rgba(34, 197, 94, 0.25)',
              wordRemovedBackground: 'rgba(239, 68, 68, 0.25)',
              codeFoldBackground: '#18181b',
              codeFoldContentColor: '#71717a',
            }
          }
        }}
        showDiffOnly={false}
      />
    </div>
  );
}
