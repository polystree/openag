import * as vscode from "vscode";
import type { LogManager } from "../core/log-manager.js";
import type { QuotaMonitor } from "../core/quota-monitor.js";
import type { TokenManager } from "../core/token-manager.js";
import type { OpenAGConfig } from "../types.js";

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "openag.accounts";
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tokenManager: TokenManager,
    private readonly quotaMonitor: QuotaMonitor,
    private readonly log: (msg: string) => void,
    private readonly logManager: LogManager,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview();
    this.setWebviewMessageListener(webviewView.webview);
    this.postState();
    setTimeout(() => this.postState(), 100);
    setTimeout(() => this.postState(), 500);
  }

  public refresh(): void {
    this.postState();
  }

  private postState(): void {
    if (!this.view) return;
    const accounts = this.tokenManager.getAccounts();
    const activeEmail = this.tokenManager.getActiveEmail();
    const quotas = this.quotaMonitor.getAllQuotas();
    const config = this.tokenManager.getConfig();
    const logs = this.logManager.getLogs();

    void this.view.webview.postMessage({
      type: "state",
      data: {
        accounts,
        activeEmail,
        quotas,
        config,
        logs,
      },
    });
  }

  private setWebviewMessageListener(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: { action: string; payload?: unknown }) => {
      try {
        switch (message.action) {
          case "ready":
            this.postState();
            break;
          case "addAccount":
            await vscode.commands.executeCommand("openag.addAccount");
            break;
          case "refreshQuotas":
            await this.quotaMonitor.pollAllAccounts();
            this.refresh();
            break;
          case "toggleAccount":
            if (typeof message.payload === "object" && message.payload !== null) {
              const p = message.payload as { email: string; enabled: boolean };
              await this.tokenManager.toggleAccountEnabled(p.email, p.enabled);
              void this.quotaMonitor.pollAllAccounts();
              this.refresh();
            }
            break;
          case "refreshAccount":
            if (typeof message.payload === "string") {
              await this.quotaMonitor.refreshAccountQuota(message.payload);
              this.refresh();
            }
            break;
          case "removeAccount":
            if (typeof message.payload === "string") {
              await this.tokenManager.removeAccount(message.payload);
              this.refresh();
            }
            break;
          case "clearLogs":
            this.logManager.clear();
            this.refresh();
            break;
          case "updateConfig":
            if (typeof message.payload === "object" && message.payload !== null) {
              await this.tokenManager.updateConfig(message.payload as Partial<OpenAGConfig>);
              this.refresh();
            }
            break;
        }
      } catch (err: unknown) {
        this.log(`Webview action error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>
:root{--bg:var(--vscode-sideBar-background,#1e1e2e);--card:var(--vscode-editor-background,#181825);--border:var(--vscode-widget-border,rgba(255,255,255,.08));--text:var(--vscode-foreground,#cdd6f4);--dim:var(--vscode-descriptionForeground,#a6adc8);--accent:var(--vscode-button-background,#0078d4);--accent-h:var(--vscode-button-hoverBackground,#006abc);--hover:var(--vscode-list-hoverBackground,rgba(255,255,255,.05));--badge-bg:var(--vscode-badge-background,rgba(0,120,212,.25));--badge-fg:var(--vscode-badge-foreground,#fff);--font:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);--mono:var(--vscode-editor-font-family,monospace)}
*{box-sizing:border-box;margin:0;padding:0;user-select:none}body{font-family:var(--font);background:var(--bg);color:var(--text);padding:8px;display:flex;flex-direction:column;gap:8px;overflow-x:hidden}
.row{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}.badge{background:var(--accent);color:#fff;font-weight:700;font-size:10px;padding:2px 6px;border-radius:4px;flex-shrink:0}
.btn-row{display:flex;gap:4px;align-items:center;justify-content:flex-end;flex-shrink:0}.btn{display:inline-flex;align-items:center;justify-content:center;gap:3px;background:var(--accent);color:#fff;border:1px solid transparent;border-radius:4px;padding:3px 7px;font-family:var(--font);font-size:10.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0}.btn:hover{background:var(--accent-h)}.btn-sec{background:var(--card);color:var(--text);border-color:var(--border)}.btn-sec:hover{background:var(--hover)}.btn-icon{padding:2px 5px;font-size:10.5px}
.card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px;min-width:0}.card.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.card.disabled{opacity:.55}.card-head{display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0}.card-email{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.tier-tag{font-size:8.5px;font-weight:700;padding:1px 3px;border-radius:3px;text-transform:uppercase;background:var(--badge-bg);color:var(--badge-fg);flex-shrink:0}.active-tag{font-size:8.5px;font-weight:700;padding:1px 3px;border-radius:3px;background:rgba(16,185,129,.2);color:#10b981;border:1px solid rgba(16,185,129,.4);flex-shrink:0}.dis-tag{font-size:8.5px;font-weight:700;padding:1px 3px;border-radius:3px;background:rgba(255,255,255,.08);color:var(--dim);flex-shrink:0}
.quota-row{display:flex;align-items:center;justify-content:space-between;font-size:10px;gap:4px;min-width:0}.progress-bg{flex:1;height:5px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;min-width:20px}.progress-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .3s}.progress-fill.warn{background:#f59e0b}.progress-fill.err{background:#ef4444}
.reset-tag{font-size:8.5px;font-family:var(--mono);padding:1px 3px;border-radius:3px;background:rgba(255,255,255,.06);color:var(--dim);white-space:nowrap;flex-shrink:0}.reset-tag.active{background:rgba(0,120,212,.2);color:#60a5fa}
.switch{position:relative;display:inline-block;width:26px;height:14px;cursor:pointer;flex-shrink:0}.switch input{opacity:0;width:0;height:0;position:absolute}.slider{position:absolute;inset:0;background:rgba(255,255,255,.15);border-radius:10px;transition:.18s}.slider::before{position:absolute;content:"";height:8px;width:8px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.18s}.switch input:checked+.slider{background:var(--accent)}.switch input:checked+.slider::before{transform:translateX(12px)}
.term{background:var(--card);border:1px solid var(--border);border-radius:6px;height:180px;max-height:25vh;overflow-y:auto;padding:6px;font-family:var(--mono);font-size:9.5px;display:flex;flex-direction:column;gap:3px;min-width:0}
.log-line{display:flex;gap:4px;line-height:1.3;word-break:break-all;min-width:0}.log-tag{font-size:8px;font-weight:700;padding:0 2px;border-radius:2px;flex-shrink:0;background:rgba(255,255,255,.1)}.empty{padding:12px;text-align:center;color:var(--dim);font-size:10.5px}
</style></head><body>
<div class="row" style="padding-bottom:6px;border-bottom:1px solid var(--border);"><div style="display:flex;align-items:center;gap:6px;"><span class="badge">OPENAG</span></div><label class="switch" title="Toggle OpenAG"><input type="checkbox" id="cfg-enabled" checked /><span class="slider"></span></label></div>
<div class="row"><span style="font-size:10px;color:var(--dim);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Auto-routes to highest quota account">Auto-routes to highest quota</span><div class="btn-row"><button class="btn btn-sec" id="b-refresh" title="Refresh quotas">Refresh</button><button class="btn" id="b-add" title="Add Google Account">+ Add</button></div></div>
<div style="font-size:10.5px;font-weight:600;color:var(--dim);margin-top:2px;">Accounts Pool</div>
<div id="acc-list" style="display:flex;flex-direction:column;gap:6px;"></div>
<div class="row" style="margin-top:2px;"><span style="font-size:10.5px;font-weight:600;color:var(--dim);">Event Stream</span><button class="btn btn-sec btn-icon" onclick="clearLogs()">Clear</button></div>
<div class="term" id="term"></div>
<script>
const vscode=acquireVsCodeApi();let state={accounts:[],activeEmail:'',quotas:{},config:{},logs:[]};
const send=(action,payload)=>vscode.postMessage({action,payload});const clearLogs=()=>send('clearLogs');
document.getElementById('b-add').onclick=()=>send('addAccount');document.getElementById('b-refresh').onclick=()=>send('refreshQuotas');document.getElementById('cfg-enabled').onchange=(e)=>send('updateConfig',{enabled:e.target.checked});
window.addEventListener('message',e=>{if(e.data?.type==='state'){state=e.data.data;render();}});
function fmtTime(s){if(!s)return '';const d=Date.parse(s)-Date.now();if(d<=0)return 'ready';const days=Math.floor(d/864e5),hrs=Math.floor((d%864e5)/36e5),mins=Math.floor((d%36e5)/6e4),secs=Math.floor((d%6e4)/1e3);return days>0?\`\${days}d \${hrs}h\`:hrs>0?\`\${hrs}h \${mins}m \${secs}s\`:\`\${mins}m \${secs}s\`;}
function render(){if(state.config)document.getElementById('cfg-enabled').checked=state.config.enabled??true;renderAccounts();renderLogs();}
function makeBarHtml(label,pct,resetIso){const cls=pct<20?'err':pct<40?'warn':'';const resetText=fmtTime(resetIso);return \`<div class="quota-row"><div style="display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow:hidden;"><span style="color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${label}</span>\${resetIso?\`<span class="reset-tag \${resetText!=='ready'?'active':''}" data-reset="\${resetIso}">\${resetText}</span>\`:''}</div><div style="display:flex;align-items:center;gap:4px;width:48%;min-width:55px;max-width:110px;flex-shrink:0;"><div class="progress-bg"><div class="progress-fill \${cls}" style="width:\${pct}%"></div></div><span style="font-family:var(--mono);font-size:9.5px;width:26px;text-align:right;flex-shrink:0;">\${pct}%</span></div></div>\`;}
function renderAccounts(){const list=document.getElementById('acc-list');if(!state.accounts?.length){list.innerHTML='<div class="empty">No accounts in pool.<br>Click <strong>+ Add</strong> or sign in via Antigravity.</div>';return;}list.innerHTML=state.accounts.map(acc=>{const isDis=acc.status==='disabled';const isAct=!isDis&&acc.email.toLowerCase()===(state.activeEmail||'').toLowerCase();const q=state.quotas[acc.email.toLowerCase()]||{};const fams=q.families||[{key:'gemini',label:'Gemini',percent:100},{key:'claude',label:'Claude',percent:100}];const qHtml='<div style="display:flex;flex-direction:column;gap:3px;">'+fams.map(f=>{let html=makeBarHtml(f.label+' (5h)',f.limit5h?.percent??f.percent??100,f.limit5h?.resetTime??f.resetTime);if(f.limitWeekly)html+=makeBarHtml(f.label+' (7d)',f.limitWeekly.percent,f.limitWeekly.resetTime);return html;}).join('')+'</div>';return \`<div class="card \${isAct?'active':''} \${isDis?'disabled':''}"><div class="card-head"><div style="display:flex;align-items:center;gap:3px;overflow:hidden;flex:1;min-width:0;"><span class="tier-tag">\${acc.tier||'pro'}</span><span class="card-email">\${acc.email}</span>\${isAct?'<span class="active-tag">ACTIVE</span>':isDis?'<span class="dis-tag">OFF</span>':''}</div><div style="display:flex;align-items:center;gap:3px;flex-shrink:0;"><label class="switch" title="\${isDis?'Enable in pool':'Disable in pool'}"><input type="checkbox" \${isDis?'':'checked'} onchange="send('toggleAccount',{email:'\${acc.email}',enabled:this.checked})" /><span class="slider"></span></label><button class="btn btn-sec btn-icon" onclick="send('refreshAccount','\${acc.email}')" title="Refresh">&#x21bb;</button><button class="btn btn-sec btn-icon" onclick="send('removeAccount','\${acc.email}')" title="Remove">&times;</button></div></div>\${qHtml}</div>\`;}).join('');}
setInterval(()=>{document.querySelectorAll('.reset-tag[data-reset]').forEach(el=>{const iso=el.getAttribute('data-reset');if(iso){const t=fmtTime(iso);el.textContent=t;if(t==='ready')el.classList.remove('active');else el.classList.add('active');}});},1000);
function renderLogs(){const el=document.getElementById('term');const logs=state.logs||[];el.innerHTML=logs.length?logs.map(l=>{const col=l.level==='error'?'#f87171':l.level==='warn'?'#fbbf24':l.level==='rotate'?'#60a5fa':'';return \`<div class="log-line"><span style="color:var(--dim);flex-shrink:0;">\${new Date(l.timestamp).toLocaleTimeString()}</span><span class="log-tag">[\${l.category}]</span><span style="\${col?\`color:\${col};\`:''}">\${l.message}</span></div>\`;}).join(''):'<div class="empty">No logs yet.</div>';el.scrollTop=el.scrollHeight;}
send('ready');render();
</script></body></html>`;
  }
}
