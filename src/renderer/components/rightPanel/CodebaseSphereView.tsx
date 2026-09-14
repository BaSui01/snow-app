import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useI18n } from "../../i18n";
import { getFileTypeIcon } from "../../utils/fileIcons";
import { CustomSelect } from "../common/CustomSelect";
import type { CodebaseSphereLayout } from "../../../preload";

// 布局计算为 O(n²)，提供数量阈值选项让用户权衡完整度与等待时间。
const LIMIT_OPTIONS = [300, 500, 700] as const;
type NodeLimit = "all" | (typeof LIMIT_OPTIONS)[number];
// Rust 端 get_codebase_sphere_layout 的硬上限。
const MAX_API_LIMIT = 2000;

type SphereNode = {
  index: number;
  path: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  x: number;
  y: number;
  z: number;
  // 悬停高亮的最相似文件索引列表，由 Rust 端预计算。
  related: number[];
};

type TooltipData = {
  x: number;
  y: number;
  node: SphereNode;
  neighbors: { path: string; similarity: number }[];
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getBaseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

type CodebaseSphereViewProps = {
  projectId: string;
};

/**
 * 场景对外暴露的操作接口：搜索高亮、相机聚焦、按关键字查找节点。
 */
type SphereSceneApi = {
  highlight: (index: number | null) => void;
  focus: (index: number) => void;
  findIndex: (query: string) => number;
  dispose: () => void;
};

/**
 * 3D 相似度关系图：每个点代表一个已索引文件，点间距离由真实 embedding
 * 余弦相似度驱动（力导向布局），连线为最近邻相似关系。支持拖拽旋转，
 * 悬停散点查看文件信息并高亮其关系连线。
 */
export const CodebaseSphereView = ({
  projectId,
}: CodebaseSphereViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "error" | "empty" | "ready">(
    "loading",
  );
  const [nodeLimit, setNodeLimit] = useState<NodeLimit>("all");
  const [shownCount, setShownCount] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [query, setQuery] = useState("");
  const [hasMatch, setHasMatch] = useState(true);
  const sceneApiRef = useRef<SphereSceneApi | null>(null);
  const queryRef = useRef("");

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    setState("loading");

    void (async () => {
      try {
        // 先取索引统计确定总文件数，再决定拉取范围，保证与表格数量一致。
        const stats = await window.snow.getCodebaseIndexStats(projectId);
        if (disposed) {
          return;
        }
        const total = stats.totalFiles;
        setTotalFiles(total);
        // “全部”时尽量全量（受后端硬上限保护）；否则按用户选择截断。
        const limit =
          nodeLimit === "all"
            ? Math.max(1, Math.min(total, MAX_API_LIMIT))
            : Math.max(1, Math.min(total, nodeLimit));
        // 布局（相似度矩阵 + 力导向 + 连线）在 Rust 后台线程计算，
        // 渲染进程等待期间保持响应，不再阻塞整个应用。
        const layout = await window.snow.getCodebaseSphereLayout(
          projectId,
          limit,
        );
        if (disposed) {
          return;
        }
        if (layout.nodes.length === 0) {
          setState("empty");
          return;
        }
        setShownCount(layout.nodes.length);
        // 先让 loading 帧渲染，再同步构建场景（仅轻量几何创建）。
        requestAnimationFrame(() => {
          if (disposed) {
            return;
          }
          try {
            sceneApiRef.current = setupScene(layout);
            setState("ready");
            // 场景（重建）就绪后，重新应用搜索状态。
            const pendingQuery = queryRef.current.trim();
            if (pendingQuery) {
              const pendingIndex =
                sceneApiRef.current?.findIndex(pendingQuery) ?? -1;
              setHasMatch(pendingIndex >= 0);
              if (pendingIndex >= 0) {
                sceneApiRef.current?.highlight(pendingIndex);
                sceneApiRef.current?.focus(pendingIndex);
              }
            }
          } catch {
            setState("error");
          }
        });
      } catch {
        if (!disposed) {
          setState("error");
        }
      }
    })();

    function setupScene(layout: CodebaseSphereLayout): SphereSceneApi {
      // 重新获取 container 并在闭包内收窄类型，避免跨闭包 null 检查失效。
      const container = containerRef.current;
      if (!container) {
        throw new Error("Sphere container is not available");
      }
      const nodes: SphereNode[] = layout.nodes.map((node) => ({
        index: node.index,
        path: node.relativePath,
        chunkCount: node.chunkCount,
        startLine: node.startLine,
        endLine: node.endLine,
        sizeBytes: node.sizeBytes,
        x: node.x,
        y: node.y,
        z: node.z,
        related: node.related.map((item) => item.index),
      }));
      const edges = layout.edges;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        50,
        container.clientWidth / Math.max(1, container.clientHeight),
        0.1,
        100,
      );
      // 拉远相机，让球体默认尺寸约为原来的一半。
      camera.position.set(0, 0.5, 4.2);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(container.clientWidth, container.clientHeight);
      container.appendChild(renderer.domElement);

      // 手动拖拽旋转，不自转；target 固定为球心原点，保证拖拽始终中心旋转。
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0, 0);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.9;
      controls.enablePan = false;
      controls.minDistance = 2.2;
      controls.maxDistance = 8;

      // 相似度连线（最近邻边），低透明度打底。
      const linePositions: number[] = [];
      edges.forEach((edge) => {
        const na = nodes[edge.a];
        const nb = nodes[edge.b];
        linePositions.push(na.x, na.y, na.z, nb.x, nb.y, nb.z);
      });
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(linePositions, 3),
      );
      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(lines);

      // 悬停高亮连线（动态更新）。
      const hoverLineGeometry = new THREE.BufferGeometry();
      hoverLineGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([], 3),
      );
      const hoverLines = new THREE.LineSegments(
        hoverLineGeometry,
        new THREE.LineBasicMaterial({
          color: 0x93c5fd,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        }),
      );
      hoverLines.visible = false;
      scene.add(hoverLines);

      // 文件节点：视觉小球 + 不可见的较大命中球（保证悬停易命中）。
      const hitMeshes: THREE.Mesh[] = [];
      const meshToIndex = new Map<THREE.Mesh, number>();
      const nodeMeshes: THREE.Mesh[] = [];
      nodes.forEach((node) => {
        const visualSize =
          0.022 + Math.min(0.02, Math.log2(node.chunkCount + 1) * 0.005);
        const color = new THREE.Color().setHSL(
          0.55 + 0.09 * Math.min(1, node.chunkCount / 30),
          0.85,
          0.62,
        );
        const visual = new THREE.Mesh(
          new THREE.SphereGeometry(visualSize, 16, 12),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
          }),
        );
        visual.position.set(node.x, node.y, node.z);
        scene.add(visual);
        nodeMeshes.push(visual);

        const hit = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 8, 6),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        hit.position.set(node.x, node.y, node.z);
        scene.add(hit);
        hitMeshes.push(hit);
        meshToIndex.set(hit, node.index);
      });

      // 悬停检测。
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let hoveredIndex: number | null = null;
      let isDragging = false;
      // 搜索激活的节点索引：非 null 时悬停高亮被锁定，避免互相覆盖。
      let searchActiveIndex: number | null = null;
      let focusRafId = 0;

      const getNeighbors = (
        index: number,
      ): { path: string; similarity: number }[] =>
        edges
          .filter((edge) => edge.a === index || edge.b === index)
          .map((edge) => ({
            path: edge.a === index ? nodes[edge.b].path : nodes[edge.a].path,
            similarity: edge.similarity,
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 3);

      // 悬停时高亮悬停点本身 + 与其最相似的一批文件，其余节点变暗，
      // 形成“以一点为中心的关系聚焦”效果。关联列表由 Rust 端预计算。
      const applyHoverHighlight = (index: number | null): void => {
        const related = index !== null ? new Set(nodes[index].related) : null;

        nodeMeshes.forEach((mesh, i) => {
          const material = mesh.material as THREE.MeshBasicMaterial;
          const isHovered = i === index;
          const isRelated = related?.has(i) ?? false;
          if (isHovered) {
            mesh.scale.setScalar(2.4);
            material.color.set(0xdbeafe);
            material.opacity = 1;
          } else if (isRelated) {
            mesh.scale.setScalar(1.55);
            material.color.set(0x7dd3fc);
            material.opacity = 1;
          } else {
            mesh.scale.setScalar(0.8);
            material.color.set(0x64748b);
            material.opacity = 0.35;
          }
        });

        lineMaterial.opacity = index === null ? 0.16 : 0.05;

        if (index === null) {
          hoverLines.visible = false;
          return;
        }
        // 高亮悬停点到最相似文件的连线。
        const positions: number[] = [];
        edges.forEach((edge) => {
          if (edge.a !== index && edge.b !== index) {
            return;
          }
          const otherIndex = edge.a === index ? edge.b : edge.a;
          if (!related?.has(otherIndex)) {
            return;
          }
          const other = nodes[otherIndex];
          positions.push(
            nodes[index].x,
            nodes[index].y,
            nodes[index].z,
            other.x,
            other.y,
            other.z,
          );
        });
        if (positions.length > 0) {
          hoverLineGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(positions, 3),
          );
          hoverLineGeometry.computeBoundingSphere();
          hoverLines.visible = true;
        } else {
          hoverLines.visible = false;
        }
      };

      const onPointerDown = (): void => {
        isDragging = true;
      };

      const onPointerUp = (): void => {
        isDragging = false;
      };

      const onPointerMove = (event: PointerEvent): void => {
        if (isDragging || searchActiveIndex !== null) {
          return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(hitMeshes, false);
        if (hits.length > 0) {
          const index = meshToIndex.get(hits[0].object as THREE.Mesh) ?? null;
          if (index !== hoveredIndex) {
            hoveredIndex = index;
            applyHoverHighlight(index);
          }
          if (index !== null) {
            const node = nodes[index];
            const neighbors = getNeighbors(index);
            const tooltipX = Math.max(
              8,
              Math.min(event.clientX - rect.left + 14, rect.width - 296),
            );
            const tooltipY = Math.max(
              8,
              Math.min(event.clientY - rect.top + 14, rect.height - 220),
            );
            setTooltip({ x: tooltipX, y: tooltipY, node, neighbors });
          }
        } else {
          if (hoveredIndex !== null) {
            hoveredIndex = null;
            applyHoverHighlight(null);
          }
          setTooltip(null);
        }
      };

      const onPointerLeave = (): void => {
        hoveredIndex = null;
        applyHoverHighlight(null);
        setTooltip(null);
      };

      // 搜索高亮：锁定悬停，聚焦目标节点及其最相似文件群组。
      const searchHighlight = (index: number | null): void => {
        searchActiveIndex = index;
        applyHoverHighlight(index);
        if (index === null) {
          setTooltip(null);
          return;
        }
        const node = nodes[index];
        setTooltip({
          x: 12,
          y: 36,
          node,
          neighbors: getNeighbors(index),
        });
      };

      // 按关键字（不区分大小写）查找第一个匹配的文件路径。
      const findIndex = (q: string): number => {
        const lower = q.toLowerCase();
        return nodes.findIndex((node) =>
          node.path.toLowerCase().includes(lower),
        );
      };

      // 平滑聚焦到目标节点：仅把相机移动到“球心→节点”方向（保持当前
      // 距离），target 始终锁定球心原点，拖拽旋转中心不随聚焦漂移。
      const focus = (index: number): void => {
        cancelAnimationFrame(focusRafId);
        const node = nodes[index];
        const direction = new THREE.Vector3(node.x, node.y, node.z);
        if (direction.lengthSq() < 1e-8) {
          direction.set(0, 1, 0);
        } else {
          direction.normalize();
        }
        const distance = camera.position.distanceTo(controls.target);
        const startPos = camera.position.clone();
        const endPos = direction.multiplyScalar(distance);
        const duration = 450;
        const startTime = performance.now();
        const step = (): void => {
          const t = Math.min(1, (performance.now() - startTime) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          camera.position.lerpVectors(startPos, endPos, eased);
          camera.lookAt(controls.target);
          if (t < 1) {
            focusRafId = requestAnimationFrame(step);
          }
        };
        focusRafId = requestAnimationFrame(step);
      };

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);

      const onResize = (): void => {
        const width = container.clientWidth;
        const height = Math.max(1, container.clientHeight);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      };
      const resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(container);

      let rafId = 0;
      const animate = (): void => {
        controls.update();
        renderer.render(scene, camera);
        rafId = requestAnimationFrame(animate);
      };
      animate();

      return {
        highlight: searchHighlight,
        focus,
        findIndex,
        dispose: () => {
          cancelAnimationFrame(rafId);
          cancelAnimationFrame(focusRafId);
          resizeObserver.disconnect();
          renderer.domElement.removeEventListener("pointerdown", onPointerDown);
          renderer.domElement.removeEventListener("pointerup", onPointerUp);
          renderer.domElement.removeEventListener("pointermove", onPointerMove);
          renderer.domElement.removeEventListener(
            "pointerleave",
            onPointerLeave,
          );
          controls.dispose();
          scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (mesh.geometry) {
              mesh.geometry.dispose();
            }
            const material = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(material)) {
              material.forEach((m) => m.dispose());
            } else if (material) {
              material.dispose();
            }
          });
          renderer.dispose();
          if (renderer.domElement.parentNode === container) {
            container.removeChild(renderer.domElement);
          }
        },
      };
    }

    return () => {
      disposed = true;
      sceneApiRef.current?.dispose();
      sceneApiRef.current = null;
      setTooltip(null);
    };
  }, [projectId, nodeLimit]);

  // 搜索：命中则高亮目标文件及其最相似群组并聚焦，清空则恢复。
  useEffect(() => {
    const api = sceneApiRef.current;
    const q = query.trim();
    if (!q) {
      setHasMatch(true);
      api?.highlight(null);
      return;
    }
    const index = api?.findIndex(q) ?? -1;
    setHasMatch(index >= 0);
    if (index >= 0) {
      api?.highlight(index);
      api?.focus(index);
    } else {
      api?.highlight(null);
    }
  }, [query]);

  return (
    <div className="codebase-sphere" ref={containerRef}>
      {state === "loading" && (
        <div className="codebase-panel-state">
          <Loader2 size={18} strokeWidth={1.8} className="spin" />
          <span>{t("codebase.panel.sphereLoading")}</span>
        </div>
      )}
      {state === "error" && (
        <div className="codebase-panel-state codebase-panel-error">
          {t("codebase.panel.sphereError")}
        </div>
      )}
      {state === "empty" && (
        <div className="codebase-panel-state">
          {t("codebase.panel.sphereEmpty")}
        </div>
      )}
      {state === "ready" && (
        <div className="codebase-sphere-hint">
          <span className="codebase-sphere-hint-info">
            {totalFiles > shownCount
              ? t("codebase.panel.sphereNodesLimited", {
                  values: { count: shownCount, total: totalFiles },
                })
              : t("codebase.panel.sphereNodes", {
                  values: { count: shownCount },
                })}
            <span className="codebase-sphere-hint-dot" />
            {t("codebase.panel.sphereHint")}
          </span>
          <input
            type="search"
            className="codebase-sphere-search-input"
            placeholder={t("codebase.panel.sphereSearchPlaceholder")}
            aria-label={t("codebase.panel.sphereSearchPlaceholder")}
            value={query}
            onChange={(event) => {
              queryRef.current = event.target.value;
              setQuery(event.target.value);
            }}
          />
          {query.trim() !== "" && !hasMatch && (
            <span className="codebase-sphere-search-nomatch">
              {t("codebase.panel.sphereSearchNoMatch")}
            </span>
          )}
          <CustomSelect
            onChange={(value) => setNodeLimit(value as NodeLimit)}
            options={[
              {
                value: "all",
                label: t("codebase.panel.sphereLimitAll"),
              },
              ...LIMIT_OPTIONS.map((value) => ({
                value: String(value),
                label: String(value),
              })),
            ]}
            title={t("codebase.panel.sphereLimitTitle")}
            value={String(nodeLimit)}
          />
        </div>
      )}
      {state === "ready" && tooltip && (
        <div
          className="codebase-sphere-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div
            className="codebase-sphere-tooltip-path"
            title={tooltip.node.path}
          >
            <span className="codebase-sphere-tooltip-file-icon">
              {getFileTypeIcon(getBaseName(tooltip.node.path), false, false, {
                size: 12,
              })}
            </span>
            <span className="codebase-sphere-tooltip-path-name">
              {tooltip.node.path}
            </span>
          </div>
          <div className="codebase-sphere-tooltip-row">
            <span>{t("codebase.panel.colChunks")}</span>
            <span>{tooltip.node.chunkCount}</span>
          </div>
          <div className="codebase-sphere-tooltip-row">
            <span>{t("codebase.panel.colLines")}</span>
            <span>
              {tooltip.node.startLine > 0 && tooltip.node.endLine > 0
                ? `${tooltip.node.startLine} - ${tooltip.node.endLine}`
                : "-"}
            </span>
          </div>
          <div className="codebase-sphere-tooltip-row">
            <span>{t("codebase.panel.colSize")}</span>
            <span>{formatBytes(tooltip.node.sizeBytes)}</span>
          </div>
          {tooltip.neighbors.length > 0 && (
            <div className="codebase-sphere-tooltip-neighbors">
              <div className="codebase-sphere-tooltip-neighbors-title">
                {t("codebase.panel.sphereNeighbors")}
              </div>
              {tooltip.neighbors.map((neighbor) => (
                <div
                  key={neighbor.path}
                  className="codebase-sphere-tooltip-neighbor"
                  title={neighbor.path}
                >
                  <span className="codebase-sphere-tooltip-file-icon">
                    {getFileTypeIcon(getBaseName(neighbor.path), false, false, {
                      size: 12,
                    })}
                  </span>
                  <span className="codebase-sphere-tooltip-neighbor-name">
                    {neighbor.path}
                  </span>
                  <span>{Math.round(neighbor.similarity * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
