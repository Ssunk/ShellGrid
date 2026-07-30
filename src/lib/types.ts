export type SplitDirection = "horizontal" | "vertical";

export interface PaneNode {
  type: "pane";
  paneId: string;
}

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export interface PaneLaunchInfo {
  cwd: string;
  title?: string;
  shell: string;
  args: string[];
}

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  noProxy?: string;
}

export interface WorkspaceStateV1 {
  schemaVersion: 1;
  rootPath?: string;
  layout: LayoutNode;
  panes: Record<string, PaneLaunchInfo>;
  proxy?: ProxyConfig;
}

export interface EnvironmentStatus {
  windowsSupported: boolean;
  webview2Available: boolean;
  pwshAvailable: boolean;
  pwshPath: string | null;
  gitAvailable: boolean;
  gitPath: string | null;
  message: string | null;
}

export interface GitFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitBranch {
  name: string;
  upstream?: string;
  current: boolean;
}

export interface GitStatus {
  isRepository: boolean;
  repoRoot?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  branches: GitBranch[];
  remotes: string[];
}

export interface GitDiff {
  content: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitOperationResult {
  message: string;
}

export interface Bootstrap {
  workspace: WorkspaceStateV1;
  wsUrl: string;
  token: string;
  environment: EnvironmentStatus;
}

export interface SessionState {
  paneId: string;
  sessionId?: string;
  running: boolean;
  exitCode?: number;
  error?: string;
}
