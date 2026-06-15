export {
  activateWorkspace,
  assignLoopToWorkspace,
  createWorkspace,
  deleteWorkspace,
  getDefaultWorkspaceId,
  getWorkspace,
  listWorkspaces,
  resolveWorkspaceId,
  updateWorkspace,
  type WorkspaceKind,
  type WorkspaceView,
} from "../workspace/index.js";

// Backward-compatible alias
export type LoopWorkspaceView = import("../workspace/index.js").WorkspaceView;
