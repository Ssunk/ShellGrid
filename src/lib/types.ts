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
  layout: LayoutNode;
  panes: Record<string, PaneLaunchInfo>;
  proxy?: ProxyConfig;
}

export interface EnvironmentStatus {
  windowsSupported: boolean;
  webview2Available: boolean;
  pwshAvailable: boolean;
  pwshPath: string | null;
  message: string | null;
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
