'use strict';

const tool = $('terminal-tools');
const toolPanel = $('terminal-tool-panel');
let terminalToolMode;
let position = pref('terminal-tool-position', { x: null, y: 12 });
let batchDraft = new Map();
const encode = (text) => {
  const bytes = new TextEncoder().encode(text);
  let ascii = '';
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii);
};
const decode = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
const commandWrapper = (text) => 'eval "$(printf %s ' + encode(text) + ' | base64 -d)"';

function shellHook(shell, token) {
  const wire = [
    '__syncssh_emit() { printf "\\033]777;syncssh;' + token + ';%s\\007" "$1"; }',
    '__syncssh_hist() { __syncssh_emit "H;$(printf %s "$1" | base64 | tr -d \'\\r\\n\')"; }'
  ];
  if (shell === 'zsh') return [...wire,
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook -d preexec __syncssh_pre 2>/dev/null || :',
    'add-zsh-hook -d precmd __syncssh_post 2>/dev/null || :',
    '__syncssh_pre() { __syncssh_emit B; __syncssh_hist "$1"; }',
    '__syncssh_post() { local s=$?; __syncssh_emit "E;$s"; return $s; }',
    'add-zsh-hook preexec __syncssh_pre',
    'add-zsh-hook precmd __syncssh_post',
    '__syncssh_emit R'
  ].join('\n');
  return [...wire,
    'if [ -z "$__syncssh_old_started" ]; then',
    '  __syncssh_old_started=1',
    '  PS0="$PS0"\'\\[\\e]777;syncssh;' + token + ';B\\a\\]\'',
    'fi',
    '__syncssh_old_history=$(HISTTIMEFORMAT= history 1)',
    '__syncssh_prompt() {',
    '  local s=$? latest command',
    '  latest=$(HISTTIMEFORMAT= history 1)',
    '  if [ "$latest" != "$__syncssh_old_history" ]; then',
    '    __syncssh_old_history=$latest',
    '    command=$(printf "%s\\n" "$latest" | sed \'1s/^[[:space:]]*[0-9][0-9]*[* ]*[[:space:]]//\')',
    '    [ -z "$command" ] || __syncssh_hist "$command"',
    '  fi',
    '  __syncssh_emit "E;$s"',
    '  return "$s"',
    '}',
    'case "$(declare -p PROMPT_COMMAND 2>/dev/null || :)" in',
    '  "declare -a "*) [[ " __syncssh_prompt " == " $' + '{PROMPT_COMMAND[0]} " ]] || PROMPT_COMMAND=(__syncssh_prompt "$' + '{PROMPT_COMMAND[@]}") ;;',
    '  *) PROMPT_COMMAND=(__syncssh_prompt "$PROMPT_COMMAND") ;;',
    'esac',
    '__syncssh_emit R'
  ].join('\n');
}
function installShellIntegration(session, shell) {
  const variable = shell === 'bash' ? 'BASH_VERSION' : 'ZSH_VERSION';
  const script = shellHook(shell, session.shellToken);
  api.input(session.id, 'if [ -n "$' + variable + '" ]; then source <(printf %s ' + encode(script)
    + ' | base64 -d); else printf "\\nSyncSSH: expected ' + shell + '\\n"; fi\r');
  announce('正在接入 ' + shell + '，等待 shell 提示符。');
}
function rememberCommand(session, text) {
  if (!text || !text.trim() || text.length > 16384 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return;
  if (text.includes('SyncSSH: expected') || text === session.pendingCommand?.wrapper || text.startsWith('eval "$(printf %s ')) return;
  if (session.history[0] !== text) session.history.unshift(text);
  session.history.splice(20);
}
function bindShell(session) {
  session.shellToken = crypto.randomUUID();
  session.history = [];
  session.term.parser.registerOscHandler(777, (data) => {
    const prefix = 'syncssh;' + session.shellToken + ';';
    if (!data.startsWith(prefix)) return false;
    const event = data.slice(prefix.length);
    if (event === 'R') {
      session.shellReady = true;
      session.atPrompt = false;
      if (activeSession() === session) renderTerminalTools(true);
    } else if (event === 'B') {
      session.atPrompt = false;
    } else if (event.startsWith('H;') && event.length < 100000) {
      try { rememberCommand(session, decode(event.slice(2))); } catch {}
    } else if (/^E;\d{1,3}$/.test(event)) {
      session.atPrompt = true;
      if (session.pendingCommand) {
        rememberCommand(session, session.pendingCommand.source);
        session.pendingCommand = null;
        batchDraft.delete(session.id);
        announce('多行命令已完成 · 退出码 ' + event.slice(2));
        if (activeSession() === session) closeTerminalTool();
      } else if (activeSession() === session) updateTerminalControls(session);
    }
    return true;
  });
}

function closeTerminalTool() {
  terminalToolMode = null;
  toolPanel.hidden = true;
  toolPanel.replaceChildren();
}
function keepToolOnScreen() {
  const area = document.querySelector('.upper').getBoundingClientRect();
  const terminalWidth = $('terminals').clientWidth || area.width;
  const maxX = Math.max(4, terminalWidth - tool.offsetWidth - 6);
  const maxY = Math.max(42, area.height - tool.offsetHeight - 4);
  tool.style.left = (position.x === null ? Math.max(4, maxX - 8) : Math.max(4, Math.min(maxX, position.x))) + 'px';
  tool.style.top = Math.max(42, Math.min(maxY, position.y + 36)) + 'px';
}
function updateTerminalControls(session) {
  const execute = toolPanel.querySelector('[data-execute-batch]');
  const input = toolPanel.querySelector('textarea');
  if (execute) {
    execute.disabled = !session.atPrompt || !!session.pendingCommand || !input.value.trim();
    execute.textContent = session.pendingCommand ? '执行中…' : '执行并收起';
    input.disabled = !!session.pendingCommand;
  }
}
function renderTerminalTools(refresh = false) {
  const session = activeSession();
  tool.hidden = !session || active?.kind !== 'ssh' || session.status !== '已连接';
  if (tool.hidden) { closeTerminalTool(); return; }
  if (terminalToolMode && (refresh || toolPanel.dataset.mode !== terminalToolMode
    || toolPanel.dataset.session !== session.id)) {
    toolPanel.replaceChildren();
    toolPanel.dataset.mode = terminalToolMode;
    toolPanel.dataset.session = session.id;
    toolPanel.hidden = false;
    if (!session.shellReady) {
      const actions = el('div', undefined, 'tool-actions');
      actions.append(button('接入 Bash', () => installShellIntegration(session, 'bash')),
        button('接入 Zsh', () => installShellIntegration(session, 'zsh')));
      toolPanel.append(el('p', '在空闲提示符下接入当前 Bash 或 Zsh 会话，以识别命令和完成状态。', 'muted'), actions);
    } else if (terminalToolMode === 'batch') {
      const input = el('textarea');
      input.setAttribute('aria-label', '多行命令内容');
      input.placeholder = '输入要在当前 shell 中一起执行的命令';
      input.value = batchDraft.get(session.id) || '';
      input.oninput = () => { batchDraft.set(session.id, input.value); updateTerminalControls(session); };
      const execute = button('执行并收起', () => {
        if (activeSession() !== session || !session.atPrompt || session.pendingCommand) return;
        const source = input.value.replace(/\r\n?/g, '\n');
        if (source.length > 16384 || /[\x00-\x08\x0b-\x1f\x7f]/.test(source)) {
          announce('多行命令最多 16384 字符，支持普通文本与换行。', true);
          return;
        }
        const wrapper = commandWrapper(source);
        session.pendingCommand = { source, wrapper };
        session.atPrompt = false;
        api.input(session.id, wrapper + '\r');
        updateTerminalControls(session);
        session.term.focus();
      }, 'primary');
      execute.dataset.executeBatch = '1';
      toolPanel.append(el('p', '请在空白的 shell 提示符下执行。命令会沿用当前目录和环境。', 'muted'), input, execute);
      updateTerminalControls(session);
    } else {
      toolPanel.append(el('h2', '最近 20 条命令'));
      const history = el('div', undefined, 'tool-history');
      for (const text of session.history) {
        const item = button(text.split('\n')[0], () => {
          if (!session.atPrompt) { announce('等待 shell 返回提示符再填入命令。', true); return; }
          const recall = /[\n\t]/.test(text) ? commandWrapper(text) : text;
          session.term.focus();
          session.term.paste(recall);
          closeTerminalTool();
        });
        item.title = text;
        history.append(item);
      }
      if (!session.history.length) history.append(el('p', '当前会话还没有记录。', 'muted'));
      toolPanel.append(history);
    }
  }
  keepToolOnScreen();
}
function wireTerminalTools() {
  const open = (mode) => {
    if (terminalToolMode === mode) closeTerminalTool();
    else { terminalToolMode = mode; renderTerminalTools(true); }
  };
  $('batch-open').onclick = () => open('batch');
  $('history-open').onclick = () => open('history');
  $('clear-terminal').onclick = () => {
    const session = activeSession();
    session?.term.clear();
    session?.term.focus();
  };
  const handle = $('tool-handle');
  let drag;
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX - tool.offsetLeft, y: event.clientY - tool.offsetTop };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = (event) => {
    if (!drag || !handle.hasPointerCapture(event.pointerId)) return;
    position = { x: Math.max(4, event.clientX - drag.x), y: Math.max(6, event.clientY - drag.y - 36) };
    keepToolOnScreen();
  };
  handle.onpointerup = handle.onpointercancel = () => {
    if (!drag) return;
    drag = null;
    savePref('terminal-tool-position', position);
  };
  new ResizeObserver(() => { if (!tool.hidden) keepToolOnScreen(); }).observe(document.querySelector('.upper'));
}
