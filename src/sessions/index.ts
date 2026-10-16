import type * as T from "../types";
import { Library } from "./library";
import { Folder } from "./folder";
import { DesignEditor } from "./design";
import type { Context } from "./capability";

export function createSession(
  context: Context,
): T.CanvaLibrarySession | T.CanvaFolderSession | T.CanvaDesignEditor {
  const scope = context.engine.scope;
  switch (scope.kind) {
    case "library":
      return new Library(context);
    case "folder":
      return new Folder(context, scope.id);
    case "design":
      return new DesignEditor(context, scope.id);
  }
}
