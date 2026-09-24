import { scheduledTasksStore } from "../../../hooks/scheduledTasksStore";
import {
  bumpRevision,
  callSnow,
  dispatchAppEvent,
  l10n,
  optionalBoolean,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requireRecord,
  requireString,
  requireStringArray,
} from "../helpers";
import type { PluginWriteActionDefinition } from "../types";

const APP_CONTROL_MEMO_CREATED_EVENT = "app-control:memo-created";
const APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT =
  "app-control:scheduled-task-created";

const MEMORY_KINDS = new Set([
  "fact",
  "decision",
  "preference",
  "pitfall",
  "task_state",
]);

const MEMORY_STATUSES = new Set(["active", "pending", "archived"]);

const CONVERSATION_STATUSES = new Set([
  "active",
  "archived",
  "completed",
  "error",
]);

const MEMO_STATUSES = new Set(["pending", "done"]);

const buildSchedule = (params: Record<string, unknown>): unknown => {
  const schedule = params.schedule;
  if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
    return schedule;
  }
  throw new Error("Parameter 'schedule' must be a schedule object");
};

export const CONTENT_WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  {
    domain: "memos",
    action: "create",
    scope: "memos",
    summary: l10n("Create a memo", "新建备忘录", "新增備忘錄"),
    invoke: async ({ params }) => {
      const directoryId = requireString(params, "directoryId");
      const content = requireString(params, "content");
      const memo = await callSnow("createMemo", directoryId, content);
      dispatchAppEvent(APP_CONTROL_MEMO_CREATED_EVENT);
      return memo;
    },
  },
  {
    domain: "memos",
    action: "updateContent",
    scope: "memos",
    summary: l10n("Update a memo text", "修改备忘录内容", "修改備忘錄內容"),
    invoke: async ({ params }) => {
      const memoId = requireString(params, "memoId");
      const content = requireString(params, "content");
      return await callSnow("updateMemoContent", memoId, content);
    },
  },
  {
    domain: "memos",
    action: "updateStatus",
    scope: "memos",
    summary: l10n(
      "Mark a memo done or pending",
      "标记备忘录完成或待办",
      "標記備忘錄完成或待辦",
    ),
    invoke: async ({ params }) => {
      const memoId = requireString(params, "memoId");
      const status = requireString(params, "status");
      if (!MEMO_STATUSES.has(status)) {
        throw new Error("Parameter 'status' must be 'pending' or 'done'");
      }
      return await callSnow("updateMemoStatus", memoId, status);
    },
  },
  {
    domain: "memos",
    action: "remove",
    scope: "memos",
    summary: l10n("Delete a memo", "删除备忘录", "刪除備忘錄"),
    invoke: async ({ params }) => {
      const memoId = requireString(params, "memoId");
      await callSnow("deleteMemo", memoId);
      return { memoId };
    },
  },

  {
    domain: "memory",
    action: "create",
    scope: "memory",
    summary: l10n("Save a project memory", "写入项目记忆", "寫入專案記憶"),
    invoke: async ({ params }) => {
      const directoryId = requireString(params, "directoryId");
      const kind = requireString(params, "kind");
      if (!MEMORY_KINDS.has(kind)) {
        throw new Error(
          "Parameter 'kind' must be one of fact, decision, preference, pitfall, task_state",
        );
      }
      const title = requireString(params, "title");
      const content = requireString(params, "content");
      const importance = optionalNumber(params, "importance");
      const tags = optionalStringArray(params, "tags");
      const record = await callSnow(
        "createProjectMemory",
        directoryId,
        kind,
        title,
        content,
        importance,
        tags,
      );
      bumpRevision("memoriesRevision");
      return record;
    },
  },
  {
    domain: "memory",
    action: "update",
    scope: "memory",
    summary: l10n("Update a project memory", "更新项目记忆", "更新專案記憶"),
    invoke: async ({ params }) => {
      const memoryId = requireString(params, "memoryId");
      const kind = optionalString(params, "kind");
      if (kind && !MEMORY_KINDS.has(kind)) {
        throw new Error(
          "Parameter 'kind' must be one of fact, decision, preference, pitfall, task_state",
        );
      }
      const status = optionalString(params, "status");
      if (status && !MEMORY_STATUSES.has(status)) {
        throw new Error(
          "Parameter 'status' must be one of active, pending, archived",
        );
      }
      const record = await callSnow("updateProjectMemory", memoryId, {
        kind,
        title: optionalString(params, "title"),
        content: optionalString(params, "content"),
        importance: optionalNumber(params, "importance"),
        status,
        tags: optionalStringArray(params, "tags"),
      });
      bumpRevision("memoriesRevision");
      return record;
    },
  },
  {
    domain: "memory",
    action: "remove",
    scope: "memory",
    summary: l10n("Delete a project memory", "删除项目记忆", "刪除專案記憶"),
    invoke: async ({ params }) => {
      const memoryId = requireString(params, "memoryId");
      const deleted = await callSnow<boolean>("deleteProjectMemory", memoryId);
      bumpRevision("memoriesRevision");
      return { memoryId, deleted };
    },
  },

  {
    domain: "scheduledTasks",
    action: "create",
    scope: "scheduledTasks",
    summary: l10n("Create a scheduled task", "新建定时任务", "新增定時任務"),
    invoke: async ({ params }) => {
      const input = {
        id: optionalString(params, "id"),
        directoryId: optionalString(params, "directoryId") ?? "",
        name: requireString(params, "name"),
        prompt: requireString(params, "prompt"),
        schedule: buildSchedule(params),
        preScript: optionalString(params, "preScript"),
        preScriptTimeoutMs: optionalNumber(params, "preScriptTimeoutMs"),
        runOnScriptError: optionalBoolean(params, "runOnScriptError"),
        apiProfile: optionalString(params, "apiProfile"),
        basicModel: optionalString(params, "basicModel"),
        model: optionalString(params, "model"),
        thinkingStrength: optionalString(params, "thinkingStrength"),
      };
      const created = await scheduledTasksStore.createAndAwait(
        input as Parameters<typeof scheduledTasksStore.createAndAwait>[0],
      );
      bumpRevision("scheduledTasksRevision");
      dispatchAppEvent(APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT, {
        taskId: created.id,
        name: created.name,
      });
      return created;
    },
  },
  {
    domain: "scheduledTasks",
    action: "update",
    scope: "scheduledTasks",
    summary: l10n(
      "Update a scheduled task run config",
      "更新定时任务运行配置",
      "更新定時任務執行設定",
    ),
    invoke: async ({ params }) => {
      const taskId = requireString(params, "taskId");
      await scheduledTasksStore.ensureHydrated();
      const updated = scheduledTasksStore.update(taskId, {
        apiProfile: optionalString(params, "apiProfile"),
        basicModel: optionalString(params, "basicModel"),
        model: optionalString(params, "model"),
        thinkingStrength: optionalString(params, "thinkingStrength"),
        preScript: optionalString(params, "preScript"),
        preScriptTimeoutMs: optionalNumber(params, "preScriptTimeoutMs"),
        runOnScriptError: optionalBoolean(params, "runOnScriptError"),
      } as Parameters<typeof scheduledTasksStore.update>[1]);
      if (!updated) {
        throw new Error(`Scheduled task not found: ${taskId}`);
      }
      bumpRevision("scheduledTasksRevision");
      return updated;
    },
  },
  {
    domain: "scheduledTasks",
    action: "setPaused",
    scope: "scheduledTasks",
    summary: l10n(
      "Pause or resume a task",
      "暂停或恢复定时任务",
      "暫停或恢復定時任務",
    ),
    invoke: async ({ params }) => {
      const taskId = requireString(params, "taskId");
      const paused = optionalBoolean(params, "paused");
      await scheduledTasksStore.ensureHydrated();
      const task = scheduledTasksStore
        .list()
        .find((item) => item.id === taskId);
      if (!task) {
        throw new Error(`Scheduled task not found: ${taskId}`);
      }
      const target = paused ?? !task.paused;
      const updated =
        task.paused === target ? task : scheduledTasksStore.togglePause(taskId);
      bumpRevision("scheduledTasksRevision");
      return updated;
    },
  },
  {
    domain: "scheduledTasks",
    action: "runNow",
    scope: "scheduledTasks",
    summary: l10n(
      "Run a task immediately",
      "立即运行定时任务",
      "立即執行定時任務",
    ),
    invoke: async ({ params }) => {
      const taskId = requireString(params, "taskId");
      await scheduledTasksStore.ensureHydrated();
      await scheduledTasksStore.runNow(taskId);
      return { taskId };
    },
  },
  {
    domain: "scheduledTasks",
    action: "remove",
    scope: "scheduledTasks",
    summary: l10n("Delete a scheduled task", "删除定时任务", "刪除定時任務"),
    invoke: async ({ params }) => {
      const taskId = requireString(params, "taskId");
      await scheduledTasksStore.ensureHydrated();
      scheduledTasksStore.remove(taskId);
      bumpRevision("scheduledTasksRevision");
      return { taskId };
    },
  },

  {
    domain: "imageLibrary",
    action: "createAlbum",
    scope: null,
    summary: l10n("Create an album", "新建图库相册", "新增圖庫相簿"),
    invoke: async ({ params }) =>
      await callSnow("createImageAlbum", requireString(params, "name")),
  },
  {
    domain: "imageLibrary",
    action: "renameAlbum",
    scope: null,
    summary: l10n("Rename an album", "重命名图库相册", "重新命名圖庫相簿"),
    invoke: async ({ params }) =>
      await callSnow(
        "renameImageAlbum",
        requireString(params, "albumId"),
        requireString(params, "name"),
      ),
  },
  {
    domain: "imageLibrary",
    action: "removeAlbum",
    scope: null,
    summary: l10n("Delete an album", "删除图库相册", "刪除圖庫相簿"),
    invoke: async ({ params }) => {
      const albumId = requireString(params, "albumId");
      await callSnow("deleteImageAlbum", albumId);
      return { albumId };
    },
  },
  {
    domain: "imageLibrary",
    action: "reorderAlbums",
    scope: null,
    summary: l10n("Reorder albums", "调整相册顺序", "調整相簿順序"),
    invoke: async ({ params }) => {
      const orderedIds = requireStringArray(params, "orderedIds");
      await callSnow("reorderImageAlbums", orderedIds);
      return { orderedIds };
    },
  },
  {
    domain: "imageLibrary",
    action: "assignImage",
    scope: null,
    summary: l10n(
      "Move an image into an album",
      "把图片归入相册",
      "把圖片歸入相簿",
    ),
    invoke: async ({ params }) => {
      const imageId = requireString(params, "imageId");
      const albumId = optionalString(params, "albumId") ?? null;
      await callSnow("setImageAlbum", imageId, albumId);
      return { imageId, albumId };
    },
  },
  {
    domain: "imageLibrary",
    action: "setAlbumCover",
    scope: null,
    summary: l10n("Set an album cover", "设置相册封面", "設定相簿封面"),
    invoke: async ({ params }) =>
      await callSnow(
        "setImageAlbumCover",
        requireString(params, "albumId"),
        optionalString(params, "imageId") ?? null,
      ),
  },
  {
    domain: "imageLibrary",
    action: "importImages",
    scope: null,
    summary: l10n(
      "Import image files into the library",
      "导入图片文件到图库",
      "匯入圖片檔案到圖庫",
    ),
    invoke: async ({ params }) =>
      await callSnow(
        "importImageFiles",
        requireStringArray(params, "filePaths"),
      ),
  },
  {
    domain: "imageLibrary",
    action: "removeImage",
    scope: null,
    summary: l10n("Delete a library image", "删除图库图片", "刪除圖庫圖片"),
    invoke: async ({ params }) => {
      const imageId = requireString(params, "imageId");
      await callSnow("deleteImageLibraryImage", imageId);
      return { imageId };
    },
  },

  {
    domain: "conversations",
    action: "rename",
    scope: "conversations",
    summary: l10n("Rename a conversation", "重命名会话", "重新命名工作階段"),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const title = requireString(params, "title");
      await callSnow("renameConversation", conversationId, title);
      bumpRevision("conversationListRevision");
      return { conversationId, title };
    },
  },
  {
    domain: "conversations",
    action: "setEmoji",
    scope: "conversations",
    summary: l10n(
      "Set a conversation emoji",
      "设置会话 Emoji",
      "設定工作階段 Emoji",
    ),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const emoji = requireString(params, "emoji");
      await callSnow("updateConversationEmoji", conversationId, emoji);
      bumpRevision("conversationListRevision");
      return { conversationId, emoji };
    },
  },
  {
    domain: "conversations",
    action: "setStatus",
    scope: "conversations",
    summary: l10n(
      "Update a conversation status",
      "更新会话状态",
      "更新工作階段狀態",
    ),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const status = requireString(params, "status");
      if (!CONVERSATION_STATUSES.has(status)) {
        throw new Error(
          "Parameter 'status' must be one of active, archived, completed, error",
        );
      }
      await callSnow("updateConversationStatus", conversationId, status);
      bumpRevision("conversationListRevision");
      return { conversationId, status };
    },
  },
  {
    domain: "conversations",
    action: "archive",
    scope: "conversations",
    summary: l10n("Archive conversations", "归档会话", "封存工作階段"),
    invoke: async ({ params }) => {
      const conversationIds = requireStringArray(params, "conversationIds");
      await callSnow("archiveConversations", conversationIds);
      bumpRevision("conversationListRevision");
      return { conversationIds };
    },
  },
  {
    domain: "conversations",
    action: "restore",
    scope: "conversations",
    summary: l10n(
      "Restore archived conversations",
      "恢复已归档会话",
      "還原已封存工作階段",
    ),
    invoke: async ({ params }) => {
      const conversationIds = requireStringArray(params, "conversationIds");
      await callSnow("restoreArchivedConversations", conversationIds);
      bumpRevision("conversationListRevision");
      return { conversationIds };
    },
  },
  {
    domain: "conversations",
    action: "remove",
    scope: "conversations",
    summary: l10n("Delete a conversation", "删除会话", "刪除工作階段"),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const deleteMemories = optionalBoolean(params, "deleteMemories");
      await callSnow("deleteConversation", conversationId, deleteMemories);
      bumpRevision("conversationListRevision");
      return { conversationId };
    },
  },

  {
    domain: "projects",
    action: "create",
    scope: null,
    summary: l10n("Create a project folder", "新建项目目录", "新增專案目錄"),
    invoke: async ({ params }) => {
      const parentPath = requireString(params, "parentPath");
      const name = requireString(params, "name");
      const directories = await callSnow<
        Array<{ directoryId: string; name: string; path: string }>
      >("createWorkspaceProject", parentPath, name);
      bumpRevision("workspaceRevision");
      return directories;
    },
  },
  {
    domain: "projects",
    action: "addDirectory",
    scope: null,
    summary: l10n(
      "Add an existing folder as a project",
      "把已有目录添加为项目",
      "把既有目錄新增為專案",
    ),
    invoke: async ({ params }) => {
      const directory = requireRecord(params, "directory");
      const directories = await callSnow("upsertWorkspaceDirectory", directory);
      bumpRevision("workspaceRevision");
      return directories;
    },
  },
  {
    domain: "projects",
    action: "activate",
    scope: null,
    summary: l10n("Activate a project", "激活项目", "啟用專案"),
    invoke: async ({ params }) => {
      const directoryId = requireString(params, "directoryId");
      const directories = await callSnow(
        "activateWorkspaceDirectory",
        directoryId,
      );
      bumpRevision("workspaceRevision");
      return directories;
    },
  },
  {
    domain: "projects",
    action: "reorder",
    scope: null,
    summary: l10n("Reorder projects", "调整项目顺序", "調整專案順序"),
    invoke: async ({ params }) => {
      const items = params.items;
      if (!Array.isArray(items)) {
        throw new Error("Parameter 'items' must be an array");
      }
      const directories = await callSnow("reorderWorkspaceDirectories", items);
      bumpRevision("workspaceRevision");
      return directories;
    },
  },
  {
    domain: "projects",
    action: "relink",
    scope: null,
    summary: l10n(
      "Relink a moved project path",
      "重定项目的新位置",
      "重新定位專案的新位置",
    ),
    invoke: async ({ params }) => {
      const oldDirectoryId = requireString(params, "directoryId");
      const newPath = requireString(params, "newPath");
      const dryRun = optionalBoolean(params, "dryRun") ?? false;
      const result = await callSnow(
        "relinkWorkspaceDirectory",
        oldDirectoryId,
        newPath,
        dryRun,
      );
      if (!dryRun) {
        bumpRevision("workspaceRevision");
      }
      return result;
    },
  },
  {
    domain: "projects",
    action: "undoRelink",
    scope: null,
    summary: l10n(
      "Undo a project relink",
      "撤销项目位置迁移",
      "復原專案位置遷移",
    ),
    invoke: async ({ params }) => {
      const relinkId = requireString(params, "relinkId");
      const result = await callSnow("undoWorkspaceDirectoryRelink", relinkId);
      bumpRevision("workspaceRevision");
      return result;
    },
  },

  {
    domain: "collections",
    action: "create",
    scope: null,
    summary: l10n("Create a project group", "新建项目合集", "新增專案合集"),
    invoke: async ({ params }) => {
      const collections = await callSnow(
        "createProjectCollection",
        requireString(params, "name"),
      );
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
  {
    domain: "collections",
    action: "rename",
    scope: null,
    summary: l10n(
      "Rename a project group",
      "重命名项目合集",
      "重新命名專案合集",
    ),
    invoke: async ({ params }) => {
      const collections = await callSnow(
        "renameProjectCollection",
        requireString(params, "collectionId"),
        requireString(params, "name"),
      );
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
  {
    domain: "collections",
    action: "remove",
    scope: null,
    summary: l10n("Delete a project group", "删除项目合集", "刪除專案合集"),
    invoke: async ({ params }) => {
      const collectionId = requireString(params, "collectionId");
      const collections = await callSnow(
        "deleteProjectCollection",
        collectionId,
      );
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
  {
    domain: "collections",
    action: "moveMember",
    scope: null,
    summary: l10n(
      "Move a project into a group",
      "把项目移入合集",
      "把專案移入合集",
    ),
    invoke: async ({ params }) => {
      const collectionId = requireString(params, "collectionId");
      const directoryId = requireString(params, "directoryId");
      const orderedMemberIds =
        optionalStringArray(params, "orderedMemberIds") ?? [];
      const collections = await callSnow(
        "moveProjectToCollection",
        collectionId,
        directoryId,
        orderedMemberIds,
      );
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
  {
    domain: "collections",
    action: "removeMember",
    scope: null,
    summary: l10n(
      "Remove a project from a group",
      "把项目移出合集",
      "把專案移出合集",
    ),
    invoke: async ({ params }) => {
      const collectionId = optionalString(params, "collectionId");
      const directoryId = requireString(params, "directoryId");
      const collections = collectionId
        ? await callSnow(
            "removeProjectFromCollection",
            collectionId,
            directoryId,
          )
        : await callSnow("removeProjectFromAllCollections", directoryId);
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
  {
    domain: "collections",
    action: "reorderMembers",
    scope: null,
    summary: l10n(
      "Reorder projects inside a group",
      "调整合集内项目顺序",
      "調整合集內專案順序",
    ),
    invoke: async ({ params }) => {
      const collectionId = requireString(params, "collectionId");
      const orderedMemberIds = requireStringArray(params, "orderedMemberIds");
      const collections = await callSnow(
        "reorderProjectCollectionMembers",
        collectionId,
        orderedMemberIds,
      );
      bumpRevision("workspaceRevision");
      return collections;
    },
  },
];
