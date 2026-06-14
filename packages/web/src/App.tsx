import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type DiffSource = 'staged' | 'unstaged' | 'untracked';
type DiffLineType = 'context' | 'add' | 'remove' | 'meta';
type CommentSide = 'old' | 'new';
type CommentSeverity = 'note' | 'bug' | 'question' | 'nit';
type CommentStatus = 'open' | 'resolved';
type AgentKind = 'codex' | 'claude';
type ActiveTab = 'files' | 'comments' | 'prompt';

interface DiffLine { id: string; type: DiffLineType; raw: string; content: string; oldLine?: number; newLine?: number; }
interface DiffHunk { id: string; header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[]; }
interface DiffFile { id: string; source: DiffSource; oldPath: string; newPath: string; hunks: DiffHunk[]; }
interface DiffResponse { repo: { repoRoot: string; repoName: string; branch: string; }; files: DiffFile[]; generatedAt: string; updatedAt?: string; }
interface ReviewComment { id: string; file: string; side: CommentSide; line: number; hunkHeader: string; selectedCode: string; comment: string; severity: CommentSeverity; status: CommentStatus; createdAt: string; updatedAt: string; }
interface CodexSessionMessage { id: string; role: 'user' | 'assistant'; text: string; timestamp: string; }
interface CodexSessionResponse { threadId?: string; threadName?: string; title?: string; updatedAt?: string; messages: CodexSessionMessage[]; unavailableReason?: string; }
interface SessionListItem { id: string; source: 'codex' | 'claude'; title?: string; updatedAt?: string; messageCount: number; }
interface SessionsListResponse { sessions: SessionListItem[]; }
interface CommentTarget { file: string; side: CommentSide; line: number; hunkHeader: string; selectedCode: string; }
interface DiffStats { additions: number; deletions: number; files: number; hunks: number; }
interface BranchInfo { current: string; branches: string[]; }

const severityOptions: CommentSeverity[] = ['bug', 'question', 'nit', 'note'];

export function App() {
  const [diff, setDiff] = useState<DiffResponse | undefined>();
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>();
  const [activeTarget, setActiveTarget] = useState<CommentTarget | undefined>();
  const [draftComment, setDraftComment] = useState('');
  const [draftSeverity, setDraftSeverity] = useState<CommentSeverity>('bug');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [editComment, setEditComment] = useState('');
  const [editSeverity, setEditSeverity] = useState<CommentSeverity>('bug');
  const [promptPreview, setPromptPreview] = useState('');
  const [agentOutput, setAgentOutput] = useState('');
  const [sessionList, setSessionList] = useState<SessionListItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [activeSession, setActiveSession] = useState<CodexSessionResponse | undefined>();
  const [sessionLoading, setSessionLoading] = useState(false);
  const [activeProvider, setActiveProvider] = useState<AgentKind>('claude');
  const [modelList, setModelList] = useState<{ id: string; label: string }[]>([]);
  const [activeModel, setActiveModel] = useState<string>('claude-sonnet-4-6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('files');
  const [branches, setBranches] = useState<BranchInfo | undefined>();
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('pr-theme') as 'dark' | 'light') ?? 'dark'
  );
  const [showSession, setShowSession] = useState(true);

  useEffect(() => {
    // Apply persisted theme immediately (before first paint flash)
    document.documentElement.setAttribute('data-theme', theme);
    void refresh(true);
    void loadBranches();
    void loadSessionList(true);
    void loadModels('claude');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pr-theme', theme);
  }, [theme]);

  useEffect(() => {
    let inFlight = false;
    const id = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void Promise.all([refresh(false), loadSessionList(false)])
        .catch((e) => setError(msgFor(e)))
        .finally(() => { inFlight = false; });
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  const selectedFile = useMemo(() => {
    if (!diff?.files.length) return undefined;
    return diff.files.find((f) => f.id === selectedFileId) ?? diff.files[0];
  }, [diff, selectedFileId]);

  const openComments = comments.filter((c) => c.status === 'open');
  const totalStats = useMemo(() => getDiffStats(diff?.files ?? []), [diff]);
  const hasStagedChanges = diff?.files.some((f) => f.source === 'staged') ?? false;

  async function refresh(showBusy = true) {
    if (showBusy) { setBusy(true); setError(''); }
    try {
      const [nextDiff, nextComments] = await Promise.all([
        api<DiffResponse>('/api/diff'),
        api<ReviewComment[]>('/api/comments')
      ]);
      setDiff(nextDiff);
      setComments(nextComments);
      setSelectedFileId((cur) =>
        cur && nextDiff.files.some((f) => f.id === cur) ? cur : nextDiff.files[0]?.id
      );
    } catch (e) {
      setError(msgFor(e));
    } finally {
      if (showBusy) setBusy(false);
    }
  }

  async function loadSessionList(selectFirst: boolean) {
    try {
      const r = await api<SessionsListResponse>('/api/sessions');
      setSessionList(r.sessions);
      if (selectFirst && r.sessions.length > 0 && !activeSessionId) {
        const first = r.sessions[0];
        setActiveProvider(first.source);
        setActiveSessionId(first.id);
        void loadSession(first.id);
      }
    } catch {
      // non-critical
    }
  }

  async function loadSession(id: string) {
    setSessionLoading(true);
    setActiveSession(undefined);
    try {
      const s = await api<CodexSessionResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      setActiveSession(s);
    } catch (e) {
      setActiveSession({ messages: [], unavailableReason: msgFor(e) });
    } finally {
      setSessionLoading(false);
    }
  }

  function selectSession(id: string) {
    setActiveSessionId(id);
    void loadSession(id);
  }

  async function loadBranches() {
    try { setBranches(await api<BranchInfo>('/api/git/branches')); } catch { /* non-critical */ }
  }

  async function loadModels(provider: AgentKind) {
    try {
      const r = await api<{ models: { id: string; label: string }[] }>(`/api/models?provider=${provider}`);
      setModelList(r.models);
      setActiveModel(r.models[0]?.id ?? '');
    } catch { /* non-critical */ }
  }

  async function switchBranch(branch: string) {
    if (branch === (branches?.current ?? diff?.repo.branch)) return;
    setBranchSwitching(true);
    try {
      await api('/api/git/checkout', { method: 'POST', body: JSON.stringify({ branch }) });
      await Promise.all([refresh(false), loadBranches(), loadSessionList(false)]);
      flash(`Switched to ${branch}`);
    } catch (e) { setError(msgFor(e)); }
    finally { setBranchSwitching(false); }
  }

  async function createNewBranch(name: string) {
    setBranchSwitching(true);
    try {
      await api('/api/git/branch', { method: 'POST', body: JSON.stringify({ name }) });
      await Promise.all([refresh(false), loadBranches(), loadSessionList(false)]);
      flash(`Created and switched to ${name}`);
    } catch (e) { setError(msgFor(e)); }
    finally { setBranchSwitching(false); }
  }

  async function deleteExistingBranch(name: string) {
    try {
      await api(`/api/git/branch/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadBranches();
      flash(`Deleted ${name}`);
    } catch (e) { setError(msgFor(e)); }
  }

  async function stageFile(file: DiffFile) {
    try {
      await api('/api/git/stage', { method: 'POST', body: JSON.stringify({ files: [displayPath(file)] }) });
      await refresh(false);
    } catch (e) { setError(msgFor(e)); }
  }

  async function unstageFile(file: DiffFile) {
    try {
      await api('/api/git/unstage', { method: 'POST', body: JSON.stringify({ files: [displayPath(file)] }) });
      await refresh(false);
    } catch (e) { setError(msgFor(e)); }
  }

  async function commit() {
    if (!commitMessage.trim() || !hasStagedChanges) return;
    setBusy(true);
    try {
      const r = await api<{ hash: string }>('/api/git/commit', {
        method: 'POST', body: JSON.stringify({ message: commitMessage.trim() })
      });
      setCommitMessage('');
      flash(`Committed ${r.hash}`);
      await refresh(false);
    } catch (e) { setError(msgFor(e)); }
    finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!activeTarget || !draftComment.trim()) return;
    const saved = await api<ReviewComment>('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ ...activeTarget, comment: draftComment.trim(), severity: draftSeverity })
    });
    setComments((c) => [...c, saved]);
    setActiveTarget(undefined);
    setDraftComment('');
    setDraftSeverity('bug');
  }

  async function updateExistingComment(id: string) {
    if (!editComment.trim()) return;
    const updated = await api<ReviewComment>(`/api/comments/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ comment: editComment.trim(), severity: editSeverity })
    });
    setComments((c) => c.map((item) => (item.id === id ? updated : item)));
    setEditingId(undefined);
  }

  async function setCommentStatus(comment: ReviewComment, status: CommentStatus) {
    const ep = status === 'resolved' ? 'resolve' : 'reopen';
    const updated = await api<ReviewComment>(`/api/comments/${encodeURIComponent(comment.id)}/${ep}`, { method: 'POST' });
    setComments((c) => c.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function removeComment(comment: ReviewComment) {
    await api(`/api/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
    setComments((c) => c.filter((item) => item.id !== comment.id));
  }

  async function buildAndPreviewPrompt(customMessage?: string): Promise<string> {
    setBusy(true);
    try {
      const r = await api<{ prompt: string }>('/api/prompt/build', {
        method: 'POST', body: JSON.stringify({ message: customMessage })
      });
      setPromptPreview(r.prompt);
      return r.prompt;
    } catch (e) { setError(msgFor(e)); return ''; }
    finally { setBusy(false); }
  }

  async function sendToAgent(kind: AgentKind, customMessage?: string) {
    setBusy(true);
    setAgentOutput('');
    try {
      const r = await api<{ success: boolean; command: string; stdout: string; stderr: string; error?: string }>(
        `/api/agent/${kind}`,
        { method: 'POST', body: JSON.stringify({ message: customMessage, model: activeModel }) }
      );
      setAgentOutput(
        [r.error ? `Error: ${r.error}` : '', r.stdout, r.stderr ? `stderr:\n${r.stderr}` : '']
          .filter(Boolean).join('\n\n')
      );
      await Promise.all([refresh(false), loadSessionList(false)]);
      // auto-select the newest session for this provider
      const latest = sessionList.filter(s => s.source === kind)[0];
      if (latest) { setActiveSessionId(latest.id); void loadSession(latest.id); }
    } catch (e) { setError(msgFor(e)); }
    finally { setBusy(false); }
  }

  async function newSession() {
    flash(`Starting new ${activeProvider === 'claude' ? 'Claude Code' : 'Codex'} session…`);
    await sendToAgent(activeProvider);
  }

  function flash(msg: string) {
    setSuccessMsg(msg);
    window.setTimeout(() => setSuccessMsg(''), 2200);
  }

  const currentBranch = branches?.current ?? diff?.repo.branch ?? '…';
  const repoName = diff?.repo.repoName ?? 'PatchRelay';

  const activeSessionItem = sessionList.find(s => s.id === activeSessionId);
  const activeSessionSource = activeSessionItem?.source;
  const activeSessionTitle = activeSession?.threadName ?? activeSessionItem?.title;

  return (
    <main className="app-shell">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <span className="header-repo">{repoName}</span>
          <BranchSelector
            current={currentBranch}
            branches={branches?.branches ?? [currentBranch]}
            switching={branchSwitching}
            onSwitch={(b) => void switchBranch(b)}
            onCreate={(name) => void createNewBranch(name)}
            onDelete={(name) => void deleteExistingBranch(name)}
          />
        </div>

        <nav className="header-tabs">
          <button className={`h-tab${activeTab === 'files' ? ' active' : ''}`} onClick={() => setActiveTab('files')}>
            Diff <span className="tab-count">{totalStats.files}</span>
          </button>
          <button className={`h-tab${activeTab === 'comments' ? ' active' : ''}`} onClick={() => setActiveTab('comments')}>
            Comments <span className="tab-count">{openComments.length}</span>
          </button>
          <button
            className={`h-tab${activeTab === 'prompt' ? ' active' : ''}`}
            onClick={() => { setActiveTab('prompt'); if (!promptPreview) void buildAndPreviewPrompt(); }}
          >
            Prompt
          </button>
        </nav>

        <div className="header-actions">
          <button className="hbtn" onClick={() => void refresh(true)} disabled={busy} title="Refresh">↺</button>
          <button
            className={`hbtn${showSession ? ' active' : ''}`}
            onClick={() => setShowSession(s => !s)}
            title="Toggle session panel"
          >
            ☰
          </button>
          <button
            className="hbtn theme-toggle"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title="Toggle light/dark"
          >
            {theme === 'dark' ? '☀︎' : '◑'}
          </button>
        </div>
      </header>

      {/* ── Flash ── */}
      {error ? <div className="flash flash-error">{error} <button className="flash-close" onClick={() => setError('')}>×</button></div> : null}
      {successMsg ? <div className="flash flash-success">{successMsg}</div> : null}

      {/* ── Workspace ── */}
      <section className={`workspace${showSession ? '' : ' session-hidden'}`}>

        {/* Left: files + commit */}
        <aside className="file-sidebar" aria-label="Changed files">
          <div className="sidebar-heading">
            <span>Files</span>
            <span className="count-badge">{totalStats.files}</span>
          </div>
          <div className="file-list">
            {diff?.files.length ? diff.files.map((file) => {
              const fs = getFileStats(file);
              const fc = comments.filter((c) => commentMatchesFile(c, file));
              const isActive = file.id === selectedFile?.id;
              return (
                <div key={file.id} className={`file-row${isActive ? ' active' : ''}`}>
                  <button className="file-row-label" onClick={() => { setSelectedFileId(file.id); setActiveTab('files'); }}>
                    <span className="file-name">{displayPath(file)}</span>
                    <span className="file-meta">
                      <span className={`src-badge src-${file.source}`}>{sourceLabel(file.source)}</span>
                      <span className="adds">+{fs.additions}</span>
                      <span className="dels">−{fs.deletions}</span>
                      {fc.length ? <span className="comment-count">💬 {fc.length}</span> : null}
                    </span>
                  </button>
                  <button
                    className={`stage-btn ${file.source === 'staged' ? 'unstage' : 'stage'}`}
                    title={file.source === 'staged' ? 'Unstage' : 'Stage'}
                    onClick={() => file.source === 'staged' ? void unstageFile(file) : void stageFile(file)}
                  >
                    {file.source === 'staged' ? '−' : '+'}
                  </button>
                </div>
              );
            }) : <p className="empty-hint">No local diff.</p>}
          </div>
          <div className="commit-panel">
            <textarea className="commit-input" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Commit message…" rows={3} />
            <button className="commit-btn" onClick={() => void commit()} disabled={busy || !commitMessage.trim() || !hasStagedChanges}>
              Commit staged
            </button>
            {!hasStagedChanges && !!diff?.files.length && <p className="commit-hint">Stage files to commit.</p>}
          </div>
        </aside>

        {/* Center: diff + floating chat */}
        <section className="center-pane" aria-label="Main panel">
          <div className="center-content">
            {activeTab === 'files' && (
              <>
                <div className="files-toolbar">
                  <strong>{totalStats.files} files</strong>
                  <span><span className="adds">+{totalStats.additions}</span> <span className="dels">−{totalStats.deletions}</span></span>
                  {diff?.updatedAt ? <span className="muted">{formatDate(diff.updatedAt)}</span> : null}
                </div>
                {selectedFile ? (
                  <DiffViewer file={selectedFile} comments={comments} activeTarget={activeTarget}
                    draftComment={draftComment} draftSeverity={draftSeverity} editingId={editingId}
                    editComment={editComment} editSeverity={editSeverity}
                    onStartComment={(t) => { setActiveTarget(t); setDraftComment(''); setDraftSeverity('bug'); }}
                    onCancelDraft={() => setActiveTarget(undefined)}
                    onDraftCommentChange={setDraftComment} onDraftSeverityChange={setDraftSeverity}
                    onSaveDraft={() => void saveDraft()}
                    onEdit={(c) => { setEditingId(c.id); setEditComment(c.comment); setEditSeverity(c.severity); }}
                    onEditCommentChange={setEditComment} onEditSeverityChange={setEditSeverity}
                    onCancelEdit={() => setEditingId(undefined)} onSaveEdit={(id) => void updateExistingComment(id)}
                    onResolve={(c) => void setCommentStatus(c, 'resolved')}
                    onReopen={(c) => void setCommentStatus(c, 'open')}
                    onDelete={(c) => void removeComment(c)} />
                ) : <div className="empty-state">Make a local change and refresh.</div>}
              </>
            )}
            {activeTab === 'comments' && (
              <CommentsTab comments={comments} editingId={editingId} editComment={editComment} editSeverity={editSeverity}
                onEdit={(c) => { setEditingId(c.id); setEditComment(c.comment); setEditSeverity(c.severity); }}
                onEditCommentChange={setEditComment} onEditSeverityChange={setEditSeverity}
                onCancelEdit={() => setEditingId(undefined)} onSaveEdit={(id) => void updateExistingComment(id)}
                onResolve={(c) => void setCommentStatus(c, 'resolved')}
                onReopen={(c) => void setCommentStatus(c, 'open')}
                onDelete={(c) => void removeComment(c)} />
            )}
            {activeTab === 'prompt' && (
              <div className="prompt-tab">
                <div className="prompt-tab-bar">
                  <span>Prompt preview</span>
                  <div className="prompt-tab-actions">
                    <button className="hbtn" onClick={() => void buildAndPreviewPrompt()} disabled={busy}>Rebuild</button>
                    <button className="hbtn" onClick={async () => {
                      const p = promptPreview || await buildAndPreviewPrompt();
                      if (p) { await navigator.clipboard.writeText(p); flash('Copied!'); }
                    }} disabled={busy}>Copy</button>
                  </div>
                </div>
                {promptPreview ? <pre className="prompt-preview-content">{promptPreview}</pre>
                  : <div className="empty-state">{busy ? 'Building…' : 'Click Rebuild to preview the prompt.'}</div>}
              </div>
            )}
          </div>

          {/* Floating chat compose */}
          <FloatingCompose
            busy={busy}
            agentOutput={agentOutput}
            openComments={openComments}
            sessionSource={activeSessionSource}
            sessionTitle={activeSessionTitle}
            commitMessage={commitMessage}
            onSend={(msg) => void sendToAgent(activeProvider, msg)}
          />
        </section>

        {/* Right: session browser */}
        <aside className="session-sidebar" aria-label="Agent session">
          <SessionPanel
            sessions={sessionList}
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            sessionLoading={sessionLoading}
            activeProvider={activeProvider}
            activeModel={activeModel}
            modelList={modelList}
            onProviderChange={(p) => {
              setActiveProvider(p);
              void loadModels(p);
              const first = sessionList.find(s => s.source === p);
              if (first) { setActiveSessionId(first.id); void loadSession(first.id); }
            }}
            onModelChange={setActiveModel}
            onSelectSession={selectSession}
            onNewSession={() => void newSession()}
          />
        </aside>
      </section>
    </main>
  );
}

// ── Branch selector ───────────────────────────────────────────────────────────

interface BranchSelectorProps {
  current: string;
  branches: string[];
  switching: boolean;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
}

function BranchSelector({ current, branches, switching, onSwitch, onCreate, onDelete }: BranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) { setOpen(false); setCreating(false); setNewName(''); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
    setNewName('');
    setCreating(false);
    setOpen(false);
  }

  return (
    <div className="branch-selector" ref={rootRef}>
      <button
        className="branch-btn"
        onClick={() => { if (!switching) setOpen(o => !o); }}
        disabled={switching}
      >
        <svg className="branch-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM5.75 5.677V8.5a2.5 2.5 0 0 0 2.5 2.5h2.059a2.25 2.25 0 1 1 0 1.5H8.25A4 4 0 0 1 4.25 8.5V5.677a2.25 2.25 0 1 1 1.5 0z"/>
        </svg>
        <span className="branch-label">{switching ? '…' : current}</span>
        <svg className="branch-chevron" viewBox="0 0 10 6" fill="currentColor" width="8" height="8">
          <path d="M0 0l5 6 5-6z"/>
        </svg>
      </button>

      {open && (
        <div className="branch-dropdown">
          <div className="branch-list">
            {branches.map((b) => (
              <div key={b} className={`branch-item${b === current ? ' current' : ''}`}>
                <button
                  className="branch-item-label"
                  onClick={() => { onSwitch(b); setOpen(false); }}
                >
                  {b === current ? (
                    <svg viewBox="0 0 12 12" fill="currentColor" width="10" height="10" style={{ flexShrink: 0 }}>
                      <path d="M10.28 2.28L4.5 8.06 1.72 5.28a.75.75 0 0 0-1.06 1.06l3.34 3.34a.75.75 0 0 0 1.06 0l6.28-6.28a.75.75 0 0 0-1.06-1.06z"/>
                    </svg>
                  ) : (
                    <span style={{ width: 10, flexShrink: 0 }} />
                  )}
                  <span>{b}</span>
                </button>
                {b !== current && (
                  <button
                    className="branch-delete-btn"
                    title={`Delete ${b}`}
                    onClick={(e) => { e.stopPropagation(); onDelete(b); }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="branch-new">
            {creating ? (
              <div className="branch-new-form">
                <input
                  ref={inputRef}
                  className="branch-new-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-branch-name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                />
                <button className="branch-new-confirm" onClick={handleCreate} disabled={!newName.trim()}>
                  Create
                </button>
              </div>
            ) : (
              <button className="branch-new-trigger" onClick={() => setCreating(true)}>
                <span>+</span> New branch
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Floating compose ──────────────────────────────────────────────────────────

interface FloatingComposeProps {
  busy: boolean;
  agentOutput: string;
  openComments: ReviewComment[];
  sessionSource?: 'codex' | 'claude';
  sessionTitle?: string;
  commitMessage: string;
  onSend: (msg: string) => void;
}

function FloatingCompose(props: FloatingComposeProps) {
  const [msg, setMsg] = useState('');
  const label = props.sessionSource === 'codex' ? 'Codex' : 'Claude Code';
  const shortTitle = props.sessionTitle ?? null;

  function handleSend() {
    props.onSend(msg);
    setMsg('');
  }

  return (
    <div className="chat-float">
      {shortTitle && <div className="chat-float-session">{label} · {shortTitle}</div>}
      <textarea
        className="chat-float-input"
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        placeholder={`Ask ${label} to edit your code…`}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
        }}
      />
      <div className="chat-float-footer">
        <div className="chat-float-hints">
          {Object.entries(
            props.openComments.reduce<Record<string, { file: string; lines: number[] }>>((acc, c) => {
              const base = c.file.split('/').pop() ?? c.file;
              const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
              if (!acc[stem]) acc[stem] = { file: c.file, lines: [] };
              acc[stem].lines.push(c.line);
              return acc;
            }, {})
          ).map(([stem, { file, lines }]) => (
            <span
              key={stem}
              className="comment-chip"
              title={`${file} — lines ${lines.join(', ')}`}
            >
              <span className="chip-dot" />
              {stem}{lines.length > 1 ? ` (${lines.length})` : `:${lines[0]}`}
            </span>
          ))}
          {props.openComments.length === 0 && props.commitMessage.trim() && !msg && (
            <button
              className="chat-float-suggestion"
              onClick={() => setMsg(props.commitMessage.trim())}
              title="Use commit message as instruction"
            >
              💡 {props.commitMessage.trim().slice(0, 40)}{props.commitMessage.trim().length > 40 ? '…' : ''}
            </button>
          )}
        </div>
        <button className="chat-float-send" disabled={props.busy} onClick={handleSend}>
          {props.busy ? '…' : '↑'}
        </button>
      </div>
      {props.agentOutput ? <pre className="agent-output-inline">{props.agentOutput}</pre> : null}
    </div>
  );
}

// ── Generic dropdown select ───────────────────────────────────────────────────

interface DropdownOption { value: string; label: string; sub?: string; }

function DropdownSelect({ value, options, onChange, placeholder, disabled }: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="dd-root" ref={ref}>
      <button
        className="dd-btn"
        onClick={() => { if (!disabled) setOpen(o => !o); }}
        disabled={disabled}
      >
        <span className="dd-label">{selected?.label ?? placeholder ?? '—'}</span>
        <svg className="dd-chevron" viewBox="0 0 10 6" fill="currentColor" width="8" height="8">
          <path d="M0 0l5 6 5-6z"/>
        </svg>
      </button>
      {open && (
        <div className="dd-menu">
          {options.map(o => (
            <button
              key={o.value}
              className={`dd-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="dd-item-label">{o.label}</span>
              {o.sub && <span className="dd-item-sub">{o.sub}</span>}
            </button>
          ))}
          {options.length === 0 && (
            <div className="dd-empty">{placeholder ?? 'No options'}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, source }: { msg: CodexSessionMessage; source?: 'codex' | 'claude' }) {
  const isUser = msg.role === 'user';
  const roleLabel = isUser ? 'You' : source === 'claude' ? 'Claude' : 'Codex';
  return (
    <div className={`msg msg-${msg.role}`}>
      <div className="msg-header">
        <span className="msg-role">{roleLabel}</span>
        <span className="msg-time">{formatDate(msg.timestamp)}</span>
      </div>
      <div className="msg-body">
        {msg.text
          ? isUser
            ? <span className="msg-plain">{msg.text}</span>
            : <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          : <em className="msg-empty">(empty)</em>}
      </div>
    </div>
  );
}

// ── Session panel (right sidebar) ─────────────────────────────────────────────

interface SessionPanelProps {
  sessions: SessionListItem[];
  activeSessionId?: string;
  activeSession?: CodexSessionResponse;
  sessionLoading: boolean;
  activeProvider: AgentKind;
  activeModel: string;
  modelList: { id: string; label: string }[];
  onProviderChange: (p: AgentKind) => void;
  onModelChange: (m: string) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

function SessionPanel(props: SessionPanelProps) {
  const session = props.activeSession;
  const messages = session?.messages ?? [];
  const activeItem = props.sessions.find((s) => s.id === props.activeSessionId);
  const filtered = props.sessions.filter(s => s.source === props.activeProvider);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length, props.activeSessionId]);

  return (
    <div className="session-panel">
      {/* Row 1: provider + model + new button */}
      <div className="session-header-row">
        <DropdownSelect
          value={props.activeProvider}
          options={[
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex',  label: 'Codex' },
          ]}
          onChange={(v) => props.onProviderChange(v as AgentKind)}
        />
        <DropdownSelect
          value={props.activeModel}
          options={props.modelList.map(m => ({ value: m.id, label: m.label }))}
          onChange={props.onModelChange}
          placeholder="Model"
        />
        <button className="new-session-btn" onClick={props.onNewSession} title="New session">+</button>
      </div>

      {/* Row 2: session picker full width */}
      <div className="session-picker-row">
        <DropdownSelect
          value={activeItem?.source === props.activeProvider ? (props.activeSessionId ?? '') : ''}
          options={filtered.map(s => ({
            value: s.id,
            label: s.title ?? s.id.slice(s.source === 'claude' ? 7 : 6, 23),
            sub: s.updatedAt ? shortDate(s.updatedAt) : undefined,
          }))}
          onChange={(v) => props.onSelectSession(v)}
          placeholder="No sessions"
          disabled={props.sessionLoading}
        />
      </div>

      {/* Meta bar */}
      {activeItem && (
        <div className="session-meta-bar">
          <span className="session-msg-count">{activeItem.messageCount} messages</span>
          {session?.updatedAt && <span className="session-time">{formatDate(session.updatedAt)}</span>}
        </div>
      )}

      {/* Messages — oldest first, scroll to bottom */}
      <div className="session-messages">
        {props.sessionLoading ? (
          <div className="session-unavailable">Loading…</div>
        ) : session?.unavailableReason ? (
          <div className="session-unavailable">{session.unavailableReason}</div>
        ) : messages.length ? (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} source={activeItem?.source} />
            ))}
            <div ref={bottomRef} />
          </>
        ) : props.sessions.length === 0 ? (
          <div className="session-unavailable">No sessions for this repo.</div>
        ) : (
          <div className="session-unavailable">No messages in this session.</div>
        )}
      </div>
    </div>
  );
}

// ── Comments tab ──────────────────────────────────────────────────────────────

interface CommentsTabProps {
  comments: ReviewComment[];
  editingId?: string;
  editComment: string;
  editSeverity: CommentSeverity;
  onEdit: (c: ReviewComment) => void;
  onEditCommentChange: (v: string) => void;
  onEditSeverityChange: (v: CommentSeverity) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string) => void;
  onResolve: (c: ReviewComment) => void;
  onReopen: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
}

function CommentsTab(props: CommentsTabProps) {
  const open = props.comments.filter((c) => c.status === 'open');
  const resolved = props.comments.filter((c) => c.status === 'resolved');
  if (!props.comments.length) {
    return <div className="empty-state">No review comments yet. Click + on a diff line.</div>;
  }
  return (
    <div className="comments-tab">
      {open.length > 0 && (
        <section>
          <h3 className="comments-group-title">Open ({open.length})</h3>
          {open.map((c) => (
            <ReviewCommentItem key={c.id} comment={c}
              isEditing={props.editingId === c.id} editComment={props.editComment} editSeverity={props.editSeverity}
              onEdit={() => props.onEdit(c)} onEditCommentChange={props.onEditCommentChange}
              onEditSeverityChange={props.onEditSeverityChange} onCancelEdit={props.onCancelEdit}
              onSaveEdit={() => props.onSaveEdit(c.id)} onResolve={() => props.onResolve(c)}
              onReopen={() => props.onReopen(c)} onDelete={() => props.onDelete(c)} />
          ))}
        </section>
      )}
      {resolved.length > 0 && (
        <section>
          <h3 className="comments-group-title">Resolved ({resolved.length})</h3>
          {resolved.map((c) => (
            <ReviewCommentItem key={c.id} comment={c}
              isEditing={props.editingId === c.id} editComment={props.editComment} editSeverity={props.editSeverity}
              onEdit={() => props.onEdit(c)} onEditCommentChange={props.onEditCommentChange}
              onEditSeverityChange={props.onEditSeverityChange} onCancelEdit={props.onCancelEdit}
              onSaveEdit={() => props.onSaveEdit(c.id)} onResolve={() => props.onResolve(c)}
              onReopen={() => props.onReopen(c)} onDelete={() => props.onDelete(c)} />
          ))}
        </section>
      )}
    </div>
  );
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

interface DiffViewerProps {
  file: DiffFile; comments: ReviewComment[]; activeTarget?: CommentTarget;
  draftComment: string; draftSeverity: CommentSeverity; editingId?: string;
  editComment: string; editSeverity: CommentSeverity;
  onStartComment: (t: CommentTarget) => void; onCancelDraft: () => void;
  onDraftCommentChange: (v: string) => void; onDraftSeverityChange: (v: CommentSeverity) => void;
  onSaveDraft: () => void; onEdit: (c: ReviewComment) => void;
  onEditCommentChange: (v: string) => void; onEditSeverityChange: (v: CommentSeverity) => void;
  onCancelEdit: () => void; onSaveEdit: (id: string) => void;
  onResolve: (c: ReviewComment) => void; onReopen: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
}

function DiffViewer(props: DiffViewerProps) {
  const stats = getFileStats(props.file);
  const fc = props.comments.filter((c) => commentMatchesFile(c, props.file));
  return (
    <div className="diff-card">
      <div className="diff-card-header">
        <div className="file-heading">
          <span className="file-icon" />
          <code>{displayPath(props.file)}</code>
        </div>
        <div className="file-heading-meta">
          <span className={`src-badge src-${props.file.source}`}>{sourceLabel(props.file.source)}</span>
          <span className="adds">+{stats.additions}</span>
          <span className="dels">−{stats.deletions}</span>
          {fc.length ? <span className="muted">{fc.length} comments</span> : null}
        </div>
      </div>

      {props.file.hunks.map((hunk) => (
        <div className="hunk" key={hunk.id}>
          <div className="hunk-header"><span /><span /><span /><code>{hunk.header}</code></div>
          {hunk.lines.map((line) => {
            const target = commentTargetForLine(props.file, hunk, line);
            const lineComments = target ? props.comments.filter((c) => sameCommentLocation(c, target)) : [];
            const draftHere = target && props.activeTarget ? sameCommentLocation(props.activeTarget, target) : false;
            return (
              <div className="line-block" key={line.id}>
                <div className={`diff-line diff-${line.type}`}>
                  <div className="ln old">{line.oldLine ?? ''}</div>
                  <div className="ln new">{line.newLine ?? ''}</div>
                  <div className="line-action">
                    {target ? (
                      <button className="comment-btn" title="Add comment" onClick={() => props.onStartComment(target)}>+</button>
                    ) : null}
                  </div>
                  <pre><span className="diff-pfx">{prefixFor(line)}</span>{line.content}</pre>
                </div>
                {lineComments.map((c) => (
                  <ReviewCommentItem key={c.id} comment={c}
                    isEditing={props.editingId === c.id} editComment={props.editComment} editSeverity={props.editSeverity}
                    onEdit={() => props.onEdit(c)} onEditCommentChange={props.onEditCommentChange}
                    onEditSeverityChange={props.onEditSeverityChange} onCancelEdit={props.onCancelEdit}
                    onSaveEdit={() => props.onSaveEdit(c.id)} onResolve={() => props.onResolve(c)}
                    onReopen={() => props.onReopen(c)} onDelete={() => props.onDelete(c)} />
                ))}
                {draftHere && (
                  <CommentEditor comment={props.draftComment} severity={props.draftSeverity}
                    onCommentChange={props.onDraftCommentChange} onSeverityChange={props.onDraftSeverityChange}
                    onCancel={props.onCancelDraft} onSave={props.onSaveDraft} saveLabel="Comment" />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Review comment item ───────────────────────────────────────────────────────

interface ReviewCommentItemProps {
  comment: ReviewComment; isEditing: boolean; editComment: string; editSeverity: CommentSeverity;
  onEdit: () => void; onEditCommentChange: (v: string) => void; onEditSeverityChange: (v: CommentSeverity) => void;
  onCancelEdit: () => void; onSaveEdit: () => void;
  onResolve: () => void; onReopen: () => void; onDelete: () => void;
}

function ReviewCommentItem(props: ReviewCommentItemProps) {
  const { comment } = props;
  const cls = `review-comment${comment.status === 'resolved' ? ' resolved' : ''}`;
  if (props.isEditing) {
    return (
      <div className={cls}>
        <CommentEditor comment={props.editComment} severity={props.editSeverity}
          onCommentChange={props.onEditCommentChange} onSeverityChange={props.onEditSeverityChange}
          onCancel={props.onCancelEdit} onSave={props.onSaveEdit} saveLabel="Save" />
      </div>
    );
  }
  return (
    <div className={cls}>
      <div className="comment-header">
        <div className="comment-header-left">
          <span className={`sev-badge sev-${comment.severity}`}>{comment.severity}</span>
          <span className="comment-loc">{comment.file}:{comment.line}</span>
        </div>
        <span className={`status-badge status-${comment.status}`}>{comment.status}</span>
      </div>
      {comment.selectedCode && <pre className="selected-code">{comment.selectedCode}</pre>}
      <p className="comment-body">{comment.comment}</p>
      <div className="comment-actions">
        <button className="text-btn" onClick={props.onEdit}>Edit</button>
        {comment.status === 'open'
          ? <button className="text-btn" onClick={props.onResolve}>Resolve</button>
          : <button className="text-btn" onClick={props.onReopen}>Reopen</button>}
        <button className="text-btn danger" onClick={props.onDelete}>Delete</button>
      </div>
    </div>
  );
}

// ── Comment editor ────────────────────────────────────────────────────────────

interface CommentEditorProps {
  comment: string; severity: CommentSeverity; saveLabel: string;
  onCommentChange: (v: string) => void; onSeverityChange: (v: CommentSeverity) => void;
  onCancel: () => void; onSave: () => void;
}

function CommentEditor(props: CommentEditorProps) {
  return (
    <div className="comment-editor">
      <div className="comment-editor-toolbar">
        <select value={props.severity} onChange={(e) => props.onSeverityChange(e.target.value as CommentSeverity)}>
          {severityOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <textarea value={props.comment} onChange={(e) => props.onCommentChange(e.target.value)} placeholder="Leave a review comment" autoFocus />
      <div className="comment-editor-actions">
        <button className="hbtn hbtn-primary" onClick={props.onSave} disabled={!props.comment.trim()}>{props.saveLabel}</button>
        <button className="hbtn" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function commentTargetForLine(file: DiffFile, hunk: DiffHunk, line: DiffLine): CommentTarget | undefined {
  if (line.type === 'add' && typeof line.newLine === 'number')
    return { file: displayPath(file), side: 'new', line: line.newLine, hunkHeader: hunk.header, selectedCode: line.content };
  if (line.type === 'remove' && typeof line.oldLine === 'number')
    return { file: file.oldPath, side: 'old', line: line.oldLine, hunkHeader: hunk.header, selectedCode: line.content };
  return undefined;
}

function sameCommentLocation(left: CommentTarget | ReviewComment, right: CommentTarget): boolean {
  return left.file === right.file && left.side === right.side && left.line === right.line && left.hunkHeader === right.hunkHeader;
}

function commentMatchesFile(comment: ReviewComment, file: DiffFile): boolean {
  return comment.file === displayPath(file) || comment.file === file.oldPath || comment.file === file.newPath;
}

function displayPath(file: DiffFile): string {
  return file.newPath === '/dev/null' ? file.oldPath : file.newPath;
}

function prefixFor(line: DiffLine): string {
  return line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
}

function getFileStats(file: DiffFile): DiffStats {
  return file.hunks.reduce<DiffStats>((s, hunk) => {
    for (const l of hunk.lines) {
      if (l.type === 'add') s.additions++;
      if (l.type === 'remove') s.deletions++;
    }
    s.hunks++;
    return s;
  }, { additions: 0, deletions: 0, files: 1, hunks: 0 });
}

function getDiffStats(files: DiffFile[]): DiffStats {
  return files.reduce<DiffStats>((t, f) => {
    const s = getFileStats(f);
    t.additions += s.additions; t.deletions += s.deletions; t.hunks += s.hunks;
    return t;
  }, { additions: 0, deletions: 0, files: files.length, hunks: 0 });
}

function sourceLabel(s: DiffSource): string {
  return s === 'staged' ? 'staged' : s === 'untracked' ? 'new' : 'modified';
}

function shortDate(value: string): string {
  try {
    const d = new Date(value);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
  } catch { return value; }
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  } catch { return value; }
}

async function api<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data as T;
}

function msgFor(e: unknown): string {
  return e instanceof Error ? e.message : 'Unexpected error.';
}
