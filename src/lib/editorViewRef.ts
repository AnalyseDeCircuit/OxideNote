/**
 * 全局 EditorView 单例引用
 *
 * NoteEditor 在挂载/切换时设置当前活跃的 CodeMirror EditorView，
 * 供 OutlinePanel 等外部组件直接通过 API 操控编辑器（如滚动到行）。
 */
import type { EditorView } from '@codemirror/view';

let _view: EditorView | null = null;

export function setEditorView(view: EditorView | null) {
  _view = view;
}

export function getEditorView(): EditorView | null {
  return _view;
}
