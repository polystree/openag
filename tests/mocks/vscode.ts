/**
 * Comprehensive VS Code Extension API Mock Harness for Bun Test Runner.
 * Enables zero-dependency unit and integration testing without Electron/VS Code runtime.
 */

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class Disposable {
  private isDisposed = false;
  constructor(private readonly callOnDispose?: () => any) {}

  public dispose(): any {
    if (!this.isDisposed) {
      this.isDisposed = true;
      return this.callOnDispose?.();
    }
  }

  public static from(...disposables: { dispose(): any }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // ignore error on dispose
        }
      }
    });
  }
}

export class EventEmitter<T = any> {
  private listeners: Array<(e: T) => any> = [];

  public event = (listener: (e: T) => any): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    });
  };

  public fire(data: T): void {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch {
        // ignore listener error
      }
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

export class MarkdownString {
  public value: string;
  public isTrusted?: boolean;
  public supportThemeIcons?: boolean;
  public supportHtml?: boolean;

  constructor(value = "", isTrusted = false) {
    this.value = value;
    this.isTrusted = isTrusted;
  }

  public appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  public appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  public appendCodeblock(value: string, language = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

export class Uri {
  public scheme: string;
  public authority = "";
  public path: string;
  public query = "";
  public fragment = "";
  public fsPath: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, "/");
  }

  public toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  public static file(path: string): Uri {
    return new Uri("file", path);
  }

  public static parse(value: string): Uri {
    const parts = value.split("://");
    const scheme = parts[0] || "file";
    const fsPath = parts[1] || "";
    return new Uri(scheme, fsPath);
  }

  public static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.fsPath, ...pathSegments].join("/").replace(/\\/g, "/");
    return new Uri(base.scheme, joined);
  }
}

export interface MockStatusBarItem {
  id?: string;
  alignment: StatusBarAlignment;
  priority?: number;
  name?: string;
  text: string;
  tooltip: string | MarkdownString | undefined;
  color: string | ThemeColor | undefined;
  backgroundColor: ThemeColor | undefined;
  command: string | undefined;
  accessibilityInformation?: unknown;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export class MockOutputChannel {
  public lines: string[] = [];
  public visible = false;
  public disposed = false;

  constructor(public readonly name: string) {}

  public append(value: string): void {
    if (this.lines.length === 0) {
      this.lines.push(value);
    } else {
      this.lines[this.lines.length - 1] += value;
    }
  }

  public appendLine(value: string): void {
    this.lines.push(value);
  }

  public clear(): void {
    this.lines = [];
  }

  public show(): void {
    this.visible = true;
  }

  public hide(): void {
    this.visible = false;
  }

  public dispose(): void {
    this.disposed = true;
  }

  public getOutput(): string {
    return this.lines.join("\n");
  }
}

export class MockWebview {
  public options: Record<string, unknown> = {};
  public html = "";
  public messageEmitter = new EventEmitter<any>();
  public postedMessages: any[] = [];

  public onDidReceiveMessage = this.messageEmitter.event;

  public async postMessage(message: any): Promise<boolean> {
    this.postedMessages.push(message);
    return true;
  }

  public asWebviewUri(uri: Uri): Uri {
    return Uri.parse(`vscode-webview://mock/${uri.fsPath}`);
  }

  public simulateMessage(message: any): void {
    this.messageEmitter.fire(message);
  }
}

export class MockWebviewView {
  public webview: MockWebview = new MockWebview();
  public title = "";
  public description = "";
  public visible = true;
  public visibilityEmitter = new EventEmitter<void>();
  public onDidChangeVisibility = this.visibilityEmitter.event;

  public show(): void {
    this.visible = true;
  }
}

export class MockMemento {
  private store = new Map<string, any>();

  constructor(initialData: Record<string, any> = {}) {
    for (const [k, v] of Object.entries(initialData)) {
      this.store.set(k, v);
    }
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  public async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  public keys(): readonly string[] {
    return Array.from(this.store.keys());
  }

  public setKeysForSync(): void {}
}

export class MockSecretStorage {
  private secrets = new Map<string, string>();
  private readonly changeEmitter = new EventEmitter<{ key: string }>();
  public readonly onDidChange = this.changeEmitter.event;

  public async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
    this.changeEmitter.fire({ key });
  }

  public async delete(key: string): Promise<void> {
    this.secrets.delete(key);
    this.changeEmitter.fire({ key });
  }

  public dump(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }
}

export class MockWorkspaceConfiguration {
  constructor(private values: Record<string, any> = {}) {}

  public get<T>(section: string, defaultValue?: T): T {
    if (section in this.values) {
      return this.values[section] as T;
    }
    return defaultValue as T;
  }

  public has(section: string): boolean {
    return section in this.values;
  }

  public async update(section: string, value: any): Promise<void> {
    this.values[section] = value;
  }
}

export interface MockExtensionContextOptions {
  globalState?: Record<string, any>;
  secrets?: Record<string, string>;
  extensionPath?: string;
}

export function createMockExtensionContext(options: MockExtensionContextOptions = {}) {
  const globalState = new MockMemento(options.globalState || {});
  const workspaceState = new MockMemento();
  const secrets = new MockSecretStorage();
  if (options.secrets) {
    for (const [k, v] of Object.entries(options.secrets)) {
      void secrets.store(k, v);
    }
  }

  const extPath = options.extensionPath || "c:\\mock\\extension";

  return {
    subscriptions: [] as { dispose(): any }[],
    workspaceState,
    globalState,
    secrets,
    extensionUri: Uri.file(extPath),
    extensionPath: extPath,
    globalStorageUri: Uri.file(`${extPath}\\storage`),
    logUri: Uri.file(`${extPath}\\logs`),
    storageUri: Uri.file(`${extPath}\\workspaceStorage`),
    extensionMode: 3, // Test mode
    environmentVariableCollection: {},
    asAbsolutePath: (rel: string) => `${extPath}\\${rel}`,
    storagePath: `${extPath}\\workspaceStorage`,
    globalStoragePath: `${extPath}\\storage`,
    logPath: `${extPath}\\logs`,
  };
}

let activeConfigValues: Record<string, any> = {
  "openag.enabled": true,
  "openag.rotationStrategy": "auto_highest",
  "openag.hideEmail": false,
  "openag.pollIntervalSeconds": 60,
  "openag.endpointOverride": "",
};

let clipboardText = "";
const registeredCommands = new Map<string, (...args: any[]) => any>();
const outputChannels: MockOutputChannel[] = [];
const statusBarItems: MockStatusBarItem[] = [];

export function resetMockVscodeState(): void {
  activeConfigValues = {
    "openag.enabled": true,
    "openag.rotationStrategy": "auto_highest",
    "openag.hideEmail": false,
    "openag.pollIntervalSeconds": 60,
    "openag.endpointOverride": "",
  };
  clipboardText = "";
  registeredCommands.clear();
  outputChannels.length = 0;
  statusBarItems.length = 0;
}

export function setMockConfig(key: string, value: any): void {
  activeConfigValues[key] = value;
}

export function getMockConfig(key: string): any {
  return activeConfigValues[key];
}

export function getMockOutputChannels(): MockOutputChannel[] {
  return outputChannels;
}

export function getMockStatusBarItems(): MockStatusBarItem[] {
  return statusBarItems;
}

export const mockVscode = {
  StatusBarAlignment,
  ThemeColor,
  ThemeIcon,
  Disposable,
  EventEmitter,
  MarkdownString,
  Uri,

  window: {
    createStatusBarItem: (alignment: StatusBarAlignment = StatusBarAlignment.Right, priority = 100): MockStatusBarItem => {
      const item: MockStatusBarItem = {
        alignment,
        priority,
        text: "",
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {
          this.visible = false;
        },
      };
      statusBarItems.push(item);
      return item;
    },

    createOutputChannel: (name: string): MockOutputChannel => {
      const ch = new MockOutputChannel(name);
      outputChannels.push(ch);
      return ch;
    },

    showInformationMessage: async (_message: string, ..._items: any[]): Promise<any> => undefined,
    showWarningMessage: async (_message: string, ..._items: any[]): Promise<any> => undefined,
    showErrorMessage: async (_message: string, ..._items: any[]): Promise<any> => undefined,
    showInputBox: async (_options?: any): Promise<string | undefined> => undefined,
    showQuickPick: async (_items: any, _options?: any): Promise<any> => undefined,

    registerWebviewViewProvider: (_viewType: string, _provider: any, _options?: any): Disposable => {
      return new Disposable();
    },

    onDidChangeWindowState: (_listener: (state: any) => any): Disposable => {
      return new Disposable();
    },

    activeTextEditor: undefined,
  },

  workspace: {
    getConfiguration: (section?: string): MockWorkspaceConfiguration => {
      if (!section) return new MockWorkspaceConfiguration(activeConfigValues);
      const prefix = `${section}.`;
      const scoped: Record<string, any> = {};
      for (const [k, v] of Object.entries(activeConfigValues)) {
        if (k.startsWith(prefix)) {
          scoped[k.slice(prefix.length)] = v;
        } else if (k === section) {
          scoped[""] = v;
        }
      }
      return new MockWorkspaceConfiguration(scoped);
    },

    onDidChangeConfiguration: (_listener: any): Disposable => new Disposable(),
    onDidChangeWorkspaceFolders: (_listener: any): Disposable => new Disposable(),

    workspaceFolders: [
      {
        uri: Uri.file("c:\\workspace\\test-project"),
        name: "test-project",
        index: 0,
      },
    ],
  },

  commands: {
    registerCommand: (command: string, callback: (...args: any[]) => any): Disposable => {
      registeredCommands.set(command, callback);
      return new Disposable(() => {
        registeredCommands.delete(command);
      });
    },

    executeCommand: async (command: string, ...args: any[]): Promise<any> => {
      const fn = registeredCommands.get(command);
      if (fn) {
        return fn(...args);
      }
      return undefined;
    },

    getCommands: async (): Promise<string[]> => Array.from(registeredCommands.keys()),
  },

  env: {
    clipboard: {
      writeText: async (text: string): Promise<void> => {
        clipboardText = text;
      },
      readText: async (): Promise<string> => clipboardText,
    },
    openExternal: async (_uri: any): Promise<boolean> => true,
  },
};

export default mockVscode;
