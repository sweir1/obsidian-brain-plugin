import type * as http from "http";
import { type App, MarkdownView } from "obsidian";

export function handleActive(res: http.ServerResponse, app: App): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");

  const file = app.workspace.getActiveFile();
  if (!file) {
    res.end(JSON.stringify({ active: null }));
    return;
  }

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const editor = view?.editor;

  const active: {
    path: string;
    basename: string;
    extension: string;
    cursor?: { line: number; ch: number };
    selection?: { from: { line: number; ch: number }; to: { line: number; ch: number } } | null;
  } = {
    path: file.path,
    basename: file.basename,
    extension: file.extension,
  };

  if (editor) {
    const cursor = editor.getCursor();
    active.cursor = { line: cursor.line, ch: cursor.ch };
    if (editor.somethingSelected()) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      active.selection = {
        from: { line: from.line, ch: from.ch },
        to: { line: to.line, ch: to.ch },
      };
    } else {
      active.selection = null;
    }
  }

  res.end(JSON.stringify({ active }));
}
