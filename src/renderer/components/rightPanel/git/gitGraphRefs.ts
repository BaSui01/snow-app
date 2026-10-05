import type { GitLogEntry, GitWorktreeInfo } from "../../../../preload";

/** A single ref decoration attached to a commit row. */
export interface ParsedRef {
  kind: "local" | "remote" | "tag";
  /** Display name: branch name, `origin/xxx` for remotes, tag name. */
  name: string;
  /** True when the checked-out HEAD points at this commit. */
  isHead: boolean;
}

const HEAD_ARROW = "HEAD -> ";
const HEADS_PREFIX = "refs/heads/";
const REMOTES_PREFIX = "refs/remotes/";
const TAGS_PREFIX = "refs/tags/";

/**
 * Parses a commit's decoration string (`%D` with `--decorate=full`, e.g.
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1") into
 * typed refs so local branches, remote-tracking branches and tags can be
 * badged distinctly. Short-form decorations (without the refs/ prefixes)
 * are tolerated as a fallback and treated as local branches.
 */
export function parseRefs(refs: string): ParsedRef[] {
  const parsed: ParsedRef[] = [];
  if (!refs) {
    return parsed;
  }

  for (const rawPart of refs.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    // Detached HEAD decorates as a bare "HEAD".
    if (part === "HEAD") {
      parsed.push({ kind: "local", name: "HEAD", isHead: true });
      continue;
    }

    let body = part;
    let isHead = false;
    if (part.startsWith(HEAD_ARROW)) {
      isHead = true;
      body = part.slice(HEAD_ARROW.length).trim();
    }

    if (body.startsWith(HEADS_PREFIX)) {
      parsed.push({
        kind: "local",
        name: body.slice(HEADS_PREFIX.length),
        isHead,
      });
    } else if (body.startsWith(REMOTES_PREFIX)) {
      parsed.push({
        kind: "remote",
        name: body.slice(REMOTES_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith(TAGS_PREFIX)) {
      parsed.push({
        kind: "tag",
        name: body.slice(TAGS_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith("tag: ")) {
      parsed.push({ kind: "tag", name: body.slice(5).trim(), isHead: false });
    } else if (body) {
      parsed.push({ kind: "local", name: body, isHead });
    }
  }

  return parsed;
}

/** Stable per-worktree accent, independent of the topology lane assignment. */
export function getWorktreeColor(worktree: GitWorktreeInfo): string {
  const identity =
    worktree.worktreeId || worktree.branchName || worktree.headOid;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 78% 62%)`;
}

/** Match only true local branch refs, or detached worktrees at their HEAD commit. */
export function getCommitWorktrees(
  commit: GitLogEntry,
  refs: ParsedRef[],
  worktrees: GitWorktreeInfo[],
): GitWorktreeInfo[] {
  const localBranches = new Set(
    refs
      .filter((ref) => ref.kind === "local" && ref.name !== "HEAD")
      .map((ref) => ref.name),
  );
  const oid = commit.hash.toLowerCase();
  return worktrees.filter((worktree) =>
    worktree.isDetached
      ? worktree.headOid.toLowerCase() === oid
      : !!worktree.branchName && localBranches.has(worktree.branchName),
  );
}

/**
 * Color only edges that are reachable from exactly one loaded worktree tip.
 * Shared ancestry and edges outside the loaded history retain lane colors.
 */
export function getWorktreeEdgeColors(
  commits: GitLogEntry[],
  worktrees: GitWorktreeInfo[],
): Map<string, string> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const memberships = new Map<string, Set<string>>();

  for (const worktree of worktrees) {
    const tips = commits.filter(
      (commit) =>
        getCommitWorktrees(commit, parseRefs(commit.refs), [worktree]).length >
        0,
    );
    // Without every worktree tip in the loaded window, uniqueness cannot be
    // established: an unseen tip may also reach any edge we would color.
    if (tips.length === 0) return new Map();

    const visited = new Set<string>();
    const pending = tips.map((tip) => tip.hash);

    while (pending.length > 0) {
      const childHash = pending.pop()!;
      if (visited.has(childHash)) continue;
      visited.add(childHash);
      const child = byHash.get(childHash);
      if (!child) continue;

      for (const parentHash of child.parents) {
        if (!byHash.has(parentHash)) continue;
        const edgeKey = `${childHash}\0${parentHash}`;
        const edgeMembership = memberships.get(edgeKey) ?? new Set<string>();
        edgeMembership.add(worktree.worktreeId);
        memberships.set(edgeKey, edgeMembership);
        pending.push(parentHash);
      }
    }
  }

  const colors = new Map<string, string>();
  for (const [edgeKey, worktreeIds] of memberships) {
    if (worktreeIds.size !== 1) continue;
    const worktreeId = worktreeIds.values().next().value;
    const worktree = worktrees.find((item) => item.worktreeId === worktreeId);
    if (worktree) colors.set(edgeKey, getWorktreeColor(worktree));
  }
  return colors;
}
