import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { oneDark as cmOneDark } from '@codemirror/theme-one-dark';
import { getIcon } from 'material-file-icons';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';

type DiffSource = 'staged' | 'unstaged' | 'untracked' | 'committed';
type DiffLineType = 'context' | 'add' | 'remove' | 'meta';
type CommentSide = 'old' | 'new';
type CommentSeverity = 'note' | 'bug' | 'question' | 'nit';
type CommentStatus = 'open' | 'resolved';
type AgentKind = 'codex' | 'claude';
type ActiveTab = 'files' | 'comments' | 'prompt' | 'compare' | `file:${string}` | `commit:${string}`;
interface CommitLogEntry { hash: string; shortHash: string; author: string; email: string; date: string; relativeDate: string; subject: string; }
interface CommitDetail { hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string; files: DiffFile[]; }
interface BranchComparison { base: string; head: string; ahead: number; behind: number; files: DiffFile[]; }

interface SyncStatus { branch: string; upstream: string | null; ahead: number; behind: number; hasRemote: boolean; lastCommit?: { hash: string; subject: string }; }
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
  const [streamingText, setStreamingText] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const [sessionList, setSessionList] = useState<SessionListItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [activeSession, setActiveSession] = useState<CodexSessionResponse | undefined>();
  const [sessionLoading, setSessionLoading] = useState(false);
  const [activeProvider, setActiveProvider] = useState<AgentKind>('claude');
  const [modelList, setModelList] = useState<{ id: string; label: string }[]>([]);
  const [activeModel, setActiveModel] = useState<string>('claude-sonnet-4-6');
  const [activeEffort, setActiveEffort] = useState<string>(() => localStorage.getItem('pr-effort') ?? 'high');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('files');
  const [branches, setBranches] = useState<BranchInfo | undefined>();
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [diffView, setDiffView] = useState<DiffViewMode>(() => (localStorage.getItem('pr-diffview') === 'split' ? 'split' : 'unified'));
  const setDiffViewPersisted = (v: DiffViewMode) => { setDiffView(v); localStorage.setItem('pr-diffview', v); };
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('pr-theme') as 'dark' | 'light') ?? 'dark'
  );
  const [showSession, setShowSession] = useState(true);
  const [repoList, setRepoList] = useState<{ path: string; name: string; current: boolean }[]>([]);
  const [leftTab, setLeftTab] = useState<'files' | 'explorer' | 'history'>('files');
  const [openFileTabs, setOpenFileTabs] = useState<{ path: string; content: string }[]>([]);
  const [pendingReveal, setPendingReveal] = useState<{ path: string; line: number; name?: string; nonce: number } | null>(null);
  const [commitLog, setCommitLog] = useState<CommitLogEntry[]>([]);
  const [commitLogLoading, setCommitLogLoading] = useState(false);
  const [activeCommit, setActiveCommit] = useState<CommitDetail | null>(null);
  const [comparison, setComparison] = useState<BranchComparison | null>(null);
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(320);
  const workspaceRef = useRef<HTMLElement>(null);

  function startDrag(side: 'left' | 'right', e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;
    const onMove = (ev: MouseEvent) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const total = ws.clientWidth;
      const minL = 140, minC = 300, minR = 220;
      if (side === 'left') {
        const next = Math.max(minL, Math.min(startLeft + ev.clientX - startX, total - minC - minR));
        setLeftWidth(next);
      } else {
        const next = Math.max(minR, Math.min(startRight - (ev.clientX - startX), total - minL - minC));
        setRightWidth(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  useEffect(() => {
    // Apply persisted theme immediately (before first paint flash)
    document.documentElement.setAttribute('data-theme', theme);
    void refresh(true);
    void loadBranches();
    void loadSessionList(true);
    void loadModels('claude');
    void loadRepos();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pr-theme', theme);
  }, [theme]);

  // Load commit history when the History tab opens or the branch changes.
  useEffect(() => {
    if (leftTab === 'history') void loadCommitLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftTab, branches?.current]);

  useEffect(() => {
    let inFlight = false;
    const id = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void Promise.all([refresh(false), loadSessionList(false), loadBranches()])
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
  const stagedFiles = useMemo(() => diff?.files.filter((f) => f.source === 'staged') ?? [], [diff]);
  const unstagedFiles = useMemo(() => diff?.files.filter((f) => f.source !== 'staged') ?? [], [diff]);
  const hasStagedChanges = stagedFiles.length > 0;

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
      void loadSyncStatus();
    } catch (e) {
      setError(msgFor(e));
    } finally {
      if (showBusy) setBusy(false);
    }
  }

  async function loadSyncStatus() {
    try { setSyncStatus(await api<SyncStatus>('/api/git/sync-status')); } catch { /* non-fatal */ }
  }

  async function gitSync(op: 'push' | 'pull' | 'fetch') {
    setSyncing(true);
    try {
      const r = await api<{ message: string }>(`/api/git/${op}`, { method: 'POST', body: '{}' });
      flash(r.message ? r.message.split('\n')[0].slice(0, 120) : `${op} complete`);
      await Promise.all([refresh(false), loadSyncStatus(), loadCommitLog()]);
    } catch (e) { setError(msgFor(e)); }
    finally { setSyncing(false); }
  }

  async function loadCommitLog() {
    setCommitLogLoading(true);
    try {
      const r = await api<{ commits: CommitLogEntry[] }>('/api/git/log?limit=80');
      setCommitLog(r.commits);
    } catch (e) { setError(msgFor(e)); }
    finally { setCommitLogLoading(false); }
  }

  async function openCommit(hash: string) {
    try {
      const detail = await api<CommitDetail>(`/api/git/commit?hash=${encodeURIComponent(hash)}`);
      setActiveCommit(detail);
      setActiveTab(`commit:${hash}`);
    } catch (e) { setError(msgFor(e)); }
  }

  // Compare the current branch against a base ref (PR-style diff).
  async function compareWithBranch(base: string) {
    try {
      const c = await api<BranchComparison>(`/api/git/compare?base=${encodeURIComponent(base)}`);
      setComparison(c);
      setActiveTab('compare');
    } catch (e) { setError(msgFor(e)); }
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

  async function loadSession(id: string, { silent = false }: { silent?: boolean } = {}) {
    if (!silent) {
      setSessionLoading(true);
      setActiveSession(undefined);
    }
    try {
      const s = await api<CodexSessionResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      setActiveSession(s);
    } catch (e) {
      if (!silent) setActiveSession({ messages: [], unavailableReason: msgFor(e) });
    } finally {
      if (!silent) setSessionLoading(false);
    }
  }

  function selectSession(id: string) {
    setActiveSessionId(id);
    void loadSession(id);
  }

  async function loadBranches() {
    try { setBranches(await api<BranchInfo>('/api/git/branches')); } catch { /* non-critical */ }
  }

  async function loadRepos() {
    try {
      const r = await api<{ repos: { path: string; name: string; current: boolean }[] }>('/api/repos');
      setRepoList(r.repos);
    } catch { /* non-critical */ }
  }

  async function pickRepo() {
    try {
      const r = await api<{ repoRoot?: string; name?: string; cancelled?: boolean }>('/api/repo/pick', { method: 'POST' });
      if (r.cancelled || !r.repoRoot) return;
      setActiveSessionId(undefined);
      setActiveSession(undefined);
      setAgentOutput('');
      await Promise.all([refresh(true), loadBranches(), loadSessionList(false), loadRepos()]);
      flash(`Switched to ${r.name ?? r.repoRoot}`);
    } catch (e) { setError(msgFor(e)); }
  }

  async function switchRepo(repoPath: string) {
    try {
      await api('/api/repo/switch', { method: 'POST', body: JSON.stringify({ path: repoPath }) });
      // Full reset — new repo means new diff, comments, sessions, branches
      setActiveSessionId(undefined);
      setActiveSession(undefined);
      setAgentOutput('');
      await Promise.all([refresh(true), loadBranches(), loadSessionList(false), loadRepos()]);
      flash(`Switched to ${repoPath.split('/').pop()}`);
    } catch (e) { setError(msgFor(e)); }
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

  // Stage/unstage every file in a group at once.
  async function stageAll(files: DiffFile[], stage: boolean) {
    if (!files.length) return;
    try {
      await api(`/api/git/${stage ? 'stage' : 'unstage'}`, {
        method: 'POST', body: JSON.stringify({ files: files.map(displayPath) })
      });
      await refresh(false);
    } catch (e) { setError(msgFor(e)); }
  }

  // Ask the agent to write a commit message from the staged diff.
  async function generateMessage(): Promise<string | undefined> {
    if (!hasStagedChanges) { flash('Stage files first.'); return; }
    setGeneratingMsg(true);
    try {
      const r = await api<{ message: string }>('/api/git/commit-message', { method: 'POST', body: '{}' });
      if (r.message) setCommitMessage(r.message);
      return r.message;
    } catch (e) { setError(msgFor(e)); }
    finally { setGeneratingMsg(false); }
  }

  const renderFileRow = (file: DiffFile) => {
    const fs = getFileStats(file);
    const fc = comments.filter((c) => commentMatchesFile(c, file));
    const isActive = file.id === selectedFile?.id;
    const staged = file.source === 'staged';
    const path = displayPath(file);
    return (
      <div key={file.id} className={`file-row${isActive ? ' active' : ''}`}>
        <button
          className={`stage-toggle${staged ? ' staged' : ''}`}
          title={staged ? 'Unstage' : 'Stage'}
          onClick={() => staged ? void unstageFile(file) : void stageFile(file)}
        >{staged ? '✓' : '+'}</button>
        <button className="file-row-label" onClick={() => { setSelectedFileId(file.id); setActiveTab('files'); }}>
          <span className="file-name"><FileIcon name={path} />{path.split('/').pop()}</span>
          <span className="file-meta">
            <span className="file-dir">{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</span>
            <span className="adds">+{fs.additions}</span>
            <span className="dels">−{fs.deletions}</span>
            {fc.length ? <span className="comment-count">💬 {fc.length}</span> : null}
          </span>
        </button>
      </div>
    );
  };

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
    if (!customMessage?.trim() && openComments.length === 0) return;
    setBusy(true);
    setAgentRunning(true);
    setStreamingText('');
    setPendingUserMessage(customMessage ?? '');
    const resumingId = activeSessionId;
    const ac = new AbortController();
    abortControllerRef.current = ac;
    try {
      const res = await fetch(`/api/agent/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: customMessage, model: activeModel, sessionId: resumingId, effort: activeEffort }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? `Request failed: ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
              if (data.type === 'chunk' && data.text) {
                console.log('[stream] chunk', data.text.length, 'bytes');
                setStreamingText(prev => prev + data.text);
              } else if (data.type === 'done') {
                if (data.error) setError(data.error);
                break outer;
              }
            } catch { /* malformed event */ }
          }
        }
      }
      const [, sessionsResp] = await Promise.all([
        refresh(false),
        api<{ sessions: SessionListItem[] }>('/api/sessions'),
      ]);
      setSessionList(sessionsResp.sessions);
      if (resumingId) {
        await loadSession(resumingId);
      } else {
        const latest = sessionsResp.sessions.filter(s => s.source === kind)[0];
        if (latest) { setActiveSessionId(latest.id); await loadSession(latest.id); }
      }
      setStreamingText('');
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') { /* user cancelled, silent */ }
      else setError(msgFor(e));
      setStreamingText(''); setPendingUserMessage('');
    }
    finally { abortControllerRef.current = null; setBusy(false); setAgentRunning(false); setPendingUserMessage(''); }
  }

  function stopAgent() {
    abortControllerRef.current?.abort();
    // Give the server ~600ms to flush its final output, then reload
    const snapId = activeSessionId;
    setTimeout(() => {
      void (async () => {
        await loadSessionList(false);
        if (snapId) await loadSession(snapId, { silent: true });
      })();
    }, 600);
  }

  async function openFileTab(filePath: string, revealLine?: number, revealName?: string) {
    const tabId: ActiveTab = `file:${filePath}`;
    const reveal = () => { if (revealLine) setPendingReveal({ path: filePath, line: revealLine, name: revealName, nonce: Date.now() }); };
    if (openFileTabs.find(t => t.path === filePath)) {
      setActiveTab(tabId);
      reveal();
      return;
    }
    // Images are previewed via <img>, not read as text.
    if (isImagePath(filePath)) {
      setOpenFileTabs(prev => [...prev, { path: filePath, content: '' }]);
      setActiveTab(tabId);
      return;
    }
    try {
      const data = await api<{ content: string; path: string }>(`/api/repo/file?path=${encodeURIComponent(filePath)}`);
      setOpenFileTabs(prev => [...prev, { path: filePath, content: data.content }]);
      setActiveTab(tabId);
      reveal();
    } catch (e) {
      setError(msgFor(e));
    }
  }

  // Go-to-definition: resolve a symbol to its definition site and jump there.
  async function jumpToSymbol(name: string) {
    try {
      const d = await api<{ matches: { path: string; line: number; text: string }[] }>(
        `/api/repo/definition?name=${encodeURIComponent(name)}`
      );
      const hit = d.matches[0];
      if (!hit) { flash(`No definition found for "${name}"`); return; }
      setLeftTab('explorer');
      await openFileTab(hit.path, hit.line, name);
    } catch (e) {
      setError(msgFor(e));
    }
  }

  function closeFileTab(filePath: string) {
    setOpenFileTabs(prev => {
      const next = prev.filter(t => t.path !== filePath);
      const tabId: ActiveTab = `file:${filePath}`;
      if (activeTab === tabId) {
        const idx = prev.findIndex(t => t.path === filePath);
        const neighbour = next[idx] ?? next[idx - 1];
        setActiveTab(neighbour ? `file:${neighbour.path}` : 'files');
      }
      return next;
    });
  }

  function newSession() {
    setActiveSessionId(undefined);
    setActiveSession(undefined);
    setAgentOutput('');
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
          <RepoSelector
            repos={repoList}
            currentName={repoName}
            onSwitch={(p) => void switchRepo(p)}
            onPick={() => void pickRepo()}
          />
          <BranchSelector
            current={currentBranch}
            branches={branches?.branches ?? [currentBranch]}
            switching={branchSwitching}
            onSwitch={(b) => void switchBranch(b)}
            onCreate={(name) => void createNewBranch(name)}
            onDelete={(name) => void deleteExistingBranch(name)}
            onCompare={(b) => void compareWithBranch(b)}
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
          <button className="hbtn hbtn-icon" onClick={() => void refresh(true)} disabled={busy} title="Refresh">↺</button>
          <button
            className={`hbtn hbtn-icon${showSession ? ' active' : ''}`}
            onClick={() => setShowSession(s => !s)}
            title="Toggle session panel"
          >
            ☰
          </button>
          <button
            className="hbtn hbtn-icon theme-toggle"
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
      <section
        className={`workspace${showSession ? '' : ' session-hidden'}`}
        ref={workspaceRef}
        style={showSession
          ? { gridTemplateColumns: `${leftWidth}px 4px minmax(0,1fr) 4px ${rightWidth}px` }
          : { gridTemplateColumns: `${leftWidth}px 4px minmax(0,1fr)` }}
      >

        {/* Left sidebar */}
        <aside className="file-sidebar" aria-label="Changed files">
          {/* Tab bar */}
          <div className="left-tab-bar">
            <button className={`left-tab${leftTab === 'files' ? ' active' : ''}`} onClick={() => setLeftTab('files')}>
              Files <span className="count-badge">{totalStats.files}</span>
            </button>
            <button className={`left-tab${leftTab === 'explorer' ? ' active' : ''}`} onClick={() => setLeftTab('explorer')}>
              Explorer
            </button>
            <button className={`left-tab${leftTab === 'history' ? ' active' : ''}`} onClick={() => setLeftTab('history')}>
              History
            </button>
          </div>

          {leftTab === 'files' && (
            <>
              <div className="file-list">
                {diff?.files.length ? (
                  <>
                    {stagedFiles.length > 0 && (
                      <div className="file-group">
                        <div className="file-group-header">
                          <span className="file-group-title">Staged <span className="count-badge">{stagedFiles.length}</span></span>
                          <button className="group-action" onClick={() => void stageAll(stagedFiles, false)}>Unstage all</button>
                        </div>
                        {stagedFiles.map(renderFileRow)}
                      </div>
                    )}
                    {unstagedFiles.length > 0 && (
                      <div className="file-group">
                        <div className="file-group-header">
                          <span className="file-group-title">Changes <span className="count-badge">{unstagedFiles.length}</span></span>
                          <button className="group-action" onClick={() => void stageAll(unstagedFiles, true)}>Stage all</button>
                        </div>
                        {unstagedFiles.map(renderFileRow)}
                      </div>
                    )}
                  </>
                ) : <p className="empty-hint">No local diff.</p>}
              </div>
              <div className="commit-panel">
                <textarea className="commit-input" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Commit message…" rows={3} />
                <div className="commit-actions">
                  <button className="commit-gen-btn" onClick={() => void generateMessage()} disabled={generatingMsg || busy || !hasStagedChanges} title="Generate a commit message from staged changes">
                    {generatingMsg ? 'Generating…' : '✨ Generate'}
                  </button>
                  <button className="commit-btn" onClick={() => void commit()} disabled={busy || generatingMsg || !commitMessage.trim() || !hasStagedChanges}>
                    Commit
                  </button>
                </div>
                {!hasStagedChanges && !!diff?.files.length && <p className="commit-hint">Stage files to commit.</p>}

                {/* Remote sync — push / pull / fetch + ahead-behind */}
                <div className="sync-bar">
                  <div className="sync-status">
                    {!syncStatus?.hasRemote ? <span className="muted">no remote</span>
                      : !syncStatus.upstream ? <span className="muted">no upstream — Push to set</span>
                      : (syncStatus.ahead === 0 && syncStatus.behind === 0)
                        ? <span className="sync-clean" title={syncStatus.upstream}>✓ {syncStatus.upstream}</span>
                        : (
                          <span className="sync-counts" title={syncStatus.upstream}>
                            {syncStatus.behind > 0 && <span className="sync-behind">↓{syncStatus.behind}</span>}
                            {syncStatus.ahead > 0 && <span className="sync-ahead">↑{syncStatus.ahead}</span>}
                          </span>
                        )}
                  </div>
                  <div className="sync-actions">
                    <button className="sync-btn" onClick={() => void gitSync('pull')} disabled={syncing || !syncStatus?.upstream} title="Pull">⤓{syncStatus?.behind ? ` ${syncStatus.behind}` : ''}</button>
                    <button className="sync-btn" onClick={() => void gitSync('fetch')} disabled={syncing || !syncStatus?.hasRemote} title="Fetch">⟳</button>
                    <button className="sync-btn sync-push" onClick={() => void gitSync('push')} disabled={syncing || !syncStatus?.hasRemote} title="Push">⤒{syncStatus?.ahead ? ` ${syncStatus.ahead}` : ''}</button>
                  </div>
                </div>
              </div>
            </>
          )}

          {leftTab === 'explorer' && (
            <RepoExplorer repoRoot={diff?.repo.repoRoot ?? ''} branch={branches?.current ?? diff?.repo.branch} onOpenFile={(p) => void openFileTab(p)} />
          )}

          {leftTab === 'history' && (
            <div className="commit-log">
              {commitLogLoading && commitLog.length === 0
                ? <p className="empty-hint">Loading history…</p>
                : commitLog.length === 0
                  ? <p className="empty-hint">No commits.</p>
                  : commitLog.map(c => (
                    <button
                      key={c.hash}
                      className={`commit-row${activeTab === `commit:${c.hash}` ? ' active' : ''}`}
                      onClick={() => void openCommit(c.hash)}
                      title={`${c.subject}\n${c.author} · ${c.relativeDate}`}
                    >
                      <span className="commit-subject">{c.subject}</span>
                      <span className="commit-meta">
                        <span className="commit-hash">{c.shortHash}</span>
                        <span className="commit-author">{c.author}</span>
                        <span className="commit-date">{c.relativeDate}</span>
                      </span>
                    </button>
                  ))}
            </div>
          )}
        </aside>
        <div className="pane-divider" onMouseDown={(e) => startDrag('left', e)} />

        {/* Center: diff + floating chat */}
        <section className="center-pane" aria-label="Main panel">
          {/* File tabs — at the top, like a normal editor (when any file is open) */}
          {openFileTabs.length > 0 && (
            <div className="file-tab-bar">
              <button
                className={`file-tab-home${!activeTab.startsWith('file:') ? ' active' : ''}`}
                onClick={() => setActiveTab('files')}
                title="Back to changes"
              >Changes</button>
              {openFileTabs.map(ft => (
                <span key={ft.path} className={`file-tab${activeTab === `file:${ft.path}` ? ' active' : ''}`}>
                  <button className="file-tab-label" onClick={() => setActiveTab(`file:${ft.path}`)}>
                    <FileIcon name={ft.path} />
                    {ft.path.split('/').pop()}
                  </button>
                  <button className="file-tab-close" onClick={() => closeFileTab(ft.path)} title="Close">×</button>
                </span>
              ))}
            </div>
          )}

          {/* Stage: file editor when a file tab is active, otherwise the diff/comments/prompt */}
          {activeTab.startsWith('file:') ? (
            <div className="file-editor-content">
              {openFileTabs.map(ft => activeTab === `file:${ft.path}` && (
                isImagePath(ft.path)
                  ? <div key={ft.path} className="image-preview">
                      <img src={`/api/repo/raw?path=${encodeURIComponent(ft.path)}`} alt={ft.path} />
                    </div>
                  : <FileEditor key={ft.path} path={ft.path} content={ft.content}
                      revealLine={pendingReveal?.path === ft.path ? pendingReveal.line : undefined}
                      revealName={pendingReveal?.path === ft.path ? pendingReveal.name : undefined}
                      revealNonce={pendingReveal?.path === ft.path ? pendingReveal.nonce : 0}
                      onJumpSymbol={(name) => void jumpToSymbol(name)}
                      onChange={(val) => setOpenFileTabs(prev => prev.map(t => t.path === ft.path ? { ...t, content: val } : t))} />
              ))}
            </div>
          ) : activeTab.startsWith('commit:') ? (
            <div className="center-content">
              <CommitView detail={activeCommit} viewMode={diffView} onViewModeChange={setDiffViewPersisted} onJumpSymbol={(name) => void jumpToSymbol(name)} />
            </div>
          ) : activeTab === 'compare' ? (
            <div className="center-content">
              <CompareView comparison={comparison} viewMode={diffView} onViewModeChange={setDiffViewPersisted} onJumpSymbol={(name) => void jumpToSymbol(name)} />
            </div>
          ) : (
          <div className="center-content">
            {activeTab === 'files' && (
              <>
                <div className="files-toolbar">
                  <strong>{totalStats.files} files</strong>
                  <span><span className="adds">+{totalStats.additions}</span> <span className="dels">−{totalStats.deletions}</span></span>
                  {diff?.updatedAt ? <span className="muted">{formatDate(diff.updatedAt)}</span> : null}
                  <DiffViewToggle value={diffView} onChange={setDiffViewPersisted} />
                </div>
                {selectedFile ? (
                  <DiffViewer file={selectedFile} comments={comments} activeTarget={activeTarget}
                    draftComment={draftComment} draftSeverity={draftSeverity} editingId={editingId}
                    editComment={editComment} editSeverity={editSeverity}
                    viewMode={diffView}
                    onJumpSymbol={(name) => void jumpToSymbol(name)}
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
          )}

          {/* Bottom: floating chat compose — flex footer, always centered at the bottom */}
          <FloatingCompose
            busy={busy}
            openComments={openComments}
            activeProvider={activeProvider}
            sessionTitle={activeSessionTitle}
            commitMessage={commitMessage}
            onSend={(msg) => void sendToAgent(activeProvider, msg)}
          />
        </section>
        {showSession && <div className="pane-divider" onMouseDown={(e) => startDrag('right', e)} />}

        {/* Right: session browser */}
        {showSession && <aside className="session-sidebar" aria-label="Agent session">
          <SessionPanel
            sessions={sessionList}
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            sessionLoading={sessionLoading}
            activeProvider={activeProvider}
            activeModel={activeModel}
            activeEffort={activeEffort}
            modelList={modelList}
            streamingText={streamingText}
            agentRunning={agentRunning}
            pendingUserMessage={pendingUserMessage}
            onStop={stopAgent}
            onProviderChange={(p) => {
              setActiveProvider(p);
              void loadModels(p);
              const first = sessionList.find(s => s.source === p);
              if (first) {
                setActiveSessionId(first.id);
                void loadSession(first.id);
              } else {
                setActiveSessionId(undefined);
                setActiveSession(undefined);
              }
            }}
            onModelChange={setActiveModel}
            onEffortChange={(e) => { setActiveEffort(e); localStorage.setItem('pr-effort', e); }}
            onSelectSession={selectSession}
            onNewSession={() => void newSession()}
            onRefresh={() => { if (activeSessionId) void loadSession(activeSessionId, { silent: true }); }}
          />
        </aside>}
      </section>
    </main>
  );
}

// ── Branch selector ───────────────────────────────────────────────────────────

// ── Repo selector ─────────────────────────────────────────────────────────────

function RepoSelector({ repos, currentName, onSwitch, onPick }: {
  repos: { path: string; name: string; current: boolean }[];
  currentName: string;
  onSwitch: (path: string) => void;
  onPick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="repo-selector" ref={ref}>
      <button className="repo-btn" onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13">
          <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 010 1.5H4.5a1 1 0 00-1 1v10.5a1 1 0 001 1h8.75a.75.75 0 010 1.5H4.5A2.5 2.5 0 012 13V2.5zm4.75 3.25a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zm0 3a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z"/>
        </svg>
        <span className="repo-btn-name">{currentName}</span>
        <svg viewBox="0 0 10 6" fill="currentColor" width="8" height="8" style={{ opacity: 0.5 }}>
          <path d="M0 0l5 6 5-6z"/>
        </svg>
      </button>
      {open && (
        <div className="repo-dropdown">
          {repos.map(r => (
            <button
              key={r.path}
              className={`repo-item${r.current ? ' active' : ''}`}
              onClick={() => { if (!r.current) onSwitch(r.path); setOpen(false); }}
              title={r.path}
            >
              <span className="repo-item-name">{r.name}</span>
              {r.current && <span className="repo-item-check">✓</span>}
            </button>
          ))}
          <div className="repo-divider" />
          <button className="repo-item repo-add" onClick={() => { onPick(); setOpen(false); }}>
            + Add repository…
          </button>
        </div>
      )}
    </div>
  );
}

// ── Branch selector ────────────────────────────────────────────────────────────

interface BranchSelectorProps {
  current: string;
  branches: string[];
  switching: boolean;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
  onCompare: (branch: string) => void;
}

function BranchSelector({ current, branches, switching, onSwitch, onCreate, onDelete, onCompare }: BranchSelectorProps) {
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
                  <>
                    <button
                      className="branch-compare-btn"
                      title={`Compare ${b} ↔ ${current}`}
                      onClick={(e) => { e.stopPropagation(); onCompare(b); setOpen(false); }}
                    >
                      ⇄
                    </button>
                    <button
                      className="branch-delete-btn"
                      title={`Delete ${b}`}
                      onClick={(e) => { e.stopPropagation(); onDelete(b); }}
                    >
                      ×
                    </button>
                  </>
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
  openComments: ReviewComment[];
  activeProvider: AgentKind;
  sessionTitle?: string;
  commitMessage: string;
  onSend: (msg: string) => void;
}

function FloatingCompose(props: FloatingComposeProps) {
  const [msg, setMsg] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const label = props.activeProvider === 'codex' ? 'Codex' : 'Claude Code';

  function resizeTextarea(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleSend() {
    if (!msg.trim() && props.openComments.length === 0) return;
    props.onSend(msg);
    setMsg('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  const grouped = Object.entries(
    props.openComments.reduce<Record<string, { file: string; lines: number[] }>>((acc, c) => {
      const base = c.file.split('/').pop() ?? c.file;
      const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
      if (!acc[stem]) acc[stem] = { file: c.file, lines: [] };
      acc[stem].lines.push(c.line);
      return acc;
    }, {})
  );

  return (
    <div className="chat-float">
      {grouped.length > 0 && (
        <div className="chat-float-chips">
          {grouped.map(([stem, { file, lines }]) => (
            <span key={stem} className="comment-chip" title={`${file} — lines ${lines.join(', ')}`}>
              <span className="chip-dot" />
              {stem}{lines.length > 1 ? ` (${lines.length})` : `:${lines[0]}`}
            </span>
          ))}
        </div>
      )}
      {props.openComments.length === 0 && props.commitMessage.trim() && !msg && (
        <div className="chat-float-chips">
          <button
            className="chat-float-suggestion"
            onClick={() => setMsg(props.commitMessage.trim())}
            title="Use commit message as instruction"
          >
            💡 {props.commitMessage.trim().slice(0, 60)}{props.commitMessage.trim().length > 60 ? '…' : ''}
          </button>
        </div>
      )}
      <div className="chat-float-input-row">
        <textarea
          ref={textareaRef}
          className="chat-float-input"
          value={msg}
          onChange={(e) => { setMsg(e.target.value); resizeTextarea(e.target); }}
          placeholder={`Ask ${label} to edit your code…`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); }
          }}
        />
        <button className="chat-float-send" disabled={props.busy || (!msg.trim() && props.openComments.length === 0)} onClick={handleSend}>↑</button>
      </div>
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

function groupMessages(messages: CodexSessionMessage[]): CodexSessionMessage[][] {
  const groups: CodexSessionMessage[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (last && last[0].role === msg.role) {
      last.push(msg);
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}

// Markdown renderer for chat messages — fenced code blocks get real syntax
// highlighting instead of plain monospace text.
const markdownComponents: Components = {
  code({ className, children, node, ...rest }) {
    const text = String(children ?? '');
    const match = /language-(\w+)/.exec(className || '');
    const isBlock = !!match || text.includes('\n');
    if (!isBlock) return <code className="md-inline" {...rest}>{children}</code>;
    const lang = match?.[1] ?? 'text';
    return (
      <div className="md-code">
        <span className="md-code-lang">{lang}</span>
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          PreTag="div"
          customStyle={{ margin: 0, background: 'transparent', padding: '10px 12px', fontSize: 12 }}
        >
          {text.replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    );
  },
  // The code component renders its own container, so drop react-markdown's <pre> wrapper.
  pre({ children }) { return <>{children}</>; },
};

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{children}</ReactMarkdown>;
}

function MessageBubble({ msgs, source }: { msgs: CodexSessionMessage[]; source?: 'codex' | 'claude' }) {
  const first = msgs[0];
  const isUser = first.role === 'user';
  const roleLabel = isUser ? 'You' : source === 'claude' ? 'Claude' : 'Codex';
  return (
    <div className={`msg msg-${first.role}`}>
      <div className="msg-header">
        <span className="msg-role">{roleLabel}</span>
        <span className="msg-time">{formatDate(first.timestamp)}</span>
      </div>
      {msgs.map((msg, i) => (
        <div key={msg.id ?? i} className="msg-body">
          {msg.text
            ? isUser
              ? <span className="msg-plain">{msg.text}</span>
              : <Markdown>{msg.text}</Markdown>
            : <em className="msg-empty">(empty)</em>}
        </div>
      ))}
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
  activeEffort: string;
  modelList: { id: string; label: string }[];
  streamingText: string;
  agentRunning: boolean;
  pendingUserMessage: string;
  onStop: () => void;
  onProviderChange: (p: AgentKind) => void;
  onModelChange: (m: string) => void;
  onEffortChange: (e: string) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRefresh: () => void;
}

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra' },
  { value: 'max', label: 'Max' },
];

/** Faster ↔ Smarter reasoning-effort selector (maps to `claude --effort`). Draggable. */
function EffortSlider({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const last = EFFORT_OPTIONS.length - 1;
  const idx = Math.max(0, EFFORT_OPTIONS.findIndex(o => o.value === value));
  const current = EFFORT_OPTIONS[idx] ?? EFFORT_OPTIONS[2];

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    // No "!== value" guard: `value` is captured stale inside the drag closure, so
    // guarding would block dragging back toward the start. onChange is idempotent.
    onChange(EFFORT_OPTIONS[Math.round(ratio * last)].value);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setFromClientX(e.clientX);
    const move = (ev: PointerEvent) => setFromClientX(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); onChange(EFFORT_OPTIONS[idx - 1].value); }
    if (e.key === 'ArrowRight' && idx < last) { e.preventDefault(); onChange(EFFORT_OPTIONS[idx + 1].value); }
  };

  return (
    <div className="effort-row">
      <div className="effort-head">
        <span className="effort-label">Effort <strong>{current.label}</strong></span>
        <span className="effort-ends"><span>Faster</span><span>Smarter</span></span>
      </div>
      <div
        className="effort-track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={idx}
        aria-label="Reasoning effort"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <div className="effort-fill" style={{ width: `${(idx / last) * 100}%` }} />
        {EFFORT_OPTIONS.map((o, i) => (
          <span
            key={o.value}
            className={`effort-dot${i === idx ? ' active' : ''}${i < idx ? ' passed' : ''}`}
            style={{ left: `${(i / last) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function SessionPanel(props: SessionPanelProps) {
  const session = props.activeSession;
  const messages = session?.messages ?? [];
  const activeItem = props.sessions.find((s) => s.id === props.activeSessionId);
  const filtered = props.sessions.filter(s => s.source === props.activeProvider);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // Live elapsed timer while the agent is running (like the Claude Code client).
  const [elapsedMs, setElapsedMs] = useState(0);
  const runStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (!props.agentRunning) return;
    runStartRef.current = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => {
      if (runStartRef.current != null) setElapsedMs(Date.now() - runStartRef.current);
    }, 200);
    return () => window.clearInterval(id);
  }, [props.agentRunning]);

  // Detect manual scroll up
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distFromBottom > 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to bottom unless user scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages.length, props.activeSessionId, props.streamingText, props.agentRunning]);

  // When session changes, always scroll to bottom and reset flag
  useEffect(() => {
    userScrolledUpRef.current = false;
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [props.activeSessionId]);

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
        <button className="new-session-btn" onClick={props.onRefresh} title="Refresh session" disabled={props.sessionLoading}>↻</button>
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

      {/* Reasoning effort (Claude only) */}
      {props.activeProvider === 'claude' && (
        <EffortSlider value={props.activeEffort} onChange={props.onEffortChange} />
      )}

      {/* Meta bar */}
      {activeItem && (
        <div className="session-meta-bar">
          <span className="session-msg-count">{activeItem.messageCount} messages</span>
          {session?.updatedAt && <span className="session-time">{formatDate(session.updatedAt)}</span>}
        </div>
      )}

      {/* Messages — oldest first, scroll to bottom, grouped by consecutive role */}
      <div className="session-messages" ref={scrollContainerRef}>
        {props.sessionLoading ? (
          <div className="session-unavailable">Loading…</div>
        ) : session?.unavailableReason ? (
          <div className="session-unavailable">{session.unavailableReason}</div>
        ) : messages.length || props.agentRunning || props.streamingText ? (
          <>
            {groupMessages(messages).map((group) => (
              <MessageBubble key={group[0].id} msgs={group} source={activeItem?.source} />
            ))}
            {props.pendingUserMessage && (
              <div className="msg msg-user">
                <div className="msg-header">
                  <span className="msg-role">You</span>
                </div>
                <div className="msg-body"><span className="msg-plain">{props.pendingUserMessage}</span></div>
              </div>
            )}
            {(props.agentRunning || props.streamingText) && (
              <div className="msg msg-assistant msg-streaming">
                <div className="msg-header">
                  <span className="msg-role">{props.activeProvider === 'claude' ? 'Claude' : 'Codex'}</span>
                  <span className="msg-timer" title="Reasoning time">
                    {props.agentRunning && <span className="msg-timer-dot" />}
                    {formatElapsed(elapsedMs)}
                  </span>
                </div>
                <div className="msg-body">
                  {props.streamingText
                    ? <Markdown>{props.streamingText}</Markdown>
                    : <span className="thinking-row"><span className="thinking-dots"><span/><span/><span/></span></span>}
                </div>
              </div>
            )}
            {props.agentRunning && (
              <div className="msg-stop-row">
                <button className="msg-stop-btn" onClick={props.onStop}>■ Stop</button>
              </div>
            )}
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

// ── Repo Explorer ─────────────────────────────────────────────────────────────


interface FsNode { name: string; path: string; isDir: false }
interface FsDir  { name: string; path: string; isDir: true; children: Map<string, FsNode | FsDir> }

function buildTree(files: string[]): FsDir {
  const root: FsDir = { name: '', path: '', isDir: true, children: new Map() };
  for (const f of files) {
    const parts = f.split('/');
    let node: FsDir = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join('/');
      const isLast = i === parts.length - 1;
      if (isLast) {
        node.children.set(name, { name, path, isDir: false });
      } else {
        if (!node.children.has(name)) {
          node.children.set(name, { name, path, isDir: true, children: new Map() });
        }
        node = node.children.get(name) as FsDir;
      }
    }
  }
  return root;
}

function sortedChildren(dir: FsDir): (FsNode | FsDir)[] {
  return [...dir.children.values()].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
}

function RepoExplorer({ repoRoot, branch, onOpenFile }: { repoRoot: string; branch?: string; onOpenFile: (path: string) => void }) {
  const [tree, setTree] = useState<FsDir | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Reload the tree when the repo OR the branch changes (different branches
  // track different files).
  useEffect(() => {
    if (!repoRoot) return;
    setLoading(true);
    api<{ files: string[] }>('/api/repo/tree')
      .then(d => setTree(buildTree(d.files)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repoRoot, branch]);

  const toggle = (node: FsNode | FsDir) => {
    if (!node.isDir) { onOpenFile(node.path); return; }
    setExpanded(prev => {
      const s = new Set(prev);
      s.has(node.path) ? s.delete(node.path) : s.add(node.path);
      return s;
    });
  };

  const renderDir = (dir: FsDir, depth: number): React.ReactNode =>
    sortedChildren(dir).map(node => (
      <div key={node.path}>
        <button
          className={`explorer-row${node.isDir ? ' explorer-dir' : ''}`}
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => toggle(node)}
        >
          <span className="explorer-chevron">
            {node.isDir ? (expanded.has(node.path) ? '▾' : '▸') : ''}
          </span>
          {node.isDir
            ? <span className="explorer-icon explorer-folder">{expanded.has(node.path) ? '📂' : '📁'}</span>
            : <FileIcon name={node.name} />}
          <span className="explorer-name">{node.name}</span>
        </button>
        {node.isDir && expanded.has(node.path) && renderDir(node as FsDir, depth + 1)}
      </div>
    ));

  if (loading) return <div className="explorer-loading" style={{ padding: 12 }}>Loading…</div>;
  if (!tree) return null;
  return <div className="explorer-tree">{renderDir(tree, 0)}</div>;
}

/** Renders the inline material SVG icon for a filename. */
function FileIcon({ name }: { name: string }) {
  const svg = useMemo(() => getIcon(name).svg, [name]);
  return <span className="mfi" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * CodeMirror extension: double-click a symbol to jump to its definition.
 * Double-click (rather than single) so normal reading/selecting/cursor placement
 * isn't hijacked. Double-click also naturally selects the word being jumped from.
 */
function goToDefinition(onJump?: (name: string) => void): Extension {
  return EditorView.domEventHandlers({
    dblclick(event, view) {
      if (!onJump) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const word = view.state.wordAt(pos);
      if (!word) return false;
      const name = view.state.sliceDoc(word.from, word.to);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]+$/.test(name)) return false;
      onJump(name);
      return false; // keep the default word-selection
    },
  });
}

interface FileEditorProps {
  path: string;
  content: string;
  onChange: (v: string) => void;
  revealLine?: number;
  revealName?: string;
  revealNonce?: number;
  onJumpSymbol?: (name: string) => void;
}

function FileEditor({ path, content, onChange, revealLine, revealName, revealNonce, onJumpSymbol }: FileEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const extensions = useMemo(() => [...cmLanguage(path), goToDefinition(onJumpSymbol)], [path, onJumpSymbol]);

  // Scroll to + select the jumped-to symbol whenever a reveal is requested.
  // A freshly-mounted editor hasn't measured its layout yet, so scrolling once
  // lands in the wrong place — run after two animation frames so geometry exists.
  useEffect(() => {
    if (!revealLine) return;
    let raf2 = 0;
    const doReveal = () => {
      const view = viewRef.current;
      if (!view) return;
      const lineNo = Math.min(Math.max(revealLine, 1), view.state.doc.lines);
      const info = view.state.doc.line(lineNo);
      // Select the symbol name on the target line (so you see what you landed on);
      // fall back to a cursor at line start if it isn't found.
      let from = info.from;
      let to = info.from;
      if (revealName) {
        const col = info.text.indexOf(revealName);
        if (col >= 0) { from = info.from + col; to = from + revealName.length; }
      }
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      view.focus();
    };
    const raf1 = requestAnimationFrame(() => { doReveal(); raf2 = requestAnimationFrame(doReveal); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [revealLine, revealName, revealNonce]);

  return (
    <CodeMirror
      value={content}
      extensions={extensions}
      theme={cmOneDark}
      onChange={onChange}
      onCreateEditor={(view) => { viewRef.current = view; }}
      style={{ height: '100%', fontSize: 13 }}
      height="100%"
    />
  );
}

// ── Syntax-highlighted hunk ───────────────────────────────────────────────────

/** Double-click a word in a diff to go to its definition (reads the native selection). */
function jumpFromSelection(onJump?: (name: string) => void) {
  if (!onJump) return;
  const sel = window.getSelection?.()?.toString().trim() ?? '';
  if (/^[A-Za-z_$][A-Za-z0-9_$]+$/.test(sel)) onJump(sel);
}

/**
 * Recursively render a Prism hast node. Styles are resolved from the highlighter
 * stylesheet by className (the tokens carry classNames, not inline styles).
 * Note: we do NOT wrap every identifier in its own span — that created thousands
 * of nodes/handlers and made big diffs laggy. Go-to-definition is handled by a
 * single double-click listener on the diff card via the native word selection.
 */
function renderHast(
  node: any,
  key: string,
  stylesheet: Record<string, React.CSSProperties>,
  useInlineStyles: boolean
): React.ReactNode {
  if (node.type === 'text') return node.value ?? '';
  const classNames: string[] = node.properties?.className ?? [];
  const style = useInlineStyles
    ? Object.assign({}, ...classNames.map((c) => stylesheet[c] ?? {}))
    : undefined;
  const className = !useInlineStyles && classNames.length ? classNames.join(' ') : undefined;
  return (
    <span key={key} style={style} className={className}>
      {node.children?.map((c: any, i: number) => renderHast(c, `${key}-${i}`, stylesheet, useInlineStyles))}
    </span>
  );
}

type DiffViewMode = 'unified' | 'split';

interface SplitRow { left?: { line: DiffLine; idx: number }; right?: { line: DiffLine; idx: number }; }

/** Pair a unified hunk's lines into side-by-side rows (removes left, adds right). */
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].type;
    if (t === 'context' || t === 'meta') {
      out.push({ left: { line: lines[i], idx: i }, right: { line: lines[i], idx: i } });
      i++;
      continue;
    }
    const removes: { line: DiffLine; idx: number }[] = [];
    while (i < lines.length && lines[i].type === 'remove') { removes.push({ line: lines[i], idx: i }); i++; }
    const adds: { line: DiffLine; idx: number }[] = [];
    while (i < lines.length && lines[i].type === 'add') { adds.push({ line: lines[i], idx: i }); i++; }
    if (!removes.length && !adds.length) { i++; continue; }
    const n = Math.max(removes.length, adds.length);
    for (let k = 0; k < n; k++) out.push({ left: removes[k], right: adds[k] });
  }
  return out;
}

interface HighlightedHunkProps {
  hunk: DiffHunk; file: DiffFile; comments: ReviewComment[]; activeTarget?: CommentTarget;
  draftComment: string; draftSeverity: CommentSeverity; editingId?: string;
  editComment: string; editSeverity: CommentSeverity;
  readOnly?: boolean;
  viewMode?: DiffViewMode;
  onJumpSymbol?: (name: string) => void;
  onStartComment: (t: CommentTarget) => void; onCancelDraft: () => void;
  onDraftCommentChange: (v: string) => void; onDraftSeverityChange: (v: CommentSeverity) => void;
  onSaveDraft: () => void; onEdit: (c: ReviewComment) => void;
  onEditCommentChange: (v: string) => void; onEditSeverityChange: (v: CommentSeverity) => void;
  onCancelEdit: () => void; onSaveEdit: (id: string) => void;
  onResolve: (c: ReviewComment) => void; onReopen: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
}

function HighlightedHunk(props: HighlightedHunkProps) {
  const { hunk, file } = props;
  const lang = detectLanguage(displayPath(file));
  const code = hunk.lines.map(l => l.content).join('\n');

  const renderer: SyntaxHighlighterProps['renderer'] = ({ rows, stylesheet, useInlineStyles }) => {
    const tokens = (idx: number, content: string): React.ReactNode => {
      const row = rows[idx];
      return row
        ? row.children?.map((node: any, j: number) => renderHast(node, `t${idx}-${j}`, stylesheet, useInlineStyles))
        : content;
    };

    // Comments + draft editor for a row, keyed to its comment target(s). Full width.
    const commentBlock = (targets: (CommentTarget | undefined)[]): React.ReactNode => {
      const tg = targets.filter((t): t is CommentTarget => !!t);
      if (!tg.length) return null;
      const lineComments = props.comments.filter((c) => tg.some((t) => sameCommentLocation(c, t)));
      const draftTarget = props.activeTarget ? tg.find((t) => sameCommentLocation(props.activeTarget!, t)) : undefined;
      return (
        <>
          {lineComments.map((c) => (
            <ReviewCommentItem key={c.id} comment={c}
              isEditing={props.editingId === c.id} editComment={props.editComment} editSeverity={props.editSeverity}
              onEdit={() => props.onEdit(c)} onEditCommentChange={props.onEditCommentChange}
              onEditSeverityChange={props.onEditSeverityChange} onCancelEdit={props.onCancelEdit}
              onSaveEdit={() => props.onSaveEdit(c.id)} onResolve={() => props.onResolve(c)}
              onReopen={() => props.onReopen(c)} onDelete={() => props.onDelete(c)} />
          ))}
          {draftTarget && (
            <CommentEditor comment={props.draftComment} severity={props.draftSeverity}
              onCommentChange={props.onDraftCommentChange} onSeverityChange={props.onDraftSeverityChange}
              onCancel={props.onCancelDraft} onSave={props.onSaveDraft} saveLabel="Comment" />
          )}
        </>
      );
    };

    if (props.viewMode === 'split') {
      return (
        <div className="hunk">
          <div className="hunk-header"><span /><code>{hunk.header}</code></div>
          {buildSplitRows(hunk.lines).map((srow, ri) => {
            const lt = srow.left ? commentTargetForLine(file, hunk, srow.left.line) : undefined;
            const rt = srow.right ? commentTargetForLine(file, hunk, srow.right.line) : undefined;
            return (
              <div className="line-block" key={`s${ri}`}>
                <div className="split-row">
                  <div className={`split-cell ${srow.left ? `diff-${srow.left.line.type}` : 'split-empty'}`}>
                    <div className="ln">{srow.left?.line.oldLine ?? ''}</div>
                    {srow.left && !props.readOnly && lt && (
                      <button className="comment-btn" title="Add comment" onClick={() => props.onStartComment(lt)}>+</button>
                    )}
                    <pre>{srow.left ? tokens(srow.left.idx, srow.left.line.content) : null}</pre>
                  </div>
                  <div className={`split-cell ${srow.right ? `diff-${srow.right.line.type}` : 'split-empty'}`}>
                    <div className="ln">{srow.right?.line.newLine ?? ''}</div>
                    {srow.right && !props.readOnly && rt && (
                      <button className="comment-btn" title="Add comment" onClick={() => props.onStartComment(rt)}>+</button>
                    )}
                    <pre>{srow.right ? tokens(srow.right.idx, srow.right.line.content) : null}</pre>
                  </div>
                </div>
                {commentBlock([lt, rt])}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="hunk">
        <div className="hunk-header"><span /><span /><span /><code>{hunk.header}</code></div>
        {hunk.lines.map((line, i) => {
          const target = commentTargetForLine(file, hunk, line);
          return (
            <div className="line-block" key={line.id}>
              <div className={`diff-line diff-${line.type}`}>
                <div className="ln old">{line.oldLine ?? ''}</div>
                <div className="ln new">{line.newLine ?? ''}</div>
                <div className="line-action">
                  {target && !props.readOnly && <button className="comment-btn" title="Add comment" onClick={() => props.onStartComment(target)}>+</button>}
                </div>
                <pre>
                  <span className="diff-pfx">{prefixFor(line)}</span>
                  {tokens(i, line.content)}
                </pre>
              </div>
              {commentBlock([target])}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <SyntaxHighlighter
      language={lang}
      style={oneDark}
      renderer={renderer}
      PreTag="div"
      useInlineStyles
      customStyle={{ display: 'contents', background: 'none' }}
    >
      {code}
    </SyntaxHighlighter>
  );
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

/** Unified ⇄ Split segmented toggle (GitHub/Bitbucket-style). */
function DiffViewToggle({ value, onChange }: { value: DiffViewMode; onChange: (v: DiffViewMode) => void }) {
  return (
    <div className="diff-view-toggle" role="group" aria-label="Diff view mode">
      <button className={value === 'unified' ? 'active' : ''} onClick={() => onChange('unified')} title="Unified view">Unified</button>
      <button className={value === 'split' ? 'active' : ''} onClick={() => onChange('split')} title="Side-by-side view">Split</button>
    </div>
  );
}

interface DiffViewerProps {
  file: DiffFile; comments: ReviewComment[]; activeTarget?: CommentTarget;
  draftComment: string; draftSeverity: CommentSeverity; editingId?: string;
  editComment: string; editSeverity: CommentSeverity;
  readOnly?: boolean;
  viewMode?: DiffViewMode;
  onJumpSymbol?: (name: string) => void;
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
    <div className="diff-card" onDoubleClick={props.onJumpSymbol ? () => jumpFromSelection(props.onJumpSymbol) : undefined}>
      <div className="diff-card-header">
        <div className="file-heading">
          <FileIcon name={displayPath(props.file)} />
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
        <HighlightedHunk
          key={hunk.id}
          hunk={hunk}
          file={props.file}
          comments={props.comments}
          activeTarget={props.activeTarget}
          readOnly={props.readOnly}
          viewMode={props.viewMode}
          onJumpSymbol={props.onJumpSymbol}
          editingId={props.editingId}
          editComment={props.editComment}
          editSeverity={props.editSeverity}
          draftComment={props.draftComment}
          draftSeverity={props.draftSeverity}
          onStartComment={props.onStartComment}
          onEdit={props.onEdit}
          onEditCommentChange={props.onEditCommentChange}
          onEditSeverityChange={props.onEditSeverityChange}
          onCancelEdit={props.onCancelEdit}
          onSaveEdit={props.onSaveEdit}
          onResolve={props.onResolve}
          onReopen={props.onReopen}
          onDelete={props.onDelete}
          onDraftCommentChange={props.onDraftCommentChange}
          onDraftSeverityChange={props.onDraftSeverityChange}
          onCancelDraft={props.onCancelDraft}
          onSaveDraft={props.onSaveDraft}
        />
      ))}
    </div>
  );
}

// ── Commit detail view (history) ───────────────────────────────────────────────

const NOOP = () => {};
function CommitView({ detail, viewMode, onViewModeChange, onJumpSymbol }: { detail: CommitDetail | null; viewMode?: DiffViewMode; onViewModeChange?: (v: DiffViewMode) => void; onJumpSymbol?: (name: string) => void }) {
  if (!detail) return <div className="empty-state">Loading commit…</div>;
  const totals = getDiffStats(detail.files);
  return (
    <div className="commit-view">
      <div className="commit-view-header">
        <div className="commit-view-title">{detail.subject}
          {onViewModeChange && <DiffViewToggle value={viewMode ?? 'unified'} onChange={onViewModeChange} />}
        </div>
        <div className="commit-view-meta">
          <span className="commit-hash">{detail.shortHash}</span>
          <span>{detail.author}</span>
          {detail.date && <span className="muted">{formatDate(detail.date)}</span>}
          <span className="adds">+{totals.additions}</span>
          <span className="dels">−{totals.deletions}</span>
          <span className="muted">{detail.files.length} files</span>
        </div>
        {detail.body && <pre className="commit-view-body">{detail.body}</pre>}
      </div>
      {detail.files.length === 0
        ? <div className="empty-state">No file changes (merge or empty commit).</div>
        : detail.files.map((file) => (
          <DiffViewer
            key={file.id} file={file} comments={[]} readOnly viewMode={viewMode}
            draftComment="" draftSeverity="bug" editComment="" editSeverity="bug"
            onJumpSymbol={onJumpSymbol}
            onStartComment={NOOP} onCancelDraft={NOOP}
            onDraftCommentChange={NOOP} onDraftSeverityChange={NOOP} onSaveDraft={NOOP}
            onEdit={NOOP} onEditCommentChange={NOOP} onEditSeverityChange={NOOP}
            onCancelEdit={NOOP} onSaveEdit={NOOP}
            onResolve={NOOP} onReopen={NOOP} onDelete={NOOP}
          />
        ))}
    </div>
  );
}

function CompareView({ comparison, viewMode, onViewModeChange, onJumpSymbol }: { comparison: BranchComparison | null; viewMode?: DiffViewMode; onViewModeChange?: (v: DiffViewMode) => void; onJumpSymbol?: (name: string) => void }) {
  if (!comparison) return <div className="empty-state">Loading comparison…</div>;
  const totals = getDiffStats(comparison.files);
  return (
    <div className="commit-view">
      <div className="commit-view-header">
        <div className="commit-view-title">
          <code>{comparison.base}</code> … <code>{comparison.head}</code>
          {onViewModeChange && <DiffViewToggle value={viewMode ?? 'unified'} onChange={onViewModeChange} />}
        </div>
        <div className="commit-view-meta">
          {comparison.ahead > 0 && <span className="sync-ahead">↑{comparison.ahead} ahead</span>}
          {comparison.behind > 0 && <span className="sync-behind">↓{comparison.behind} behind</span>}
          <span className="adds">+{totals.additions}</span>
          <span className="dels">−{totals.deletions}</span>
          <span className="muted">{comparison.files.length} files</span>
        </div>
      </div>
      {comparison.files.length === 0
        ? <div className="empty-state">No differences — <code>{comparison.head}</code> has nothing on top of <code>{comparison.base}</code>.</div>
        : comparison.files.map((file) => (
          <DiffViewer
            key={file.id} file={file} comments={[]} readOnly viewMode={viewMode}
            draftComment="" draftSeverity="bug" editComment="" editSeverity="bug"
            onJumpSymbol={onJumpSymbol}
            onStartComment={NOOP} onCancelDraft={NOOP}
            onDraftCommentChange={NOOP} onDraftSeverityChange={NOOP} onSaveDraft={NOOP}
            onEdit={NOOP} onEditCommentChange={NOOP} onEditSeverityChange={NOOP}
            onCancelEdit={NOOP} onSaveEdit={NOOP}
            onResolve={NOOP} onReopen={NOOP} onDelete={NOOP}
          />
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
  const canSave = !!props.comment.trim();
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) { e.preventDefault(); props.onSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); props.onCancel(); }
  };
  return (
    <div className="comment-editor">
      <div className="comment-editor-toolbar">
        <span className={`sev-dot sev-${props.severity}`} />
        <DropdownSelect
          value={props.severity}
          options={severityOptions.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
          onChange={(v) => props.onSeverityChange(v as CommentSeverity)}
        />
      </div>
      <textarea
        value={props.comment}
        onChange={(e) => props.onCommentChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Leave a review comment…"
        autoFocus
      />
      <div className="comment-editor-actions">
        <button className="comment-submit" onClick={props.onSave} disabled={!canSave}>{props.saveLabel}</button>
        <button className="comment-cancel" onClick={props.onCancel}>Cancel</button>
        <span className="comment-hint">⌘↵ save · Esc cancel</span>
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
  return s === 'staged' ? 'staged' : s === 'untracked' ? 'new' : s === 'committed' ? 'committed' : 'modified';
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

/** Human-readable elapsed time for the live reasoning timer. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'svg',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', cs: 'csharp',
  sh: 'bash', zsh: 'bash', bash: 'bash', fish: 'bash',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sql: 'sql', graphql: 'graphql', proto: 'protobuf',
  dockerfile: 'docker', makefile: 'makefile',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
function isImagePath(filename: string): boolean {
  return IMAGE_EXTS.has(filename.split('.').pop()?.toLowerCase() ?? '');
}

function cmLanguage(filename: string): Extension[] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return [javascript({ jsx: true, typescript: true })];
  if (ext === 'py') return [python()];
  if (ext === 'rs') return [rust()];
  if (ext === 'go') return [go()];
  if (['java', 'kt'].includes(ext)) return [java()];
  if (['css', 'scss', 'less'].includes(ext)) return [css()];
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return [html()];
  if (ext === 'json') return [json()];
  if (['md', 'mdx'].includes(ext)) return [markdown()];
  if (ext === 'sql') return [sql()];
  return [];
}

function detectLanguage(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  if (base.toLowerCase() === 'dockerfile') return 'docker';
  if (base.toLowerCase() === 'makefile') return 'makefile';
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'text';
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
