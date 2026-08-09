/**
 * 桌面宠物窗口入口。
 *
 * 通过 window.petBridge 与主进程通信：拉取配置、订阅 AI 活动状态与
 * OS 拖拽方向（左/右奔跑）。窗口移动由 CSS `-webkit-app-region: drag`
 * 交给操作系统处理。
 */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type {
  PetActivityState,
  PetWindowConfig,
} from "../preload/types/pets";
import type { PetSpriteState } from "./components/pet/petSprites";
import { PetStage } from "./components/pet/PetStage";
import "./pet.css";

function PetWindowApp(): React.JSX.Element | null {
  const [config, setConfig] = useState<PetWindowConfig | null>(null);
  const [activity, setActivity] = useState<PetActivityState>("idle");
  const [dragState, setDragState] = useState<PetSpriteState | null>(null);

  useEffect(() => {
    const bridge = window.petBridge;
    if (!bridge) {
      return;
    }

    bridge.getConfig().then((initial) => {
      if (initial) {
        setConfig(initial);
      }
    });

    const unsubscribeConfig = bridge.onConfigChanged(setConfig);
    const unsubscribeActivity = bridge.onActivityChanged(setActivity);
    const unsubscribeDrag = bridge.onDragStateChanged(setDragState);

    return () => {
      unsubscribeConfig();
      unsubscribeActivity();
      unsubscribeDrag();
    };
  }, []);

  if (!config || !config.manifest) {
    return null;
  }

  return (
    <div className="pet-window">
      <PetStage
        manifest={config.manifest}
        scale={config.settings.scale}
        activity={activity}
        dragState={dragState}
      />
    </div>
  );
}

const container = document.getElementById("pet-root");
if (container) {
  createRoot(container).render(<PetWindowApp />);
}
