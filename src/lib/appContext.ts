import type { PaneLaunchInfo, SessionState, SplitDirection } from "./types";

export const APP_CONTEXT = Symbol("shellgrid-app");

export interface AppController {
  getLaunch(paneId: string): PaneLaunchInfo;
  getSession(paneId: string): SessionState | undefined;
  getActivePane(): string;
  setActivePane(paneId: string): void;
  split(paneId: string, direction: SplitDirection): void;
  close(paneId: string): void;
  updateRatio(path: string, ratio: number): void;
  mountTerminal(paneId: string, host: HTMLElement): void;
  resizeTerminal(paneId: string): void;
}
