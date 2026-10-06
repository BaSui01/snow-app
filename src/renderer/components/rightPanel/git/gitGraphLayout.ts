import type { GitLogEntry } from "../../../../preload";

export interface GraphRow {
  commit: GitLogEntry;
  dotLane: number;
  topLines: number[];
  topColors: string[];
  bottomLines: number[];
  bottomColors: string[];
  curves: { from: number; to: number; color: string }[];
  merges: { from: number; color: string }[];
}

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 28;
export const DOT_RADIUS = 4;
export const LINE_WIDTH = 2;

export const LANE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
];

export function computeGraph(
  commits: GitLogEntry[],
  worktreeEdgeColors: Map<string, string>,
): {
  rows: GraphRow[];
  maxLanes: number;
} {
  const hashToLane = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const laneColors: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const commitByHash = new Map(commits.map((c) => [c.hash, c]));
  const mainline = new Set<string>();
  for (
    let cur: GitLogEntry | undefined = commits[0];
    cur;
    cur = cur.parents[0] ? commitByHash.get(cur.parents[0]) : undefined
  ) {
    mainline.add(cur.hash);
  }

  for (const commit of commits) {
    let dotLane: number;
    if (hashToLane.has(commit.hash)) {
      dotLane = hashToLane.get(commit.hash)!;
      hashToLane.delete(commit.hash);
    } else {
      const freeLane = lanes.indexOf(null);
      dotLane = freeLane !== -1 ? freeLane : lanes.length;
      if (dotLane >= lanes.length) {
        lanes.push(null);
        laneColors.push(null);
      }
    }

    // 其他车道上同样指向本提交的线条：本行的顶部竖线由大半径弯弧取代，
    // 弧线在整行高度内平滑汇入圆点。
    const merges: { from: number; color: string }[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== dotLane && lanes[i] === commit.hash) {
        merges.push({
          from: i,
          color: laneColors[i] ?? LANE_COLORS[i % LANE_COLORS.length],
        });
      }
    }
    const mergeLanes = new Set(merges.map((merge) => merge.from));

    const topLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && !mergeLanes.has(i)) topLines.push(i);
    }
    const topColors = laneColors.map(
      (color, lane) => color ?? LANE_COLORS[lane % LANE_COLORS.length],
    );

    // 本提交所在线条的颜色：继续向前延伸的第一父边沿用它，让一条分支从
    // 分叉点到汇合点保持同色。
    const lineColor = topColors[dotLane];

    lanes[dotLane] = null;
    laneColors[dotLane] = null;
    for (const lane of mergeLanes) {
      lanes[lane] = null;
      laneColors[lane] = null;
    }
    const curves: { from: number; to: number; color: string }[] = [];

    for (let p = 0; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      const isFirstParent = p === 0;
      const worktreeColor = worktreeEdgeColors.get(
        `${commit.hash}\0${parentHash}`,
      );

      // 同名父提交（重复 parents）只处理一次，避免凭空多出一条重复线。
      if (commit.parents.indexOf(parentHash) < p) {
        continue;
      }

      if (hashToLane.has(parentHash)) {
        const parentLane = hashToLane.get(parentHash)!;
        if (isFirstParent) {
          // 第一父提交已停在别的车道上：本线沿用当前车道继续指向它，到
          // 父提交所在行再弯入圆点；主线提交让父提交的圆点回到主线车道。
          lanes[dotLane] = parentHash;
          laneColors[dotLane] = worktreeColor ?? lineColor;
          if (mainline.has(commit.hash)) {
            hashToLane.set(parentHash, dotLane);
          }
          continue;
        }
        // 第二父提交已停在别的车道上：不复用它的车道。直接并进去会让这条
        // 合并边在子提交行就塌陷到对方线上，合并边自己的一列随之消失；
        // 改为另开一条独立线一路下行，到父提交所在行再由 merges 弧弯入圆点。
        const freeLane = lanes.indexOf(null);
        const edgeLane = freeLane !== -1 ? freeLane : lanes.length;
        if (edgeLane >= lanes.length) {
          lanes.push(null);
          laneColors.push(null);
        }
        const edgeColor =
          worktreeColor ?? LANE_COLORS[edgeLane % LANE_COLORS.length];
        lanes[edgeLane] = parentHash;
        laneColors[edgeLane] = edgeColor;
        if (edgeLane !== dotLane) {
          curves.push({ from: dotLane, to: edgeLane, color: edgeColor });
        }
        continue;
      }

      let parentLane: number;
      if (isFirstParent) {
        parentLane = dotLane;
      } else {
        const freeLane = lanes.indexOf(null);
        parentLane = freeLane !== -1 ? freeLane : lanes.length;
        if (parentLane >= lanes.length) {
          lanes.push(null);
          laneColors.push(null);
        }
      }
      hashToLane.set(parentHash, parentLane);
      const edgeColor =
        worktreeColor ?? LANE_COLORS[parentLane % LANE_COLORS.length];
      lanes[parentLane] = parentHash;
      laneColors[parentLane] = edgeColor;
      if (parentLane !== dotLane) {
        curves.push({ from: dotLane, to: parentLane, color: edgeColor });
      }
    }

    const bottomLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) bottomLines.push(i);
    }
    const bottomColors = laneColors.map(
      (color, lane) => color ?? LANE_COLORS[lane % LANE_COLORS.length],
    );

    rows.push({
      commit,
      dotLane,
      topLines,
      topColors,
      bottomLines,
      bottomColors,
      curves,
      merges,
    });
  }

  return { rows, maxLanes: lanes.length };
}
