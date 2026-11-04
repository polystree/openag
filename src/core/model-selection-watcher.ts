import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Watches the model selected in the Antigravity chat picker.
 *
 * The agy hub stores it as `last_selected_agent_model: MODEL_PLACEHOLDER_Mxxx` in
 * ~/.gemini/antigravity/antigravity_state.pbtxt. If the active account does not offer that model,
 * the hub fails before the PreInvocation hook runs, so OpenAG has to switch accounts as soon as the
 * selection changes rather than when the message is sent.
 */
export class ModelSelectionWatcher {
  private readonly files = [
    path.join(os.homedir(), ".gemini", "antigravity", "antigravity_state.pbtxt"),
    path.join(os.homedir(), ".gemini", "antigravity-ide", "antigravity_state.pbtxt"),
  ];
  private current = "";
  private watching: string[] = [];

  constructor(private readonly onChange: (modelKey: string) => void) {}

  public start(): void {
    for (const file of this.files) {
      // watchFile polls, which is reliable for files that are replaced on write (unlike fs.watch on Windows).
      fs.watchFile(file, { interval: 1000 }, () => this.check());
      this.watching.push(file);
    }
    this.check();
  }

  public getCurrent(): string {
    return this.current;
  }

  private read(): string {
    let newest = "";
    let newestMtime = 0;
    for (const file of this.files) {
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs <= newestMtime) continue;
        const m = /last_selected_agent_model:\s*"?([A-Za-z0-9_.-]+)"?/.exec(fs.readFileSync(file, "utf8"));
        if (m?.[1]) {
          newest = m[1];
          newestMtime = st.mtimeMs;
        }
      } catch { /* file missing or mid-write */ }
    }
    return newest;
  }

  private check(): void {
    const key = this.read();
    if (key && key !== this.current) {
      this.current = key;
      this.onChange(key);
    }
  }

  public dispose(): void {
    for (const file of this.watching) fs.unwatchFile(file);
    this.watching = [];
  }
}
