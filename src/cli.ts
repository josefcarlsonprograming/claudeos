/**
 * ClaudeOS CLI — manage the sessions ClaudeOS watches. Writes to the same
 * data/cockpit.db the Electron app reads.
 *
 *   node dist/cli.js launch   <repo> <title> <prompt...>     # new isolated worktree + Claude Code session
 *   node dist/cli.js register <repo> <title> <worktree> <branch>  # watch an already-running session
 *   node dist/cli.js list                                    # show known sessions + live state
 */
import * as fs from "fs";
import * as path from "path";
import { openDb, allSessions, purgeDemoArtifacts } from "./core/db";
import { SessionManager } from "./core/sessions";
import {
  listAccounts,
  snapshotCurrent,
  switchTo as accountSwitchTo,
  removeAccount,
} from "./core/accounts";

function requireGitRepo(repo: string): string {
  const abs = path.resolve(repo);
  if (!fs.existsSync(abs)) {
    console.error(`error: repo path does not exist: ${abs}\n(give a real path to a git repository, e.g. ~/code/my-project)`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(abs, ".git"))) {
    console.error(`error: not a git repository (no .git): ${abs}`);
    process.exit(2);
  }
  return abs;
}

function usage(): never {
  console.log(
    `ClaudeOS CLI
  launch     <repo> <title> <prompt...>
  register   <repo> <title> <worktreePath> <branch>
  list
  account    add <label>            (snapshot the current ~/.claude.json under <label>)
  account    list                   (show known snapshots + which is active)
  account    switch <label>         (swap ~/.claude.json to <label>'s snapshot)
  account    remove <label>         (delete a snapshot)`
  );
  process.exit(1);
}

function fmtKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
function fmtAge(mtimeMs: number): string {
  const s = Math.floor((Date.now() - mtimeMs) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const [cmd, ...rest] = process.argv.slice(2);
const db = openDb();
const sm = new SessionManager(db);

if (cmd === "launch") {
  const [repo, title, ...promptParts] = rest;
  if (!repo || !title || !promptParts.length) usage();
  const id = sm.launch({ repo: requireGitRepo(repo), title, prompt: promptParts.join(" ") });
  const s = sm.list().find((x) => x.id === id)!;
  console.log(`launched session #${s.slot} "${title}"`);
  console.log(`  worktree: ${s.worktree_path}`);
  console.log(`  attach:   ${sm.attachCommand(s)}`);
} else if (cmd === "register") {
  const [repo, title, worktreePath, branch] = rest;
  if (!repo || !title || !worktreePath || !branch) usage();
  const id = sm.register({ repo: requireGitRepo(repo), title, worktreePath: path.resolve(worktreePath), branch });
  console.log(`registered session #${id} "${title}" -> ${worktreePath}`);
} else if (cmd === "list") {
  for (const s of allSessions(db))
    console.log(`#${s.slot}\t${s.state.padEnd(14)}\t${s.title}\t${s.worktree_path}`);
} else if (cmd === "purge-demo") {
  const r = purgeDemoArtifacts(db);
  console.log(`purged ${r.sessions} stale demo-worktrees sessions and ${r.projectDirs} transcript dirs`);
} else if (cmd === "account") {
  const [sub, label] = rest;
  if (sub === "add") {
    if (!label) {
      console.error(`error: account add needs a <label>, e.g. \`account add josef\``);
      process.exit(2);
    }
    try {
      const a = snapshotCurrent(label);
      console.log(`snapshot saved: ${a.label}  (${fmtKB(a.size)} at ${a.snapshotPath})`);
      console.log(`tip: log into the next account with \`claude logout && claude login\`, then \`account add <other-label>\`.`);
    } catch (e: any) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
  } else if (sub === "list") {
    const { accounts, activeLabel } = listAccounts();
    if (!accounts.length) {
      console.log(`no account snapshots yet — run \`account add <label>\` to capture the current ~/.claude.json.`);
    } else {
      console.log(`known accounts (active = *):`);
      for (const a of accounts) {
        const star = a.label === activeLabel ? "*" : " ";
        console.log(`  ${star} ${a.label.padEnd(20)}  ${fmtKB(a.size).padStart(10)}  captured ${fmtAge(a.mtimeMs)}`);
      }
    }
  } else if (sub === "switch") {
    if (!label) {
      console.error(`error: account switch needs a <label>, e.g. \`account switch hello\``);
      process.exit(2);
    }
    try {
      const prev = accountSwitchTo(label);
      console.log(`switched ~/.claude.json: ${prev ?? "(none)"} -> ${label}`);
      console.log(`new \`claude -p\` invocations will use the swapped credentials. Already-running sessions keep their own auth until they next call out.`);
    } catch (e: any) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
  } else if (sub === "remove") {
    if (!label) {
      console.error(`error: account remove needs a <label>`);
      process.exit(2);
    }
    removeAccount(label);
    console.log(`removed snapshot: ${label}`);
  } else {
    usage();
  }
} else {
  usage();
}
