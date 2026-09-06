import type { ShellGridAPI } from "../../shared/desktop";

declare global {
  interface Window { shellgrid: ShellGridAPI }
}
export function desktop(): ShellGridAPI {
  if (!window.shellgrid) throw new Error("请通过 Electron 启动 ShellGrid 桌面应用");
  return window.shellgrid;
}
