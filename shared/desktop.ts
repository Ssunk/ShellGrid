import type { Bootstrap, GitDiff, GitOperationResult, GitStatus, WorkspaceStateV1 } from "../src/lib/types";
import type { ConnectionInfo, TerminalCommand, TerminalEvent } from "./protocol";

export type GitMutation =
  | { type: "stage" | "unstage" | "restore"; path: string; paths: string[] }
  | { type: "commit"; path: string; message: string; amend: boolean; signoff: boolean }
  | { type: "switchBranch"; path: string; branch: string; create: boolean }
  | { type: "pull"; path: string }
  | { type: "push"; path: string; remote: string | null; forceWithLease: boolean };
export interface GitDiffRequest { path: string; filePath: string; staged: boolean }
export interface TerminalBridge {
  connect(): Promise<ConnectionInfo>;
  send(command: TerminalCommand): void;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
  onDisconnected(listener: () => void): () => void;
  disconnect(): void;
}
export interface ShellGridAPI {
  getBootstrap(): Promise<Bootstrap>;
  saveWorkspace(workspace: WorkspaceStateV1): Promise<void>;
  chooseDirectory(defaultPath: string): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  onWorkspaceRequest(provider: () => WorkspaceStateV1): () => void;
  git: {
    status(path: string): Promise<GitStatus>;
    diff(request: GitDiffRequest): Promise<GitDiff>;
    headMessage(path: string): Promise<string | null>;
    mutate(request: GitMutation): Promise<GitOperationResult>;
  };
  terminal: TerminalBridge;
}
