import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  ApiError,
  dashboardApi,
  type Approval,
  type AuditEvent,
  type EvidenceRequest,
  type EvidencePack,
  type ExecutionResultPreview,
  type Project,
  type RepairRecord,
  type RuntimeHealth,
  type Task,
  type TaskStatus
} from "./api.js";

interface TaskDetails {
  readonly audit: AuditEvent[];
  readonly packs: EvidencePack[];
  readonly evidenceRequests: EvidenceRequest[];
  readonly executionResults: ExecutionResultPreview[];
  readonly repairRecords: RepairRecord[];
  readonly approvals: Approval[];
}

const EMPTY_DETAILS: TaskDetails = {
  audit: [],
  packs: [],
  evidenceRequests: [],
  executionResults: [],
  repairRecords: [],
  approvals: []
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  CREATED: "已创建",
  INTAKING: "整理任务",
  GATHERING_EVIDENCE: "收集证据",
  PLANNED: "已规划",
  AWAITING_EXECUTION_APPROVAL: "等待执行审批",
  EXECUTING: "执行中",
  EVIDENCE_GAP: "证据不足",
  VALIDATING: "验证中",
  REVIEWING: "审查中",
  AWAITING_HUMAN_APPROVAL: "等待人工决定",
  COMPLETED: "已完成",
  REJECTED: "已拒绝",
  FAILED: "失败",
  CANCELLED: "已取消",
  INTERRUPTED: "已中断"
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task>();
  const [details, setDetails] = useState<TaskDetails>(EMPTY_DETAILS);
  const [runtime, setRuntime] = useState<RuntimeHealth>();
  const [memory, setMemory] = useState<RepairRecord[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [connection, setConnection] = useState<"idle" | "connected" | "reconnecting">("idle");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  );

  const loadDetails = useCallback(async (taskId: string): Promise<void> => {
    const [task, audit, packs, evidenceRequests, execution, repair, approvals] = await Promise.all([
      dashboardApi.getTask(taskId),
      dashboardApi.getAudit(taskId),
      dashboardApi.getEvidencePacks(taskId),
      dashboardApi.getEvidenceRequests(taskId),
      dashboardApi.getExecutionResults(taskId),
      dashboardApi.getRepairRecords(taskId),
      dashboardApi.getApprovals(taskId)
    ]);
    setSelectedTask(task);
    setDetails({
      audit,
      packs: packs.packs,
      evidenceRequests: evidenceRequests.requests,
      executionResults: execution.results,
      repairRecords: repair.records,
      approvals: approvals.approvals
    });
  }, []);

  const loadTasks = useCallback(async (projectId: string, preferredTaskId?: string): Promise<void> => {
    const result = await dashboardApi.listProjectTasks(projectId);
    setTasks(result.tasks);
    const nextTask =
      result.tasks.find((task) => task.id === preferredTaskId) ?? result.tasks[0];
    if (nextTask) {
      await loadDetails(nextTask.id);
    } else {
      setSelectedTask(undefined);
      setDetails(EMPTY_DETAILS);
    }
  }, [loadDetails]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const [health, result] = await Promise.all([
        dashboardApi.getHealth(),
        dashboardApi.listProjects()
      ]);
      setRuntime(health);
      setProjects(result.projects);
      const projectId = selectedProjectId ?? result.projects[0]?.id;
      if (!projectId) {
        setSelectedProjectId(undefined);
        setTasks([]);
        setSelectedTask(undefined);
        setDetails(EMPTY_DETAILS);
        return;
      }
      setSelectedProjectId(projectId);
      await loadTasks(projectId, selectedTask?.id);
    } catch (caught) {
      setError(readError(caught));
    } finally {
      setLoading(false);
    }
  }, [loadTasks, selectedProjectId, selectedTask?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedTask) {
      setConnection("idle");
      return undefined;
    }
    const taskId = selectedTask.id;
    setConnection("reconnecting");
    const source = new EventSource(`/tasks/${encodeURIComponent(taskId)}/events`);
    const onSnapshot = (): void => {
      setConnection("connected");
      void loadDetails(taskId).catch((caught: unknown) => setError(readError(caught)));
    };
    source.addEventListener("task_snapshot", onSnapshot);
    source.onerror = () => setConnection("reconnecting");
    return () => {
      source.removeEventListener("task_snapshot", onSnapshot);
      source.close();
    };
  }, [loadDetails, selectedTask?.id]);

  const selectProject = async (projectId: string): Promise<void> => {
    setSelectedProjectId(projectId);
    setError(undefined);
    try {
      await loadTasks(projectId);
    } catch (caught) {
      setError(readError(caught));
    }
  };

  const selectTask = async (taskId: string): Promise<void> => {
    setError(undefined);
    try {
      await loadDetails(taskId);
    } catch (caught) {
      setError(readError(caught));
    }
  };

  const searchMemory = async (): Promise<void> => {
    if (!selectedProject || memoryQuery.trim().length === 0) {
      setMemory([]);
      return;
    }
    setError(undefined);
    try {
      const result = await dashboardApi.getRepairMemory(selectedProject.id, memoryQuery.trim());
      setMemory(result.records);
    } catch (caught) {
      setError(readError(caught));
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">TracePilot · Phase 6 候选实现</p>
          <h1>受控修复看板</h1>
          <p className="subtitle">用一页看清任务证据、修改、验证、审查和人工决定。</p>
        </div>
        <div className="topbar-actions">
          <span className={`connection connection-${connection}`}>
            {connection === "connected" ? "实时同步已连接" : connection === "reconnecting" ? "正在恢复同步" : "未选择任务"}
          </span>
          {runtime ? <RuntimeBadge runtime={runtime.runtime} /> : null}
          <button type="button" className="secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? "正在刷新…" : "刷新数据"}
          </button>
        </div>
      </header>

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      <section className="workspace">
        <aside className="sidebar" aria-label="项目和任务">
          <h2>已登记项目</h2>
          {projects.length === 0 ? (
            <EmptyState text="还没有登记项目。项目登记仍必须通过受控 API/CLI，网页不会扫描本地目录。" />
          ) : (
            <div className="choice-list">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  aria-label={project.name}
                  className={project.id === selectedProjectId ? "choice active" : "choice"}
                  onClick={() => void selectProject(project.id)}
                >
                  <strong>{project.name}</strong>
                  <small>{project.language} · {project.defaultBranch}</small>
                </button>
              ))}
            </div>
          )}

          <h2 className="task-heading">任务</h2>
          <div className="choice-list">
            {tasks.map((task) => (
              <button
                type="button"
                key={task.id}
                className={task.id === selectedTask?.id ? "choice active" : "choice"}
                onClick={() => void selectTask(task.id)}
              >
                <strong>{task.input.objective}</strong>
                <small><StatusBadge status={task.status} /> · {formatDate(task.updatedAt)}</small>
              </button>
            ))}
            {selectedProject && tasks.length === 0 ? <EmptyState text="这个项目还没有任务。" /> : null}
          </div>
        </aside>

        <section className="content" aria-live="polite">
          {selectedProject ? <ProjectSummary project={selectedProject} /> : null}
          {selectedProject ? (
            <CreateTaskForm
              project={selectedProject}
              onCreated={async (task) => {
                setNotice("任务已创建。下一步由受控服务收集证据、规划并审批执行。");
                await loadTasks(selectedProject.id, task.id);
              }}
              onError={(message) => setError(message)}
            />
          ) : null}

          {selectedTask ? (
            <>
              <section className="task-overview">
                <div>
                  <p className="eyebrow">当前任务</p>
                  <h2>{selectedTask.input.objective}</h2>
                  <p>{selectedTask.input.rawSource || "没有附加来源说明"}</p>
                </div>
                <StatusBadge status={selectedTask.status} large />
              </section>

              <GuidedTaskFlow
                task={selectedTask}
                packs={details.packs}
                approvals={details.approvals}
                executionResults={details.executionResults}
                runtime={runtime}
                onChanged={async (message) => {
                  setNotice(message);
                  await loadDetails(selectedTask.id);
                  if (selectedProject) await loadTasks(selectedProject.id, selectedTask.id);
                }}
                onError={(message) => setError(message)}
              />

              <section className="panel-grid">
                <Panel title="任务时间线" description="每次状态变化都会留下不可追加删除的审计记录。">
                  <Timeline events={details.audit} />
                </Panel>
                <Panel title="Evidence Pack" description="每一版证据都是不可变快照；新信息会生成新版本。">
                  <EvidencePacks packs={details.packs} />
                </Panel>
                <Panel title="Diff 与验证" description="只显示服务端保存的受控修改和验证预览。">
                  <ExecutionResults results={details.executionResults} />
                </Panel>
                <Panel title="审查与修复记录" description="Review 先过确定性质量门，才能形成可追溯的 Repair Record。">
                  <RepairRecords records={details.repairRecords} />
                </Panel>
                <Panel title="审批记录" description="执行审批与人工决定都从 SQLite 真源读取。">
                  <Approvals approvals={details.approvals} />
                </Panel>
                <Panel title="Repair Memory" description="仅召回当前项目内已批准且来源链完整的经验。">
                  <div className="memory-search">
                    <input
                      value={memoryQuery}
                      onChange={(event) => setMemoryQuery(event.target.value)}
                      placeholder="输入现象，例如：兼容性失败"
                      aria-label="Repair Memory 查询"
                    />
                    <button type="button" onClick={() => void searchMemory()}>查询</button>
                  </div>
                  <RepairRecords records={memory} emptyText="输入现象后查询已批准的历史经验。" />
                </Panel>
              </section>

              {selectedTask.status === "AWAITING_HUMAN_APPROVAL" ? (
                <HumanApprovalPanel
                  task={selectedTask}
                  onFinished={async (message) => {
                    setNotice(message);
                    await loadDetails(selectedTask.id);
                    if (selectedProject) await loadTasks(selectedProject.id, selectedTask.id);
                  }}
                  onError={(message) => setError(message)}
                />
              ) : null}
            </>
          ) : (
            <EmptyState text="选择一个项目和任务后，这里会显示它的完整修复过程。" />
          )}
        </section>
      </section>
    </main>
  );
}

function ProjectSummary({ project }: { readonly project: Project }) {
  return (
    <section className="project-summary">
      <span>项目</span>
      <strong>{project.name}</strong>
      <span>默认分支 {project.defaultBranch}</span>
      <code>{project.repositoryPath}</code>
    </section>
  );
}

function CreateTaskForm({
  project,
  onCreated,
  onError
}: {
  readonly project: Project;
  readonly onCreated: (task: Task) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const [objective, setObjective] = useState("");
  const [rawSource, setRawSource] = useState("");
  const [riskLevel, setRiskLevel] = useState<Task["input"]["riskLevel"]>("low");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (objective.trim().length === 0 || rawSource.trim().length === 0) {
      onError("请填写要解决的问题和来源说明。");
      return;
    }
    setSubmitting(true);
    try {
      const task = await dashboardApi.createTask(project.id, {
        objective: objective.trim(),
        constraints: [],
        acceptanceCriteria: ["修复完成后，通过项目既有验证命令"],
        riskLevel,
        rawSource: rawSource.trim(),
        origin: "issue"
      });
      setObjective("");
      setRawSource("");
      await onCreated(task);
    } catch (caught) {
      onError(readError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <details className="create-task">
      <summary>新建修复任务</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          要解决什么问题
          <input value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="例如：修复登录后页面空白" />
        </label>
        <label>
          来源说明
          <textarea value={rawSource} onChange={(event) => setRawSource(event.target.value)} placeholder="例如：用户反馈、工单内容或失败现象" rows={3} />
        </label>
        <label>
          风险等级
          <select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as Task["input"]["riskLevel"])}>
            <option value="low">低：局部修复</option>
            <option value="medium">中：需要额外核对</option>
            <option value="high">高：需要更严格审批</option>
          </select>
        </label>
        <button type="submit" disabled={submitting}>{submitting ? "正在创建…" : "创建受控任务"}</button>
      </form>
    </details>
  );
}

/**
 * 逐阶段演示向导。
 *
 * 它只把操作者明确确认的操作转发给既有受控 API：不直接写工作区、不接收
 * 客户端 Diff/验证结果，也不会替代执行审批、质量门或人工最终决定。
 */
function GuidedTaskFlow({
  task,
  packs,
  approvals,
  executionResults,
  runtime,
  onChanged,
  onError
}: {
  readonly task: Task;
  readonly packs: readonly EvidencePack[];
  readonly approvals: readonly Approval[];
  readonly executionResults: readonly ExecutionResultPreview[];
  readonly runtime?: RuntimeHealth;
  readonly onChanged: (message: string) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [rootCause, setRootCause] = useState("");
  const [condition, setCondition] = useState("");
  const [allowedPaths, setAllowedPaths] = useState("src/**, tests/**");
  const [approver, setApprover] = useState("");
  const [approvalDecision, setApprovalDecision] = useState<"approved" | "rejected">("approved");
  const [approvalReason, setApprovalReason] = useState("");

  const latestPack = packs[packs.length - 1];
  const evidenceIds = latestPack
    ? latestPack.evidence.flatMap((item) => typeof item.id === "string" ? [item.id] : [])
    : [];
  const hasConclusion = latestPack !== undefined && latestPack.hypotheses.length > 0;
  const hasApprovedExecutionApproval = approvals.some(
    (approval) =>
      approval.kind === "execution" &&
      approval.decision === "approved" &&
      approval.invalidatedAt === undefined
  );

  const perform = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label);
    try {
      await action();
      await onChanged(label);
    } catch (caught) {
      onError(readError(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const transition = (to: TaskStatus, reason: string): Promise<Task> =>
    dashboardApi.transitionTask(task.id, to, reason);

  let content: ReactNode;
  if (task.status === "CREATED") {
    content = (
      <StepAction
        title="1. 收集受控证据"
        description="将依次进入任务整理和证据收集状态，再由服务端在已登记仓库内收集允许的证据。页面不会扫描或接受任意本地路径。"
        busy={busy}
        action="开始收集证据"
        onClick={() => void perform("已收集第一版受控证据。", async () => {
          await transition("INTAKING", "Dashboard 演示：开始整理任务");
          await transition("GATHERING_EVIDENCE", "Dashboard 演示：开始受控证据收集");
          await dashboardApi.collectEvidence(task.id);
        })}
      />
    );
  } else if (task.status === "GATHERING_EVIDENCE" && !latestPack) {
    content = (
      <StepAction
        title="1. 重新收集受控证据"
        description="前一次收集没有形成 Evidence Pack。请重新执行受控收集；失败时不会伪造证据。"
        busy={busy}
        action="收集证据"
        onClick={() => void perform("已重新执行证据收集。", () => dashboardApi.collectEvidence(task.id).then(() => undefined))}
      />
    );
  } else if (task.status === "GATHERING_EVIDENCE" && !hasConclusion) {
    content = (
      <section className="guided-form">
        <h2>2. 基于现有证据提出计划结论</h2>
        <p>这一步会先写入 Evidence Request，再创建新的 Pack 版本。根因和适用条件只能引用上方 Pack 中已有的 {evidenceIds.length} 条证据，不能在浏览器直接补造证据。</p>
        <label>
          待验证根因
          <textarea value={rootCause} onChange={(event) => setRootCause(event.target.value)} placeholder="例如：状态文件仍保留旧值，导致验证失败" rows={2} />
        </label>
        <label>
          适用条件（可选）
          <input value={condition} onChange={(event) => setCondition(event.target.value)} placeholder="例如：仅适用于当前项目的状态文件" />
        </label>
        <button
          type="button"
          disabled={busy !== undefined || rootCause.trim().length === 0 || evidenceIds.length === 0}
          onClick={() => void perform("已创建引用现有证据的新 Pack 版本。", async () => {
            const request = await dashboardApi.requestEvidenceConclusion(
              task.id,
              "Dashboard 演示需要把已有证据绑定到待验证根因",
              "为后续受控 Plan 提供可追溯的根因和适用条件"
            );
            await dashboardApi.resolveEvidenceConclusion(task.id, request.id, {
              rootCause: { text: rootCause.trim(), confidence: 0.8, evidenceIds },
              applicabilityConditions: condition.trim().length > 0
                ? [{ text: condition.trim(), evidenceIds, required: true }]
                : []
            });
          })}
        >
          {busy ? "正在写入…" : "提交受控结论"}
        </button>
      </section>
    );
  } else if (task.status === "GATHERING_EVIDENCE" && latestPack) {
    content = (
      <section className="guided-form">
        <h2>3. 明确修改范围并记录 Plan</h2>
        <p>修改范围会成为执行审批哈希的一部分。请只填写计划允许修改的相对路径模式；后续 worktree、Diff 和写入器都会再次校验它。</p>
        <label>
          允许修改的路径（逗号分隔）
          <input value={allowedPaths} onChange={(event) => setAllowedPaths(event.target.value)} placeholder="例如：src/**, tests/**" />
        </label>
        <button
          type="button"
          disabled={busy !== undefined || splitAllowedPaths(allowedPaths).length === 0}
          onClick={() => void perform("Plan 已记录，正在等待执行审批。", async () => {
            await transition("PLANNED", "Dashboard 演示：证据已齐备，开始记录 Plan");
            await dashboardApi.recordPlan(task.id, {
              nodes: [{
                id: `dashboard-plan-${task.id}`,
                label: "在批准范围内修复并验证",
                description: "根据当前 Evidence Pack 完成受控修复、验证与独立 Review",
                evidencePackId: latestPack.id,
                evidencePackVersion: latestPack.version
              }],
              allowedPaths: splitAllowedPaths(allowedPaths),
              inputEvidencePackId: latestPack.id,
              inputEvidencePackVersion: latestPack.version
            });
            await transition("AWAITING_EXECUTION_APPROVAL", "Dashboard 演示：Plan 已记录，等待执行审批");
          })}
        >
          {busy ? "正在记录…" : "记录 Plan 并请求执行审批"}
        </button>
      </section>
    );
  } else if (task.status === "PLANNED") {
    content = (
      <StepAction
        title="4. 请求执行审批"
        description="Plan 已记录。下一步会进入等待执行审批状态，不能直接启动 worktree 或 Runtime。"
        busy={busy}
        action="进入执行审批"
        onClick={() => void perform("任务正在等待执行审批。", () => transition("AWAITING_EXECUTION_APPROVAL", "Dashboard 演示：请求执行审批").then(() => undefined))}
      />
    );
  } else if (task.status === "AWAITING_EXECUTION_APPROVAL" && !hasApprovedExecutionApproval) {
    content = (
      <section className="guided-form execution-approval">
        <h2>5. 执行审批</h2>
        <p>审批会绑定当前 Plan、命令白名单和风险等级。拒绝会被明确记录，但不会把任务伪装成已经执行。</p>
        <label>
          审批人
          <input value={approver} onChange={(event) => setApprover(event.target.value)} placeholder="例如：工程负责人" />
        </label>
        <label>
          决定
          <select value={approvalDecision} onChange={(event) => setApprovalDecision(event.target.value as "approved" | "rejected")}>
            <option value="approved">批准受控执行</option>
            <option value="rejected">拒绝执行</option>
          </select>
        </label>
        <label>
          决定说明（可选）
          <textarea value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} rows={2} />
        </label>
        <button
          type="button"
          disabled={busy !== undefined || approver.trim().length === 0}
          onClick={() => void perform(
            approvalDecision === "approved" ? "执行审批已记录。" : "执行拒绝已记录；任务仍停在等待执行审批状态。",
            () => dashboardApi.recordExecutionApproval(task.id, approver.trim(), approvalDecision, approvalReason.trim()).then(() => undefined)
          )}
        >
          {busy ? "正在提交…" : approvalDecision === "approved" ? "记录执行批准" : "记录执行拒绝"}
        </button>
      </section>
    );
  } else if (task.status === "AWAITING_EXECUTION_APPROVAL") {
    content = (
      <StepAction
        title="6. 创建受控 worktree 并开始执行"
        description="服务端会重新计算审批范围哈希并创建外置 worktree；通过后才可进入执行状态。"
        busy={busy}
        action={task.worktreeId ? "开始受控执行" : "创建 worktree 并开始执行"}
        onClick={() => void perform("已进入受控执行阶段。", async () => {
          if (!task.worktreeId) await dashboardApi.createWorktree(task.id);
          await dashboardApi.beginExecution(task.id);
        })}
      />
    );
  } else if (task.status === "EXECUTING" && executionResults.length === 0) {
    content = (
      <section className="guided-actions">
        <h2>7. 受控分析与开发</h2>
        <p>当前 Runtime：<RuntimeBadge runtime={runtime?.runtime ?? "local-command"} />。只有服务端配置的 Runtime 会运行；页面不传递命令、路径、Diff 或验证结果。</p>
        <div className="button-row">
          <button type="button" disabled={busy !== undefined} onClick={() => void perform("分析已完成，请继续受控开发。", () => dashboardApi.runPhase(task.id, "analyze").then(() => undefined))}>
            {busy === "分析已完成，请继续受控开发。" ? "分析中…" : "运行分析"}
          </button>
          <button type="button" disabled={busy !== undefined} onClick={() => void perform("开发与服务端验证已完成。", () => dashboardApi.runPhase(task.id, "develop").then(() => undefined))}>
            {busy === "开发与服务端验证已完成。" ? "开发与验证中…" : "运行受控开发与验证"}
          </button>
        </div>
      </section>
    );
  } else if (task.status === "EXECUTING" && executionResults.length > 0) {
    content = (
      <StepAction
        title="8. 提交独立 Review"
        description="服务端先使用已持久化的受控 Diff 和验证结果，再由 Runtime Review 与确定性质量门决定是否允许进入人工决定。"
        busy={busy}
        action="进入 Review"
        onClick={() => void perform("Review 已完成，已由质量门决定下一状态。", async () => {
          await transition("VALIDATING", "Dashboard 演示：受控验证结果已保存");
          await transition("REVIEWING", "Dashboard 演示：提交独立 Review");
          await dashboardApi.runPhase(task.id, "review");
        })}
      />
    );
  } else if (task.status === "VALIDATING" || task.status === "REVIEWING") {
    content = <EmptyState text="当前正在验证或审查。请等待服务端操作完成；页面不会跨越该安全边界。" />;
  } else if (task.status === "AWAITING_HUMAN_APPROVAL") {
    content = <EmptyState text="Review 已通过质量门。请在下方核对产物后，由人工完成最终决定。" />;
  } else {
    content = <EmptyState text="此任务已经安全收口或因失败停止；请根据时间线和 Repair Record 决定后续处理。" />;
  }

  return (
    <section className="guided-flow">
      <p className="eyebrow">可重复的 UI 演示路径</p>
      <h2>受控修复向导</h2>
      <p className="panel-description">每一步都显式显示并遵守已有安全边界。测试环境可使用明确标注的替身 Runtime；正式修复仍必须配置受治理的 OmpAdapter。</p>
      {content}
    </section>
  );
}

function StepAction({
  title,
  description,
  action,
  busy,
  onClick
}: {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly busy?: string;
  readonly onClick: () => void;
}) {
  return (
    <section className="guided-actions">
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" disabled={busy !== undefined} onClick={onClick}>{busy ? "正在处理…" : action}</button>
    </section>
  );
}

function HumanApprovalPanel({
  task,
  onFinished,
  onError
}: {
  readonly task: Task;
  readonly onFinished: (message: string) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (secret.trim().length === 0) {
      onError("人工审批必须输入本机人类通道凭证。");
      return;
    }
    setSubmitting(true);
    try {
      // 保持 Phase 5 两步协议：挑战绑定任务、决定和最终 Diff；浏览器不能
      // 自行声明审批人，也不能跳过挑战直接把任务设为完成。
      const challenge = await dashboardApi.issueHumanApprovalChallenge(task.id, decision, secret);
      await dashboardApi.submitHumanApproval(task.id, challenge.challengeToken, reason, secret);
      await onFinished(decision === "approved" ? "已记录人工批准，任务和 Repair Record 已由服务端原子收口。" : "已记录人工拒绝，任务已安全收口。");
      setReason("");
    } catch (caught) {
      onError(readError(caught));
    } finally {
      // 凭证只存在于这次交互的内存中；无论成功失败都不保留、不写日志。
      setSecret("");
      setSubmitting(false);
    }
  };

  return (
    <section className="approval-panel">
      <p className="eyebrow">需要人工决定</p>
      <h2>最后确认</h2>
      <p>请先核对上方 Diff、验证和审查结果。此操作会请求一次性挑战，再由服务端核验最终 Diff 后完成决定。</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          决定
          <select value={decision} onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}>
            <option value="approved">批准修复</option>
            <option value="rejected">拒绝修复</option>
          </select>
        </label>
        <label>
          人工审批通道凭证（只保存在本次页面内存）
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
        </label>
        <label>
          决定说明（可选）
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </label>
        <button type="submit" className={decision === "approved" ? "approve" : "reject"} disabled={submitting}>
          {submitting ? "正在提交…" : decision === "approved" ? "确认批准" : "确认拒绝"}
        </button>
      </form>
    </section>
  );
}

function Panel({ title, description, children }: { readonly title: string; readonly description: string; readonly children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="panel-description">{description}</p>
      {children}
    </section>
  );
}

function Timeline({ events }: { readonly events: readonly AuditEvent[] }) {
  if (events.length === 0) return <EmptyState text="这项任务还没有审计事件。" />;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <time>{formatDate(event.recordedAt)}</time>
          <strong>{event.type}</strong>
          <span>{event.fromStatus ? `${event.fromStatus} → ${event.toStatus ?? ""}` : event.reason ?? "已记录"}</span>
        </li>
      ))}
    </ol>
  );
}

function EvidencePacks({ packs }: { readonly packs: readonly EvidencePack[] }) {
  if (packs.length === 0) return <EmptyState text="尚未形成 Evidence Pack。" />;
  return (
    <div className="stack-list">
      {packs.map((pack) => (
        <details key={`${pack.id}-${pack.version}`}>
          <summary>版本 {pack.version} · {pack.evidence.length} 条证据 · {formatDate(pack.createdAt)}</summary>
          <p className="hash">内容哈希：<code>{pack.contentHash}</code></p>
          <Json value={{ hypotheses: pack.hypotheses, constraints: pack.constraints, acceptanceCriteria: pack.acceptanceCriteria, evidence: pack.evidence }} />
        </details>
      ))}
    </div>
  );
}

function ExecutionResults({ results }: { readonly results: readonly ExecutionResultPreview[] }) {
  if (results.length === 0) return <EmptyState text="还没有服务端保存的 Diff 或验证结果。" />;
  return (
    <div className="stack-list">
      {results.map((result) => (
        <details key={result.id}>
          <summary>
            <span className={result.verification.passed ? "pass" : "fail"}>{result.verification.passed ? "验证通过" : "验证失败"}</span>
            {" · "}{result.diff.changedFiles.length} 个文件 · {formatDate(result.createdAt)}
          </summary>
          <p className="hash">Diff 哈希：<code>{result.diff.hash}</code></p>
          <p>变更文件：{result.diff.changedFiles.join("、") || "无"}</p>
          <CodeBlock title={result.diff.truncated ? "Diff 预览（已截断）" : "Diff"} value={result.diff.patchPreview} />
          <CodeBlock title={result.verification.stdoutTruncated ? "验证输出（已截断）" : "验证输出"} value={result.verification.stdoutPreview} />
          {result.verification.stderrPreview ? <CodeBlock title="验证错误输出" value={result.verification.stderrPreview} /> : null}
        </details>
      ))}
    </div>
  );
}

function RepairRecords({ records, emptyText }: { readonly records: readonly RepairRecord[]; readonly emptyText?: string }) {
  if (records.length === 0) return <EmptyState text={emptyText ?? "还没有 Repair Record。"} />;
  return (
    <div className="stack-list">
      {records.map((record) => (
        <details key={record.id}>
          <summary>{String(record.status)} · {record.symptom || "未提供现象"}</summary>
          <p><strong>根因：</strong>{record.rootCause || "尚未形成"}</p>
          <p><strong>修复：</strong>{record.fixSummary || "尚未形成"}</p>
          <ReviewDetails record={record} />
          <Json value={record} />
        </details>
      ))}
    </div>
  );
}

/** 把 Review 的关键决策转成可读信息，原始 JSON 仍保留为技术详情。 */
function ReviewDetails({ record }: { readonly record: RepairRecord }) {
  const review = asRecord(record.reviewResult);
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const failureReasons = Array.isArray(record.failureReasons)
    ? record.failureReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  if (!review && failureReasons.length === 0) return null;
  return (
    <section className="review-details">
      {typeof review?.verdict === "string" ? <p><strong>Review 裁决：</strong>{review.verdict}</p> : null}
      {findings.length > 0 ? (
        <ul>
          {findings.map((finding, index) => {
            const item = asRecord(finding);
            return (
              <li key={`${record.id}-finding-${index}`}>
                <strong>{typeof item?.priority === "string" ? item.priority : "未标注优先级"}</strong>
                {typeof item?.category === "string" ? ` · ${item.category}` : ""}
                {typeof item?.confidence === "number" ? ` · 置信度 ${item.confidence}` : ""}
                {typeof item?.locator === "string" ? ` · ${item.locator}` : ""}
                <span>{typeof item?.message === "string" ? item.message : "finding 内容无法解析"}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {failureReasons.length > 0 ? (
        <div>
          <strong>质量门原因：</strong>
          <ul>{failureReasons.map((reason) => <li key={`${record.id}-${reason}`}>{reason}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function Approvals({ approvals }: { readonly approvals: readonly Approval[] }) {
  if (approvals.length === 0) return <EmptyState text="尚无审批记录。" />;
  return (
    <ul className="approval-list">
      {approvals.map((approval) => (
        <li key={approval.id}>
          <strong>{approval.kind === "human" ? "人工决定" : "执行审批"}</strong>
          <span className={approval.decision === "approved" ? "pass" : "fail"}>{approval.decision === "approved" ? "已批准" : "已拒绝"}</span>
          <small>{approval.approver} · {formatDate(approval.approvedAt)}{approval.invalidatedAt ? " · 已失效" : ""}</small>
        </li>
      ))}
    </ul>
  );
}

function RuntimeBadge({ runtime }: { readonly runtime: RuntimeHealth["runtime"] }) {
  const label =
    runtime === "omp"
      ? "Omp 运行时"
      : runtime === "test-override"
        ? "测试替身运行时"
        : "明确降级运行时";
  return <span className={`runtime runtime-${runtime}`}>{label}</span>;
}

function StatusBadge({ status, large = false }: { readonly status: TaskStatus; readonly large?: boolean }) {
  return <span className={`status status-${status.toLowerCase()}${large ? " status-large" : ""}`}>{STATUS_LABELS[status]}</span>;
}

function CodeBlock({ title, value }: { readonly title: string; readonly value: string }) {
  return (
    <div className="code-section">
      <p>{title}</p>
      <pre>{value || "（空）"}</pre>
    </div>
  );
}

function Json({ value }: { readonly value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

function EmptyState({ text }: { readonly text: string }) {
  return <p className="empty">{text}</p>;
}

function readError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "发生未知错误";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

/** 把操作者明确填写的范围拆分为 Plan 的相对路径模式。 */
function splitAllowedPaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
