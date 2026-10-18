import { useMemo } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';

import type { MarkdownImageContext } from '@/shared/types';
import { MarkdownPreview } from '@/modules/code-editor';

type PrdEditorBodyProps = {
  content: string;
  onContentChange: (nextContent: string) => void;
  previewMode: boolean;
  isDarkMode: boolean;
  wordWrap: boolean;
  // Where the preview resolves the PRD's local image references.
  markdownImageContext?: MarkdownImageContext | null;
};

/** Rendered by PrdEditorWorkspace inside the prd-editor module to switch the PRD between markdown editing and rendered preview. */
export default function PrdEditorBody({
  content,
  onContentChange,
  previewMode,
  isDarkMode,
  wordWrap,
  markdownImageContext = null,
}: PrdEditorBodyProps) {
  const extensions = useMemo(
    () => [markdown(), ...(wordWrap ? [EditorView.lineWrapping] : [])],
    [wordWrap],
  );

  if (previewMode) {
    return (
      <div className="prose prose-gray h-full max-w-none overflow-y-auto p-6 dark:prose-invert">
        <MarkdownPreview content={content} imageContext={markdownImageContext} />
      </div>
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onContentChange}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: '14px',
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
