export type TaskStatus =
  | "CREATED"
  | "INTAKING"
  | "GATHERING_EVIDENCE"
  | "PLANNED"
  | "AWAITING_EXECUTION_APPROVAL"
  | "EXECUTING"
  | "EVIDENCE_GAP"
  | "VALIDATING"
  | "REVIEWING"
  | "AWAITING_HUMAN_APPROVAL"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly repositoryPath: string;
  readonly defaultBranch: string;
  readonly language: string;
  readonly createdAt: string;
}

export interface RuntimeHealth {
  readonly status: "ok";
  readonly runtime: "omp" | "local-command" | "test-override";
  readonly store: "SQLite";
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly status: TaskStatus;
  readonly input: {
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly riskLevel: "low" | "medium" | "high";
    readonly rawSource: string;
    readonly origin: "failed_test_log" | "issue";
  };
  readonly currentEvidencePackId?: string;
  readonly currentEvidencePackVersion?: number;
  readonly currentPlanId?: string;
  readonly worktreeId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTransitionReason?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly type: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly reason?: string;
  readonly recordedAt: string;
}

export interface EvidencePack {
  readonly id: string;
  readonly taskId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly evidence: readonly Record<string, unknown>[];
  readonly hypotheses: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
  readonly acceptanceCriteria: readonly string[];
}

export interface EvidenceRequest {
  readonly id: string;
  readonly taskId: string;
  readonly requesterRole: "planner" | "developer" | "reviewer";
  readonly gapReason: string;
  readonly expectedPlanImpact: string;
  readonly requestedAt: string;
}

export interface EvidenceConclusion {
  readonly rootCause: {
    readonly text: string;
    readonly confidence: number;
    readonly evidenceIds: readonly string[];
  };
  readonly applicabilityConditions: readonly {
    readonly text: string;
    readonly evidenceIds: readonly string[];
    readonly required: boolean;
  }[];
}

export interface ExecutionResultPreview {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly diff: {
    readonly hash: string;
    readonly changedFiles: readonly string[];
    readonly bytes: number;
    readonly patchPreview: string;
    readonly truncated: boolean;
  };
  readonly verification: {
    readonly exitCode: number;
    readonly passed: boolean;
    readonly stdoutPreview: string;
    readonly stdoutTruncated: boolean;
    readonly stderrPreview: string;
    readonly stderrTruncated: boolean;
  };
}

export interface Approval {
  readonly id: string;
  readonly kind: "execution" | "human";
  readonly approver: string;
  readonly decision: "approved" | "rejected";
  readonly reason?: string;
  readonly approvedAt: string;
  readonly invalidatedAt?: string;
}

export type RepairRecord = Record<string, unknown> & {
  readonly id: string;
  readonly status: string;
  readonly symptom: string;
  readonly rootCause: string;
  readonly fixSummary: string;
  readonly updatedAt: string;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const text = await response.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export const dashboardApi = {
  getHealth: () => request<RuntimeHealth>("/health"),
  listProjects: () => request<{ projects: Project[] }>("/projects"),
  listProjectTasks: (projectId: string) =>
    request<{ tasks: Task[] }>(`/projects/${encodeURIComponent(projectId)}/tasks`),
  getTask: (taskId: string) => request<Task>(`/tasks/${encodeURIComponent(taskId)}`),
  getAudit: (taskId: string) => request<AuditEvent[]>(`/tasks/${encodeURIComponent(taskId)}/audit`),
  getEvidencePacks: (taskId: string) =>
    request<{ packs: EvidencePack[] }>(`/tasks/${encodeURIComponent(taskId)}/evidence-packs`),
  getEvidenceRequests: (taskId: string) =>
    request<{ requests: EvidenceRequest[] }>(`/tasks/${encodeURIComponent(taskId)}/evidence-requests`),
  getExecutionResults: (taskId: string) =>
    request<{ source: string; results: ExecutionResultPreview[] }>(
      `/tasks/${encodeURIComponent(taskId)}/execution-results`
    ),
  getRepairRecords: (taskId: string) =>
    request<{ records: RepairRecord[] }>(`/tasks/${encodeURIComponent(taskId)}/repair-records`),
  getApprovals: (taskId: string) =>
    request<{ approvals: Approval[] }>(`/tasks/${encodeURIComponent(taskId)}/approvals`),
  getRepairMemory: (projectId: string, symptom: string) =>
    request<{ source: string; records: RepairRecord[] }>(
      `/projects/${encodeURIComponent(projectId)}/repair-memory?${new URLSearchParams({ symptom }).toString()}`
    ),
  createTask: (projectId: string, input: Task["input"]) =>
    request<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, input })
    }),
  transitionTask: (taskId: string, to: TaskStatus, reason: string) =>
    request<Task>(`/tasks/${encodeURIComponent(taskId)}/transition`, {
      method: "POST",
      body: JSON.stringify({ to, reason })
    }),
  collectEvidence: (taskId: string) =>
    request<{ evidenceCount: number; pack: EvidencePack | null }>(
      `/tasks/${encodeURIComponent(taskId)}/collect-evidence`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  requestEvidenceConclusion: (taskId: string, gapReason: string, expectedPlanImpact: string) =>
    request<EvidenceRequest>(`/tasks/${encodeURIComponent(taskId)}/evidence-requests`, {
      method: "POST",
      body: JSON.stringify({ gapReason, expectedPlanImpact })
    }),
  resolveEvidenceConclusion: (taskId: string, requestId: string, conclusion: EvidenceConclusion) =>
    request<EvidencePack>(
      `/tasks/${encodeURIComponent(taskId)}/evidence-requests/${encodeURIComponent(requestId)}/resolve`,
      { method: "POST", body: JSON.stringify(conclusion) }
    ),
  recordPlan: (taskId: string, input: {
    readonly nodes: readonly {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly evidencePackId: string;
      readonly evidencePackVersion: number;
    }[];
    readonly allowedPaths: readonly string[];
    readonly inputEvidencePackId: string;
    readonly inputEvidencePackVersion: number;
  }) => request<Record<string, unknown>>(`/tasks/${encodeURIComponent(taskId)}/plan`, {
    method: "POST",
    body: JSON.stringify(input)
  }),
  recordExecutionApproval: (
    taskId: string,
    approver: string,
    decision: "approved" | "rejected",
    reason: string
  ) => request<Approval>(`/tasks/${encodeURIComponent(taskId)}/approvals`, {
    method: "POST",
    body: JSON.stringify({ approver, decision, reason })
  }),
  createWorktree: (taskId: string) =>
    request<Record<string, unknown>>(`/tasks/${encodeURIComponent(taskId)}/worktrees`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  beginExecution: (taskId: string) =>
    request<Task>(`/tasks/${encodeURIComponent(taskId)}/begin-execution`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  runPhase: (taskId: string, phase: "analyze" | "develop" | "review") =>
    request<Record<string, unknown>>(`/tasks/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
      body: JSON.stringify({ phase })
    }),
  issueHumanApprovalChallenge: (
    taskId: string,
    decision: "approved" | "rejected",
    channelSecret: string
  ) =>
    request<{ challengeToken: string }>(`/tasks/${encodeURIComponent(taskId)}/human-approval/challenge`, {
      method: "POST",
      headers: { "x-tracepilot-human-channel-secret": channelSecret },
      body: JSON.stringify({ decision })
    }),
  submitHumanApproval: (
    taskId: string,
    challengeToken: string,
    reason: string,
    channelSecret: string
  ) =>
    request<{ task: Task }>(`/tasks/${encodeURIComponent(taskId)}/human-approval`, {
      method: "POST",
      headers: { "x-tracepilot-human-channel-secret": channelSecret },
      body: JSON.stringify({ challengeToken, reason })
    })
};
