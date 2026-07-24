import { describe, expect, it } from "vitest";
import { DefaultCommandPolicy } from "../src/command-policy.js";
import type { CommandSpec } from "@tracepilot/core";

function spec(argv: string[], timeoutMs = 5000): CommandSpec {
  return { argv, timeoutMs };
}

const whitelist = {
  test: spec(["pytest", "-x"]),
  lint: spec(["ruff", "check", "."]),
  typecheck: spec(["mypy", "."]),
  build: spec(["python", "-m", "build"])
};

describe("DefaultCommandPolicy", () => {
  const policy = new DefaultCommandPolicy();

  describe("自动允许（§7.2）", () => {
    it("允许已注册的 test 命令并归类为 auto_allowed 风险", () => {
      const d = policy.decide(["pytest", "-x"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });

    it("允许已注册的 lint 命令并归类为 auto_allowed 风险", () => {
      const d = policy.decide(["ruff", "check", "."], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });

    it("允许已注册的 build 命令但归类为 needs_execution_approval", () => {
      const d = policy.decide(["python", "-m", "build"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("needs_execution_approval");
    });

    it("无需白名单条目即允许只读 git 子命令", () => {
      for (const sub of ["log", "show", "diff", "blame", "status", "ls-files", "rev-parse"]) {
        const d = policy.decide(["git", sub], whitelist);
        expect(d.allowed, `git ${sub} 应被自动允许`).toBe(true);
        expect(d.riskClass).toBe("auto_allowed");
      }
    });

    it("允许 git worktree add 并归类为 needs_execution_approval", () => {
      const d = policy.decide(["git", "worktree", "add", "/tmp/x"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("needs_execution_approval");
    });
  });

  // P1-R03：git worktree 的删除性子命令不得泛化放行。
  describe("P1-R03 git worktree 删除性子命令默认拒绝", () => {
    it("拒绝 git worktree remove（可能删除未登记工作区）", () => {
      const d = policy.decide(
        ["git", "worktree", "remove", "D:\\unregistered-worktree"],
        whitelist
      );
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
      expect(d.reason).toMatch(/remove/);
    });

    it("拒绝 git worktree prune", () => {
      const d = policy.decide(["git", "worktree", "prune"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
      expect(d.reason).toMatch(/prune/);
    });

    it("拒绝未登记路径的 worktree remove（即使路径看起来合法）", () => {
      // 命令层不负责路径登记校验，但对 remove 一律拒绝 —— 清理必须由
      // WorktreeManager 在校验数据库登记 + 受控根目录 + 终态 + 人工审批
      // 后执行，不能经通用命令策略放行。
      const d = policy.decide(
        ["git", "worktree", "remove", "/registered/looking/path"],
        whitelist
      );
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("git worktree 未带子命令时默认拒绝", () => {
      const d = policy.decide(["git", "worktree"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("git worktree 未知子命令默认拒绝", () => {
      const d = policy.decide(["git", "worktree", "lock", "/tmp/x"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });
  });

  // P1-R04：危险命令结构化判定必须优先于项目白名单。
  // 即使 test/lint/typecheck/build 白名单故意或恶意登记了相同 argv，
  // 也必须按 §7.2 默认规则处理，不得返回 auto_allowed。
  describe("P1-R04 危险命令不得经白名单绕过（对抗性测试）", () => {
    const dangerousArgv: Array<{ argv: string[]; label: string }> = [
      { argv: ["git", "push", "origin", "main"], label: "git push origin main" },
      { argv: ["git", "push"], label: "git push" },
      { argv: ["git", "merge", "feature"], label: "git merge feature" },
      { argv: ["git", "rebase", "main"], label: "git rebase main" },
      { argv: ["git", "reset", "--hard", "HEAD~1"], label: "git reset --hard" },
      { argv: ["git", "clean", "-fd"], label: "git clean -fd" },
      { argv: ["git", "worktree", "remove", "D:/x"], label: "git worktree remove" },
      { argv: ["git", "worktree", "prune"], label: "git worktree prune" },
      { argv: ["git", "config", "credential.helper", "store"], label: "git config credential" },
      { argv: ["git", "credential", "fill"], label: "git credential" },
      { argv: ["git", "remote", "set-url", "origin", "https://x"], label: "git remote set-url" },
      { argv: ["gh", "pr", "merge", "123"], label: "gh pr merge" },
      { argv: ["sudo", "rm", "-rf", "/"], label: "sudo" },
      { argv: ["curl", "http://x"], label: "curl" },
      { argv: ["wget", "http://x"], label: "wget" },
      { argv: ["ssh", "host"], label: "ssh" },
      { argv: ["scp", "file", "host:/x"], label: "scp" },
      { argv: ["rsync", "-a", "src/", "host:/x"], label: "rsync" },
      { argv: ["npm", "install"], label: "npm install" },
      { argv: ["pnpm", "add", "pkg"], label: "pnpm add" },
      { argv: ["yarn", "install"], label: "yarn install" }
    ];

    // 对每个危险 argv，分别把它登记为 test/lint/typecheck/build 白名单，
    // 策略仍必须返回 denied（不得因白名单匹配而放行）。
    for (const { argv, label } of dangerousArgv) {
      it(`test 白名单登记 ${label} 仍返回 denied`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          test: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`lint 白名单登记 ${label} 仍返回 denied`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          lint: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`typecheck 白名单登记 ${label} 仍返回 denied`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          typecheck: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`build 白名单登记 ${label} 仍返回 denied`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          build: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });
    }

    it("git worktree add 即使被伪装为 test 白名单也只返回 needs_execution_approval（不降级为 auto_allowed）", () => {
      const argv = ["git", "worktree", "add", "/tmp/x"];
      const maliciousWhitelist = {
        ...whitelist,
        test: spec([...argv])
      };
      const d = policy.decide(argv, maliciousWhitelist);
      // worktree add 允许进入执行审批闸门，但不得因白名单匹配而降级为 auto_allowed。
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("needs_execution_approval");
      expect(d.riskClass).not.toBe("auto_allowed");
    });

    it("git worktree add 被伪装为 lint/typecheck/build 白名单同样只返回 needs_execution_approval", () => {
      const argv = ["git", "worktree", "add", "/tmp/x"];
      for (const key of ["lint", "typecheck", "build"] as const) {
        const maliciousWhitelist = {
          ...whitelist,
          [key]: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(true);
        expect(d.riskClass).toBe("needs_execution_approval");
        expect(d.riskClass).not.toBe("auto_allowed");
      }
    });
  });

  // P1-R04 §0.2：Git 全局选项会把真正子命令后移到 argv[2]/argv[3]…，
  // 必须先解析全局选项再定位有效子命令，否则会绕过 push 默认禁止、
  // worktree 删除限制等。以下测试覆盖即使把带全局选项的危险 argv
  // 登记为 test/lint/typecheck/build 白名单，也必须按默认规则处理。
  describe("P1-R04 §0.2 Git 全局选项不得绕过危险命令判定（对抗性测试）", () => {
    const globalOptBypassCases: Array<{ argv: string[]; label: string; expectDenied: boolean }> = [
      // 带全局选项的 push —— 必须 denied。
      { argv: ["git", "-C", "D:/user-repo", "push", "origin", "main"], label: "git -C <path> push", expectDenied: true },
      { argv: ["git", "--git-dir=D:/user-repo/.git", "push", "origin", "main"], label: "git --git-dir=<path> push", expectDenied: true },
      { argv: ["git", "-c", "core.bare=false", "push", "origin", "main"], label: "git -c <name=value> push", expectDenied: true },
      // 带全局选项的 worktree remove/prune —— 必须 denied。
      { argv: ["git", "-C", "D:/user-repo", "worktree", "remove", "D:/x"], label: "git -C <path> worktree remove", expectDenied: true },
      { argv: ["git", "-C", "D:/user-repo", "worktree", "prune"], label: "git -C <path> worktree prune", expectDenied: true },
      // 带全局选项的 merge/rebase/reset --hard —— 必须 denied。
      { argv: ["git", "-C", "D:/x", "merge", "feature"], label: "git -C <path> merge", expectDenied: true },
      { argv: ["git", "-C", "D:/x", "rebase", "main"], label: "git -C <path> rebase", expectDenied: true },
      { argv: ["git", "-C", "D:/x", "reset", "--hard", "HEAD~1"], label: "git -C <path> reset --hard", expectDenied: true },
      // 带全局选项的 worktree add —— 只能 needs_execution_approval，不得降级。
      { argv: ["git", "-C", "D:/user-repo", "worktree", "add", "D:/x"], label: "git -C <path> worktree add", expectDenied: false }
    ];

    for (const { argv, label, expectDenied } of globalOptBypassCases) {
      it(`${label} 不带白名单时按默认规则处理`, () => {
        const d = policy.decide(argv, whitelist);
        if (expectDenied) {
          expect(d.allowed).toBe(false);
          expect(d.riskClass).toBe("denied");
        } else {
          // worktree add：允许进入执行审批闸门，但不得 auto_allowed。
          expect(d.allowed).toBe(true);
          expect(d.riskClass).toBe("needs_execution_approval");
        }
      });

      it(`${label} 被登记为 test 白名单仍按默认规则处理`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          test: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        if (expectDenied) {
          expect(d.allowed).toBe(false);
          expect(d.riskClass).toBe("denied");
        } else {
          expect(d.allowed).toBe(true);
          expect(d.riskClass).toBe("needs_execution_approval");
          expect(d.riskClass).not.toBe("auto_allowed");
        }
      });

      it(`${label} 被登记为 lint 白名单仍按默认规则处理`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          lint: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        if (expectDenied) {
          expect(d.allowed).toBe(false);
          expect(d.riskClass).toBe("denied");
        } else {
          expect(d.allowed).toBe(true);
          expect(d.riskClass).toBe("needs_execution_approval");
          expect(d.riskClass).not.toBe("auto_allowed");
        }
      });

      it(`${label} 被登记为 typecheck 白名单仍按默认规则处理`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          typecheck: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        if (expectDenied) {
          expect(d.allowed).toBe(false);
          expect(d.riskClass).toBe("denied");
        } else {
          expect(d.allowed).toBe(true);
          expect(d.riskClass).toBe("needs_execution_approval");
          expect(d.riskClass).not.toBe("auto_allowed");
        }
      });

      it(`${label} 被登记为 build 白名单仍按默认规则处理`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          build: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        if (expectDenied) {
          expect(d.allowed).toBe(false);
          expect(d.riskClass).toBe("denied");
        } else {
          expect(d.allowed).toBe(true);
          expect(d.riskClass).toBe("needs_execution_approval");
          expect(d.riskClass).not.toBe("auto_allowed");
        }
      });
    }

    it("git -C <path> log 仍被正确识别为读取类操作（auto_allowed）", () => {
      const d = policy.decide(["git", "-C", "D:/x", "log", "--oneline"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });

    it("git --git-dir=<path> status 仍被正确识别为读取类操作", () => {
      const d = policy.decide(["git", "--git-dir=D:/x/.git", "status"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });

    it("git 带未知全局选项时默认拒绝（不交给白名单）", () => {
      const d = policy.decide(["git", "--unknown-option", "log"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("git -C 缺少取值时默认拒绝", () => {
      const d = policy.decide(["git", "-C"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });
  });

  // P1-R04 §0.2 同类问题：npm/pnpm/yarn/gh 的全局选项也会把子命令后移，
  // 必须扫描整个 argv 中的裸子命令 token，防止 --filter/--prefix/--repo
  // 等选项绕过依赖安装禁止和 gh pr 禁止。
  describe("P1-R04 §0.2 同类：npm/pnpm/yarn/gh 全局选项不得绕过危险命令判定", () => {
    const globalOptCases: Array<{ argv: string[]; label: string }> = [
      // pnpm --filter <pkg> add <pkg2>
      { argv: ["pnpm", "--filter", "@scope/pkg", "add", "lodash"], label: "pnpm --filter <pkg> add" },
      // pnpm --filter <pkg> install
      { argv: ["pnpm", "--filter", "@scope/pkg", "install"], label: "pnpm --filter <pkg> install" },
      // npm --prefix <path> install
      { argv: ["npm", "--prefix", "D:/x", "install"], label: "npm --prefix <path> install" },
      // npm --prefix <path> ci
      { argv: ["npm", "--prefix", "D:/x", "ci"], label: "npm --prefix <path> ci" },
      // yarn --cwd <path> add <pkg>
      { argv: ["yarn", "--cwd", "D:/x", "add", "lodash"], label: "yarn --cwd <path> add" },
      // yarn --cwd <path> install
      { argv: ["yarn", "--cwd", "D:/x", "install"], label: "yarn --cwd <path> install" },
      // gh --repo <owner/repo> pr merge <num>
      { argv: ["gh", "--repo", "owner/repo", "pr", "merge", "123"], label: "gh --repo <owner/repo> pr merge" },
      // gh --repo <owner/repo> pr create
      { argv: ["gh", "--repo", "owner/repo", "pr", "create"], label: "gh --repo <owner/repo> pr create" }
    ];

    for (const { argv, label } of globalOptCases) {
      it(`${label} 不带白名单时默认拒绝`, () => {
        const d = policy.decide(argv, whitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 test 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          test: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 lint 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          lint: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 typecheck 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          typecheck: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 build 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          build: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });
    }
  });

  // P1-R04 §0.3/§0.4：parseGitSubcommand 不得以“包含 =”跳过任意 token，
  // 也不得把 -c 当作可跳过的全局选项。-c 可注入 alias（执行任意 shell
  // 命令），--config-env 可注入配置/读取环境变量，未知 = 形式选项必须
  // 默认拒绝。以下测试覆盖报告 §0.3/§0.4 列出的三条 argv，即使被登记
  // 为 test/lint/typecheck/build 白名单也必须返回 denied。
  describe("P1-R04 §0.3/§0.4 配置注入与未知选项不得绕过危险命令判定", () => {
    const injectionCases: Array<{ argv: string[]; label: string }> = [
      // 未知 = 形式选项：不得以“包含 =”跳过。
      { argv: ["git", "--unknown-option=value", "log"], label: "git --unknown-option=value log" },
      // -c 注入 alias（可执行任意 shell 命令）。
      { argv: ["git", "-c", "alias.review=!echo TRACEPILOT_ALIAS_EXECUTED", "review"], label: "git -c alias.review=!echo ... review" },
      // -c 粘附形式注入 alias。
      { argv: ["git", "-calias.review=!echo TRACEPILOT_ALIAS_EXECUTED", "review"], label: "git -calias.review=!echo ... review" },
      // --config-env 注入配置（读取环境变量）。
      { argv: ["git", "--config-env", "core.askpass=MY_ASKPASS", "log"], label: "git --config-env <key>=<envvar> log" },
      // --config-env= 形式。
      { argv: ["git", "--config-env=core.askpass=MY_ASKPASS", "log"], label: "git --config-env=<key>=<envvar> log" }
    ];

    for (const { argv, label } of injectionCases) {
      it(`${label} 不带白名单时默认拒绝`, () => {
        const d = policy.decide(argv, whitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 test 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          test: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 lint 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          lint: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 typecheck 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          typecheck: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });

      it(`${label} 被登记为 build 白名单仍拒绝`, () => {
        const maliciousWhitelist = {
          ...whitelist,
          build: spec([...argv])
        };
        const d = policy.decide(argv, maliciousWhitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      });
    }

    it("git -C <path> log 仍被正确识别为读取类操作（auto_allowed）—— 确保未误伤合法 -C", () => {
      const d = policy.decide(["git", "-C", "D:/x", "log", "--oneline"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });

    it("git --git-dir=<path> status 仍被正确识别为读取类操作 —— 确保未误伤合法 = 形式", () => {
      const d = policy.decide(["git", "--git-dir=D:/x/.git", "status"], whitelist);
      expect(d.allowed).toBe(true);
      expect(d.riskClass).toBe("auto_allowed");
    });
  });

  describe("拒绝（§7.2 默认拒绝列表）", () => {
    it("拒绝 git push", () => {
      const d = policy.decide(["git", "push"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
      expect(d.reason).toMatch(/push/i);
    });

    it("拒绝 git merge", () => {
      const d = policy.decide(["git", "merge", "main"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("拒绝 gh pr 操作", () => {
      const d = policy.decide(["gh", "pr", "merge", "123"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("拒绝 sudo", () => {
      const d = policy.decide(["sudo", "rm", "-rf", "/"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });

    it("拒绝网络抓取工具", () => {
      for (const argv of [["curl", "http://x"], ["wget", "http://x"]]) {
        const d = policy.decide(argv, whitelist);
        expect(d.allowed).toBe(false);
        expect(d.riskClass).toBe("denied");
      }
    });

    it("拒绝 npm install（需人工审批——分类）", () => {
      const d = policy.decide(["npm", "install"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });
  });

  describe("不在白名单且未被自动允许", () => {
    it("拒绝未注册的任意命令", () => {
      const d = policy.decide(["rm", "-rf", "src/"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
      expect(d.reason).toMatch(/whitelist/);
    });

    it("拒绝与 test 命令近似的情况（多了一个 flag）", () => {
      const d = policy.decide(["pytest", "-x", "--malicious"], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });
  });

  describe("argv 形状校验", () => {
    it("拒绝空 argv", () => {
      const d = policy.decide([], whitelist);
      expect(d.allowed).toBe(false);
      expect(d.riskClass).toBe("denied");
    });
  });
});
