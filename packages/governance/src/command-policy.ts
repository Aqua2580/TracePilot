/**
 * CommandPolicy — §7.2。
 *
 * 决定一个提议的 argv 是否可以运行。argv 必须匹配项目
 * 已注册的白名单（lint / typecheck / test / build）。模型输出
 * 绝不会被拼接进 argv —— 此策略只看到由 orchestrator 从
 * 已注册的 CommandSpec 组装的预成型 argv 数组。
 *
 * 依据 §7.2 表的风险分类：
 *   - read/search/LSP/diff/configured-test       → auto_allowed
 *   - modify-worktree / build                    → needs_execution_approval
 *   - delete / deps install / network / migrate  → needs_human_approval
 *   - push / PR / remote / credentials / prod     → denied
 *
 * P1-R04：结构化危险命令判定必须先于项目白名单。否则一旦配置意外或
 * 恶意把危险 argv 登记为 test/lint/typecheck/build，就会绕过默认禁止
 * 规则。结构化判定按 argv[0]/argv[1] 等定位，覆盖任意参数形式。
 */

import type { CommandSpec } from "@tracepilot/core";
import type {
  CommandPolicy,
  CommandPolicyDecision,
  RiskClass
} from "@tracepilot/core";

/**
 * Git 全局选项（带值与不带值）。用于跳过全局选项，定位真正的子命令。
 *
 * P1-R04 §0.2：`git -C <path> push`、`git --git-dir=<path> push` 等
 * 会把子命令后移。我们必须识别这些全局选项并跳过其取值，才能定位
 * 有效子命令。无法安全识别时返回 undefined，由调用方默认拒绝。
 *
 * P1-R04 §0.3/§0.4：`-c`、`--config-env` 及其等号/粘附形式可注入 Git
 * 配置或 alias（如 `-c alias.review=!...` 可执行任意 shell 命令），
 * 不得列入可跳过列表 —— 出现即默认拒绝。同时不得以“包含 `=`”作为
 * 可跳过任意 token 的判断，未知选项（如 `--unknown-option=value`）
 * 必须默认拒绝。
 */
const GIT_GLOBAL_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path"
]);
// 允许以 `--opt=value` 等号形式出现的全局选项（仅这些已知安全选项）。
const GIT_GLOBAL_OPTS_EQ_FORM: ReadonlySet<string> = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path"
]);
// 不带取值的全局选项（出现后直接跳到下一项）。
const GIT_GLOBAL_OPTS_NO_VALUE: ReadonlySet<string> = new Set([
  "--paginate",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--no-optional-locks"
]);

/**
 * 解析 git argv，跳过全局选项，返回有效子命令及其索引。
 *
 * 识别规则：
 * - `-C <path>`、`--git-dir <path>` 等带值选项：跳过选项本身和下一个
 *   token（取值）。
 * - `--git-dir=<path>` 等 `=` 形式：仅当选项名在 GIT_GLOBAL_OPTS_EQ_FORM
 *   登记时才跳过当前 token；未知选项的 `=` 形式一律拒绝。
 * - `--paginate`、`--no-pager` 等不带值选项：仅跳过当前 token。
 * - 遇到 `--`（选项终止符）后的第一个 token 即为子命令。
 * - 遇到第一个非选项 token 即视为子命令。
 *
 * P1-R04 §0.3/§0.4 拒绝规则：
 * - `-c`、`--config-env` 及其粘附/等号形式（如 `-c<key=value>`、
 *   `--config-env=<key>=<envvar>`）一律返回 undefined（默认拒绝），
 *   因为它们可注入 alias 或配置，不能通过仅解析最终子命令安全放行。
 * - 任何未登记的选项（含 `--unknown-option=value`、`-x` 等）返回
 *   undefined（默认拒绝）。
 *
 * 无法安全识别（子命令缺失、带值选项缺少取值）时返回 undefined，由
 * 调用方默认拒绝 —— 这避免把无法解析的 argv 交给白名单自动允许。
 */
function parseGitSubcommand(
  argv: readonly string[]
): { sub: string; subIndex: number } | undefined {
  // argv[0] === "git" 已由调用方保证。
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) return undefined;

    // 选项终止符：其后第一个 token 即子命令。
    if (token === "--") {
      const sub = argv[i + 1];
      if (sub === undefined) return undefined;
      return { sub, subIndex: i + 1 };
    }

    // 非选项 token（不以 - 开头）即子命令。
    if (!token.startsWith("-")) {
      return { sub: token, subIndex: i };
    }

    // P1-R04 §0.3/§0.4：拒绝可注入配置/alias 的选项。
    // `-c`（含粘附形式 `-c<key=value>`）可定义 shell alias，执行任意命令；
    // `--config-env`（含 `=` 形式）可读取环境变量注入配置。
    // 这两类选项不能用“仅解析最终子命令”的方式安全放行，出现即拒绝。
    // 注意：`-c` 小写，不会误伤 `-C` 大写（大小写敏感）。
    if (token === "-c" || token.startsWith("-c")) {
      return undefined;
    }
    if (token === "--config-env" || token.startsWith("--config-env")) {
      return undefined;
    }

    // 等号形式的带值选项：仅当选项名在登记列表中才跳过；否则拒绝。
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const optName = token.slice(0, eqIdx);
      if (GIT_GLOBAL_OPTS_EQ_FORM.has(optName)) {
        i += 1;
        continue;
      }
      // 未登记的 = 形式选项（如 --unknown-option=value）默认拒绝。
      return undefined;
    }

    // 带值选项：跳过选项 + 取值。
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(token)) {
      const value = argv[i + 1];
      if (value === undefined) return undefined; // 缺少取值，无法安全解析。
      i += 2;
      continue;
    }

    // 不带值选项：仅跳过当前 token。
    if (GIT_GLOBAL_OPTS_NO_VALUE.has(token)) {
      i += 1;
      continue;
    }

    // 未知选项形式（如 -x、--unknown）。无法安全识别，默认拒绝。
    return undefined;
  }

  // 没有子命令（只有 git + 全局选项）。
  return undefined;
}

/**
 * 结构化危险命令判定。先于白名单执行，确保危险操作无论是否被登记为
 * 项目命令都按 §7.2 默认规则处理。
 *
 * 返回 `undefined` 表示该 argv 不属于结构化危险命令，应继续走白名单。
 */
function classifyStructuredDangerous(
  argv: readonly string[]
): CommandPolicyDecision | undefined {
  if (argv.length === 0) return undefined;
  const head = argv[0];

  // —— Git 危险子命令（先解析全局选项，再定位有效子命令） ——
  if (head === "git") {
    // P1-R04 §0.2：Git 全局选项会把真正子命令后移到 argv[2]/argv[3]…，
    // 例如 `git -C D:/x push`、`git --git-dir=D:/x/.git push`。若只读
    // argv[1]，这些命令会绕过 push 默认禁止、worktree 删除限制等。
    // 因此先跳过全局选项，定位有效子命令；无法安全识别时默认拒绝。
    const parsed = parseGitSubcommand(argv);
    if (!parsed) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "无法安全解析 git 全局选项与有效子命令，默认拒绝（§7.2、§12.4）"
      };
    }
    const { sub, subIndex } = parsed;
    const action = argv[subIndex + 1];

    // §7.2：push 必须默认禁止，无论是否带 remote/branch 参数。
    if (sub === "push") {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git push 默认禁止（§7.2），不得经白名单或全局选项绕过"
      };
    }
    // §7.2：merge 默认禁止。
    if (sub === "merge") {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git merge 默认禁止（§7.2），不得经白名单或全局选项绕过"
      };
    }
    // §7.2：rebase 默认禁止（改写历史）。
    if (sub === "rebase") {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git rebase 默认禁止（§7.2），不得经白名单或全局选项绕过"
      };
    }
    // §7.2：reset --hard 默认禁止（破坏工作区）。
    if (sub === "reset" && argv.includes("--hard")) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git reset --hard 默认禁止（§7.2），不得经白名单或全局选项绕过"
      };
    }
    // §7.2：clean -fd 默认禁止（删除未跟踪文件）。
    if (sub === "clean" && (argv.includes("-f") || argv.includes("-fd") || argv.includes("-df"))) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git clean -f 默认禁止（§7.2），不得经白名单或全局选项绕过"
      };
    }
    // 凭据读取：config 读取凭据、credential 命令。
    if (sub === "config" && argv.some((a) => a.includes("credential"))) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git config 涉及凭据读取，默认禁止（§7.2、§12.4）"
      };
    }
    if (sub === "credential") {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git credential 默认禁止（§7.2、§12.4）"
      };
    }
    // 远程命令：git remote set-url / git push --force 等已由 push 分支覆盖。
    if (sub === "remote" && (argv.includes("set-url") || argv.includes("remove") || argv.includes("rename"))) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "git remote 配置修改默认禁止（§7.2）"
      };
    }

    // P1-R03 / P1-R04：worktree 子命令结构化判定。
    if (sub === "worktree") {
      // remove / prune 是删除性操作，可能删除未登记工作区。
      // §7.1：只能清理数据库登记且位于受控根目录的目录；
      // §7.2：删除操作必须逐次人工审批。命令层默认拒绝，清理由
      // WorktreeManager 在校验登记 + 受控根目录 + 终态 + 人工审批后执行。
      if (action === "remove" || action === "prune") {
        return {
          allowed: false,
          riskClass: "denied",
          reason: `git worktree ${action} 是删除性操作，必须由 WorktreeManager 在校验登记与人工审批后执行（§7.1、§7.2），不得经白名单或全局选项绕过`
        };
      }
      // add 属结构性操作，需执行审批；即使被伪装成 test/lint 白名单，
      // 也只能按 needs_execution_approval 处理，不能返回 auto_allowed。
      // 实际 argv 必须由后续 WorktreeManager 构造，执行审批不替代路径
      // 登记校验。
      if (action === "add") {
        return {
          allowed: true,
          riskClass: "needs_execution_approval",
          reason: "git worktree add 需要执行审批，且必须由受控 Manager 构造 argv（§7.2）；不得经白名单或全局选项降级为 auto_allowed"
        };
      }
      // 其它 worktree 子命令（lock / unlock / move 等）默认拒绝。
      return {
        allowed: false,
        riskClass: "denied",
        reason: `git worktree ${action ?? "<缺失>"} 未在策略白名单中，默认拒绝`
      };
    }
  }

  // —— GitHub CLI 危险操作 ——
  // P1-R04 §0.2 同类问题：gh 全局选项（如 --repo <owner/repo>）会把子命令后移。
  // 扫描 argv 中所有裸 token（不以 - 开头），若出现 "pr" 则拒绝。
  if (head === "gh") {
    for (let i = 1; i < argv.length; i++) {
      const token = argv[i];
      if (token && !token.startsWith("-") && token === "pr") {
        return {
          allowed: false,
          riskClass: "denied",
          reason: "gh pr 操作默认禁止（§7.2），不得经白名单或全局选项绕过"
        };
      }
    }
  }

  // —— 提权与破坏性命令 ——
  if (head === "sudo") {
    return {
      allowed: false,
      riskClass: "denied",
      reason: "sudo 默认禁止（提权，§7.2）"
    };
  }
  // rm -rf / 或 rm -rf /* 等根目录删除。
  if (head === "rm") {
    const hasForce = argv.includes("-rf") || argv.includes("-fr") || argv.includes("-r") && argv.includes("-f");
    const target = argv[argv.length - 1];
    if (hasForce && (target === "/" || target === "/*" || target === "~")) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "rm -rf 根目录删除默认禁止（破坏性，§7.2）"
      };
    }
  }

  // —— 网络抓取工具 ——
  if (head === "curl" || head === "wget") {
    return {
      allowed: false,
      riskClass: "denied",
      reason: `${head} 网络抓取工具默认禁止（§7.2）`
    };
  }

  // —— 远程 shell 操作 ——
  if (head === "ssh" || head === "scp" || head === "rsync") {
    return {
      allowed: false,
      riskClass: "denied",
      reason: `${head} 远程 shell 操作默认禁止（§7.2）`
    };
  }

  // —— 依赖安装（需人工审批，命令层分类为 denied 由审批闸门处理） ——
  // P1-R04 §0.2 同类问题：npm/pnpm/yarn 的全局选项（如 --filter <pkg>、
  // --prefix <path>、--cwd <path>）会把子命令后移。例如：
  //   pnpm --filter <pkg> add <pkg2>
  //   npm --prefix <path> install
  //   yarn --cwd <path> add <pkg>
  // 由于这些工具的全局选项数量庞大且格式复杂（带值/不带值/= 形式混合），
  // 精确解析不现实。采用保守策略：扫描 argv 中所有裸 token（不以 - 开头），
  // 若出现 install/ci/add 则拒绝。这确保无论全局选项如何排列，依赖安装
  // 子命令都不会被白名单绕过。
  if (head === "npm" || head === "pnpm" || head === "yarn") {
    const depSubs = new Set(["install", "ci", "add"]);
    for (let i = 1; i < argv.length; i++) {
      const token = argv[i];
      if (token && !token.startsWith("-") && depSubs.has(token)) {
        return {
          allowed: false,
          riskClass: "denied",
          reason: `${head} ${token} 依赖安装需人工审批（§7.2），不得经白名单或全局选项绕过`
        };
      }
    }
  }

  return undefined;
}

/**
 * 默认实现。使用整个 argv 的数组相等性将提议的 argv 与项目
 * 白名单进行比对。任何不在白名单中的内容
 * 都会被拒绝 —— 绝不存在模糊匹配。
 *
 * P1-R04：结构化危险命令判定先于白名单执行，确保危险操作即使被
 * 意外或恶意登记为项目命令也按默认规则处理。
 */
export class DefaultCommandPolicy implements CommandPolicy {
  decide(
    argv: readonly string[],
    whitelist: {
      readonly lint?: CommandSpec;
      readonly typecheck?: CommandSpec;
      readonly test: CommandSpec;
      readonly build?: CommandSpec;
    }
  ): CommandPolicyDecision {
    if (!Array.isArray(argv) || argv.length === 0) {
      return {
        allowed: false,
        riskClass: "denied",
        reason: "argv must be a non-empty array"
      };
    }

    // P1-R04：结构化危险命令判定优先于白名单。
    // 覆盖任意参数形式的 git push/merge/rebase/reset --hard/clean -f、
    // git worktree remove/prune、gh pr、sudo、rm -rf /、curl/wget、
    // ssh/scp/rsync、依赖安装、凭据读取。即使配置把它们登记为
    // test/lint/typecheck/build，也必须按默认规则处理。
    const dangerous = classifyStructuredDangerous(argv);
    if (dangerous) {
      return dangerous;
    }

    // 然后检查项目白名单。按完整 argv 相等性匹配。
    const candidates: Array<{ spec: CommandSpec; label: string; riskClass: RiskClass }> = [
      { spec: whitelist.test, label: "test", riskClass: "auto_allowed" },
      ...(whitelist.lint ? [{ spec: whitelist.lint, label: "lint", riskClass: "auto_allowed" as const }] : []),
      ...(whitelist.typecheck ? [{ spec: whitelist.typecheck, label: "typecheck", riskClass: "auto_allowed" as const }] : []),
      ...(whitelist.build ? [{ spec: whitelist.build, label: "build", riskClass: "needs_execution_approval" as const }] : [])
    ];

    for (const c of candidates) {
      if (argvEquals(argv, c.spec.argv)) {
        return {
          allowed: true,
          riskClass: c.riskClass,
          reason: `argv matches registered ${c.label} command`
        };
      }
    }

    // 特殊处理 read/search/diff 类的 git 子命令，
    // 依据 §7.2 它们自动允许 —— 这些无需出现在项目白名单中。
    // P1-R04 §0.2：使用 parseGitSubcommand 定位有效子命令，使
    // `git -C <path> log` 也能被正确识别为读取类操作。
    if (argv[0] === "git") {
      const parsed = parseGitSubcommand(argv);
      if (parsed) {
        const { sub } = parsed;
        if (sub === "log" || sub === "show" || sub === "diff" || sub === "blame" ||
            sub === "status" || sub === "ls-files" || sub === "rev-parse") {
          return {
            allowed: true,
            riskClass: "auto_allowed",
            reason: `git ${sub} is a read-only git operation (§7.2 auto-allowed)`
          };
        }
      }
    }

    return {
      allowed: false,
      riskClass: "denied",
      reason: "argv does not match any registered whitelist entry or auto-allowed read operation"
    };
  }
}

function argvEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
